/**
 * MCP 2026-07-28 Client Elicitation (`specification/2026-07-28/client/elicitation.md`).
 *
 * Implements both `form` mode (flat primitive schemas: string, number/integer, boolean,
 * single-select enum, multi-select enum, defaults, validation, and user review/modify before
 * submission) and `url` mode (zero pre-fetch, HTTPS/loopback check, highlighted domain, Punycode
 * warning, explicit consent, and external browser launch).
 */

import { spawn } from "node:child_process";
import type { JsonObject } from "./types.ts";

export interface ElicitationUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface ElicitationResponse {
  action: "accept" | "decline" | "cancel";
  content?: JsonObject;
}

const ANSI_RE = /\x1b(?:\[[0-9;]*[A-Za-z]|_.*?\x07|\].*?(?:\x07|\x1b\\))/g;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Strip terminal escapes and neutralize inline URLs in form-mode text (`elicitation.md` §Safe URL Handling #3/#7). */
export function sanitizeFormText(raw: string): string {
  return raw
    .replace(ANSI_RE, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
    .replace(/\b(https?|ftp|file|javascript):\/\//gi, (_m, scheme: string) => `${scheme}[:]//`);
}

function stripControlChars(raw: string): string {
  return raw.replace(ANSI_RE, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

export function openExternalBrowser(url: string): Promise<boolean> {
  const checked = inspectElicitationUrl(url);
  if (!checked.valid || !checked.href) {
    throw new Error(checked.error ?? "Refused to launch unsafe elicitation URL");
  }
  const safeUrl = checked.href;
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32.exe"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", safeUrl] : [safeUrl];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      shell: false,
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.once("spawn", () => resolve(true));
    child.on("error", () => resolve(false));
    child.unref();
  });
}

export function inspectElicitationUrl(rawUrl: unknown): {
  valid: boolean;
  href?: string;
  host?: string;
  warnings: string[];
  error?: string;
} {
  if (
    typeof rawUrl !== "string" ||
    /[\x00-\x20\x7f]/.test(rawUrl) ||
    !URL.canParse(rawUrl)
  ) {
    return { valid: false, warnings: [], error: "Invalid elicitation URL" };
  }
  const parsed = new URL(rawUrl);
  const isHttps = parsed.protocol === "https:";
  const isLoopbackHttp = parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  if (!isHttps && !isLoopbackHttp) {
    return {
      valid: false,
      warnings: [],
      error: `Blocked unsafe elicitation URL scheme "${parsed.protocol}" (requires https: or loopback http:)`,
    };
  }
  const warnings: string[] = [];
  if (parsed.hostname.split(".").some((label) => label.toLowerCase().startsWith("xn--"))) {
    warnings.push(`WARNING: Ambiguous/Punycode domain detected (${parsed.hostname}) — verify carefully against spoofing.`);
  }
  if (!isHttps) {
    warnings.push(`Note: Non-HTTPS loopback URL (${parsed.origin}).`);
  }
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      warnings: [],
      error: "Blocked elicitation URL containing embedded credentials",
    };
  }
  return {
    valid: true,
    href: parsed.href,
    host: parsed.host,
    warnings,
  };
}

interface EnumOption {
  value: string;
  title: string;
}

function extractSingleEnumOptions(prop: Record<string, unknown>): EnumOption[] | undefined {
  if (Array.isArray(prop.enum) && prop.enum.every((v) => typeof v === "string")) {
    return (prop.enum as string[]).map((value) => ({ value, title: value }));
  }
  if (Array.isArray(prop.oneOf)) {
    const out: EnumOption[] = [];
    for (const item of prop.oneOf) {
      if (!isRecord(item) || typeof item.const !== "string") return undefined;
      out.push({
        value: item.const,
        title: typeof item.title === "string" && item.title ? item.title : item.const,
      });
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

function extractMultiEnumOptions(prop: Record<string, unknown>): EnumOption[] | undefined {
  if (prop.type !== "array" || !isRecord(prop.items)) return undefined;
  const items = prop.items;
  if (Array.isArray(items.enum) && items.enum.every((v) => typeof v === "string")) {
    return (items.enum as string[]).map((value) => ({ value, title: value }));
  }
  const union = Array.isArray(items.anyOf) ? items.anyOf : Array.isArray(items.oneOf) ? items.oneOf : undefined;
  if (union) {
    const out: EnumOption[] = [];
    for (const item of union) {
      if (!isRecord(item) || typeof item.const !== "string") return undefined;
      out.push({
        value: item.const,
        title: typeof item.title === "string" && item.title ? item.title : item.const,
      });
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

export function validateFieldValue(prop: Record<string, unknown>, value: unknown): string | undefined {
  const singleEnum = extractSingleEnumOptions(prop);
  if (singleEnum) {
    if (typeof value !== "string" || !singleEnum.some((opt) => opt.value === value)) {
      return `Must be one of: ${singleEnum.map((o) => o.value).join(", ")}`;
    }
    return undefined;
  }

  const multiEnum = extractMultiEnumOptions(prop);
  if (multiEnum) {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && multiEnum.some((o) => o.value === v))) {
      return "Invalid selection";
    }
    if (typeof prop.minItems === "number" && value.length < prop.minItems) {
      return `Select at least ${prop.minItems} item(s)`;
    }
    if (typeof prop.maxItems === "number" && value.length > prop.maxItems) {
      return `Select at most ${prop.maxItems} item(s)`;
    }
    return undefined;
  }

  switch (prop.type) {
    case "string": {
      if (typeof value !== "string") return "Must be a string";
      if (typeof prop.minLength === "number" && value.length < prop.minLength) {
        return `Minimum length is ${prop.minLength}`;
      }
      if (typeof prop.maxLength === "number" && value.length > prop.maxLength) {
        return `Maximum length is ${prop.maxLength}`;
      }
      if (prop.format === "email" && !EMAIL_RE.test(value)) {
        return "Must be a valid email address";
      }
      if (prop.format === "uri" && !URL.canParse(value)) {
        return "Must be a valid URI";
      }
      if (prop.format === "date" && (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) {
        return "Must be a valid YYYY-MM-DD date";
      }
      if (prop.format === "date-time" && Number.isNaN(Date.parse(value))) {
        return "Must be a valid ISO 8601 date-time";
      }
      return undefined;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "Must be a finite number";
      if (prop.type === "integer" && !Number.isInteger(value)) return "Must be an integer";
      if (typeof prop.minimum === "number" && value < prop.minimum) return `Minimum is ${prop.minimum}`;
      if (typeof prop.maximum === "number" && value > prop.maximum) return `Maximum is ${prop.maximum}`;
      return undefined;
    }
    case "boolean": {
      if (typeof value !== "boolean") return "Must be true or false";
      return undefined;
    }
    default:
      return `Unsupported form property schema type "${String(prop.type)}"`;
  }
}

export function validateElicitationContent(
  requestedSchema: JsonObject,
  content: JsonObject,
): string | undefined {
  const properties = isRecord(requestedSchema.properties) ? requestedSchema.properties : {};
  const required = Array.isArray(requestedSchema.required)
    ? requestedSchema.required.filter((k): k is string => typeof k === "string")
    : [];

  for (const reqKey of required) {
    if (content[reqKey] === undefined) {
      return `Missing required field "${reqKey}"`;
    }
  }
  for (const [key, val] of Object.entries(content)) {
    const prop = properties[key];
    if (!isRecord(prop)) {
      return `Unexpected field "${key}"`;
    }
    const err = validateFieldValue(prop, val);
    if (err) return `Field "${key}": ${err}`;
  }
  return undefined;
}

async function promptSingleField(
  ui: ElicitationUi,
  serverName: string,
  key: string,
  prop: Record<string, unknown>,
  required: boolean,
  currentValue: unknown,
): Promise<{ kind: "value"; value: unknown } | { kind: "skip" } | { kind: "decline" } | { kind: "cancel" }> {
  const titleText = typeof prop.title === "string" && prop.title ? sanitizeFormText(prop.title) : key;
  const descText = typeof prop.description === "string" && prop.description ? ` — ${sanitizeFormText(prop.description)}` : "";
  const reqTag = required ? " (required)" : " (optional)";
  const header = `[MCP ${serverName}] ${titleText}${reqTag}${descText}`;

  const singleEnum = extractSingleEnumOptions(prop);
  if (singleEnum) {
    const defaultVal = currentValue !== undefined ? currentValue : prop.default;
    const ordered = [...singleEnum].sort((a, b) =>
      a.value === defaultVal ? -1 : b.value === defaultVal ? 1 : 0,
    );
    const labels = ordered.map((o) =>
      o.title === o.value ? o.value : `${o.title} (${o.value})`,
    );
    const skipLabel = "Skip optional field";
    const declineLabel = "Decline request";
    const choices = [...labels, ...(required ? [] : [skipLabel]), declineLabel];
    const picked = await ui.select(header, choices);
    if (picked === undefined) return { kind: "cancel" };
    if (picked === declineLabel) return { kind: "decline" };
    if (!required && picked === skipLabel) return { kind: "skip" };
    const idx = labels.indexOf(picked);
    return idx >= 0 ? { kind: "value", value: ordered[idx].value } : { kind: "cancel" };
  }

  const multiEnum = extractMultiEnumOptions(prop);
  if (multiEnum) {
    const initial = Array.isArray(currentValue)
      ? (currentValue as string[])
      : Array.isArray(prop.default)
        ? (prop.default as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
    const selected = new Set<string>(initial.filter((v) => multiEnum.some((o) => o.value === v)));
    for (;;) {
      const toggleLabels = multiEnum.map((o) => {
        const mark = selected.has(o.value) ? "[x]" : "[ ]";
        return `${mark} ${o.title === o.value ? o.value : `${o.title} (${o.value})`}`;
      });
      const doneLabel = `Done (${selected.size} selected)`;
      const skipLabel = "Skip optional field";
      const declineLabel = "Decline request";
      const choices = [...toggleLabels, doneLabel, ...(required ? [] : [skipLabel]), declineLabel];
      const picked = await ui.select(header, choices);
      if (picked === undefined) return { kind: "cancel" };
      if (picked === declineLabel) return { kind: "decline" };
      if (!required && picked === skipLabel) return { kind: "skip" };
      if (picked === doneLabel) {
        const arr = multiEnum.filter((o) => selected.has(o.value)).map((o) => o.value);
        const err = validateFieldValue(prop, arr);
        if (!err) return { kind: "value", value: arr };
        ui.notify(`${titleText}: ${err}`, "warning");
        continue;
      }
      const idx = toggleLabels.indexOf(picked);
      if (idx >= 0) {
        const val = multiEnum[idx].value;
        if (selected.has(val)) selected.delete(val);
        else selected.add(val);
      }
    }
  }

  if (prop.type === "boolean") {
    const def = typeof currentValue === "boolean" ? currentValue : prop.default === true;
    const yes = "Yes (true)";
    const no = "No (false)";
    const skipLabel = "Skip optional field";
    const declineLabel = "Decline request";
    const base = def ? [yes, no] : [no, yes];
    const choices = [...base, ...(required ? [] : [skipLabel]), declineLabel];
    const picked = await ui.select(header, choices);
    if (picked === undefined) return { kind: "cancel" };
    if (picked === declineLabel) return { kind: "decline" };
    if (!required && picked === skipLabel) return { kind: "skip" };
    return { kind: "value", value: picked === yes };
  }

  // String / Number / Integer via ui.input with validation loop
  const defaultVal = currentValue !== undefined ? currentValue : prop.default;
  const placeholder =
    defaultVal !== undefined
      ? `Default: ${String(defaultVal)}${required ? "" : " (leave blank for default)"}`
      : required
        ? "Enter value"
        : "Optional (leave blank to skip)";

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const raw = await ui.input(header, placeholder);
    if (raw === undefined) return { kind: "cancel" };
    const trimmed = raw.trim();
    if (trimmed === "") {
      if (defaultVal !== undefined) {
        const err = validateFieldValue(prop, defaultVal);
        if (!err) return { kind: "value", value: defaultVal };
      }
      if (!required) return { kind: "skip" };
      if (prop.type === "string" && (prop.minLength === undefined || prop.minLength === 0)) {
        const err = validateFieldValue(prop, "");
        if (!err && raw !== undefined && defaultVal === undefined) {
          // Require non-empty unless user explicitly confirms empty string on required text
        }
      }
      ui.notify(`${titleText} is required.`, "warning");
      continue;
    }

    const parsedValue: unknown =
      prop.type === "number" || prop.type === "integer" ? Number(trimmed) : raw;
    const err = validateFieldValue(prop, parsedValue);
    if (!err) return { kind: "value", value: parsedValue };
    ui.notify(`${titleText}: ${err}`, "warning");
  }

  return { kind: "cancel" };
}

/**
 * Execute an MCP `2026-07-28` `elicitation/create` user interaction over Pi's `ctx.ui`.
 */
export async function runElicitationPrompt(
  ui: ElicitationUi,
  serverName: string,
  rawParams: JsonObject,
  opts?: { openUrl?: (url: string) => unknown },
): Promise<ElicitationResponse> {
  const mode = rawParams.mode === undefined ? "form" : rawParams.mode;
  const rawMessage = typeof rawParams.message === "string" ? rawParams.message : "Additional information requested.";

  if (mode === "url") {
    const inspected = inspectElicitationUrl(rawParams.url);
    if (!inspected.valid || !inspected.href || !inspected.host) {
      ui.notify(
        `[MCP ${serverName}] Rejected invalid elicitation URL: ${inspected.error ?? "malformed URL"}`,
        "warning",
      );
      return { action: "cancel" };
    }
    const warningLines = inspected.warnings.length > 0 ? `\n${inspected.warnings.join("\n")}` : "";
    const promptTitle =
      `[MCP server "${serverName}" requests external browser navigation]\n` +
      `Domain: ${inspected.host}\n` +
      `Full URL: ${inspected.href}\n` +
      `Reason: ${stripControlChars(rawMessage)}${warningLines}`;

    const acceptLabel = `Accept — open ${inspected.host} in browser`;
    const declineLabel = "Decline";
    const cancelLabel = "Cancel";
    const choice = await ui.select(promptTitle, [acceptLabel, declineLabel, cancelLabel]);
    if (choice === acceptLabel) {
      if ((await (opts?.openUrl ?? openExternalBrowser)(inspected.href)) === false) {
        ui.notify(`Could not open a browser. Open this URL yourself: ${inspected.href}`, "warning");
      }
      return { action: "accept" };
    }
    if (choice === declineLabel) return { action: "decline" };
    return { action: "cancel" };
  }

  if (mode !== "form") {
    return { action: "cancel" };
  }

  const schema = isRecord(rawParams.requestedSchema) ? (rawParams.requestedSchema as JsonObject) : undefined;
  const properties = schema && isRecord(schema.properties) ? schema.properties : undefined;
  if (!schema || !properties) {
    return { action: "cancel" };
  }

  const propEntries = Object.entries(properties).filter(([, v]) => isRecord(v)) as Array<
    [string, Record<string, unknown>]
  >;
  const requiredSet = new Set<string>(
    Array.isArray(schema.required)
      ? schema.required.filter((k): k is string => typeof k === "string")
      : [],
  );

  // Initial consent / overview naming the server clearly
  const introTitle =
    `[MCP server "${serverName}" requests form input]\n` +
    `${sanitizeFormText(rawMessage)}`;
  if (propEntries.length === 0) {
    const emptyChoice = await ui.select(introTitle, ["Accept", "Decline", "Cancel"]);
    if (emptyChoice === "Accept") return { action: "accept", content: {} };
    if (emptyChoice === "Decline") return { action: "decline" };
    return { action: "cancel" };
  }

  const startChoice = await ui.select(introTitle, [
    `Fill ${propEntries.length} field${propEntries.length === 1 ? "" : "s"}…`,
    "Decline",
    "Cancel",
  ]);
  if (startChoice === "Decline") return { action: "decline" };
  if (!startChoice || startChoice === "Cancel") return { action: "cancel" };

  const content: JsonObject = {};
  for (const [key, prop] of propEntries) {
    const step = await promptSingleField(ui, serverName, key, prop, requiredSet.has(key), undefined);
    if (step.kind === "cancel") return { action: "cancel" };
    if (step.kind === "decline") return { action: "decline" };
    if (step.kind === "value") content[key] = step.value;
  }

  // Review & modify loop (`elicitation.md`: allow users to review and modify responses before sending)
  for (;;) {
    const summaryLines = propEntries.map(([key]) => {
      const val = content[key];
      return `  ${sanitizeFormText(key)}: ${val === undefined ? "(omitted)" : sanitizeFormText(JSON.stringify(val))}`;
    });
    const reviewTitle =
      `[MCP server "${serverName}" — Review before sending]\n` + summaryLines.join("\n");
    const submitLabel = "Submit (Accept)";
    const editOptions = propEntries.map(([key]) => `Edit "${sanitizeFormText(key)}"`);
    const declineLabel = "Decline";
    const cancelLabel = "Cancel";
    const picked = await ui.select(reviewTitle, [
      submitLabel,
      ...editOptions,
      declineLabel,
      cancelLabel,
    ]);
    if (picked === undefined || picked === cancelLabel) return { action: "cancel" };
    if (picked === declineLabel) return { action: "decline" };
    if (picked === submitLabel) {
      const validationErr = validateElicitationContent(schema, content);
      if (!validationErr) {
        return { action: "accept", content };
      }
      ui.notify(`Validation failed: ${validationErr}`, "warning");
      continue;
    }
    const editIdx = editOptions.indexOf(picked);
    if (editIdx >= 0) {
      const [key, prop] = propEntries[editIdx];
      const step = await promptSingleField(
        ui,
        serverName,
        key,
        prop,
        requiredSet.has(key),
        content[key],
      );
      if (step.kind === "cancel") return { action: "cancel" };
      if (step.kind === "decline") return { action: "decline" };
      if (step.kind === "skip") delete content[key];
      else content[key] = step.value;
    }
  }
}
