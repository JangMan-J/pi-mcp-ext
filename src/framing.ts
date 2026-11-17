/**
 * Seam: MCP protocol pagination and untrusted-content framing shared by every engine.
 *
 * Owns the `nextCursor` loop (duplicate-cursor and page-ceiling failures), XML attribute/body
 * escaping for `<mcp_*>` wake and tool-result tags, and MCP content-block conversion with private
 * temp-file spills (`./temp-files.ts`). Pure apart from temp-file writes; never touches
 * `ServerClient` beyond `name` and `request`.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { writePrivateTempFile } from "./temp-files.ts";
import { McpTransportError } from "./types.ts";
import type { ClientRequestOptions, JsonObject, ServerClient } from "./types.ts";

/** Hard ceiling on pages followed by `paginateMcp` before failing with a protocol error. */
export const MAX_PAGINATION_PAGES = 1_000;

/** Inline byte budget for `"middle"` truncation (head half + tail half). */
export const MAX_MIDDLE_INLINE_BYTES = 20 * 1024;

/**
 * Follow `nextCursor` from `method` until absent, concatenating `extract(page)`.
 * Rejects with `McpTransportError("protocol")` on a repeated cursor or after
 * `MAX_PAGINATION_PAGES`; never silently truncates.
 */
export async function paginateMcp<T>(
  client: Pick<ServerClient, "name" | "request">,
  method: string,
  extract: (page: JsonObject) => readonly T[],
  params?: JsonObject,
  opts?: ClientRequestOptions,
): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
    const result = await client.request<JsonObject>(
      method,
      cursor === undefined ? params : { ...params, cursor },
      opts,
    );
    for (const item of extract(result)) out.push(item);
    const next = result?.nextCursor;
    if (typeof next !== "string" || next === "") return out;
    if (seen.has(next)) {
      throw new McpTransportError("protocol", `Duplicate pagination cursor on ${method} for "${client.name}"`);
    }
    seen.add(next);
    cursor = next;
  }
  throw new McpTransportError(
    "protocol",
    `Pagination limit (${MAX_PAGINATION_PAGES} pages) exceeded on ${method} for "${client.name}"`,
  );
}

export type McpTagAttrs = Readonly<Record<string, string | number | boolean | undefined>>;

/** Escape `& < > " '` for use inside a double-quoted attribute. */
export function escapeMcpAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Neutralize any `</mcp_*` close tag inside an untrusted body so it cannot end the frame early. */
export function escapeMcpBody(value: string): string {
  return value.replace(/<\/(mcp_)/gi, "<\\/$1");
}

/**
 * Render `<tag a="..">body</tag>`, or `<tag a=".." />` when `body` is undefined.
 * Attributes with `undefined` values are omitted; all others pass through `escapeMcpAttr`,
 * and `body` passes through `escapeMcpBody`.
 */
export function frameMcpTag(tag: string, attrs: McpTagAttrs, body?: string): string {
  let open = `<${tag}`;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    open += ` ${key}="${escapeMcpAttr(String(value))}"`;
  }
  if (body === undefined) return `${open} />`;
  return `${open}>${escapeMcpBody(body)}</${tag}>`;
}

export interface ConvertContentOptions {
  /** `"middle"` keeps head and tail (tool output); `"head"` keeps the head (resources/prompts). Default `"middle"`. */
  truncate?: "head" | "middle";
  /** Temp-file name prefix for spilled text, audio, and binary payloads. */
  tempPrefix?: string;
}

export interface ConvertedContent {
  content: Array<TextContent | ImageContent>;
  /** First spilled full-text path, when any text block was truncated. */
  fullOutputPath?: string;
}

const INLINE_IMAGE_MIME = /^image\/(png|jpeg|jpg|gif|webp)$/i;

function isRecord(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function baseMime(mimeType: string): string {
  return mimeType.split(";")[0].trim();
}

function extFromMime(mimeType: string | undefined, fallback: string): string {
  if (!mimeType) return fallback;
  const clean = baseMime(mimeType).toLowerCase();
  const slash = clean.indexOf("/");
  const sub = slash >= 0 ? clean.slice(slash + 1) : clean;
  return sub.replace(/[^a-z0-9.+-]/g, "") || fallback;
}

/**
 * Convert MCP content blocks (`text`, `image`, `audio`, `resource_link`, `resource`) and
 * resource contents (`{ uri, text | blob, mimeType }`) into Pi content. Never returns an empty
 * `content` array.
 */
export function convertMcpContentBlocks(
  server: string,
  blocks: readonly unknown[],
  opts?: ConvertContentOptions,
): ConvertedContent {
  const mode = opts?.truncate ?? "middle";
  const prefix = opts?.tempPrefix ?? "mcp-content";
  const content: Array<TextContent | ImageContent> = [];
  let fullOutputPath: string | undefined;

  const spill = (ext: string, data: string | Uint8Array): string | undefined => {
    try {
      return writePrivateTempFile(prefix, ext, data);
    } catch {
      return undefined;
    }
  };

  const pushText = (text: string): void => {
    if (mode === "head") {
      const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      if (!truncated.truncated) {
        content.push({ type: "text", text });
        return;
      }
      const file = spill("txt", text);
      fullOutputPath ??= file;
      content.push({
        type: "text",
        text: `${truncated.content}\n${file ? `[truncated: full text written to ${file}]` : "[truncated]"}`,
      });
      return;
    }
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= MAX_MIDDLE_INLINE_BYTES) {
      content.push({ type: "text", text });
      return;
    }
    const half = Math.floor(MAX_MIDDLE_INLINE_BYTES / 2);
    const head = bytes.subarray(0, half).toString("utf8");
    const tail = bytes.subarray(bytes.length - half).toString("utf8");
    const removedChars = Math.max(1, text.length - head.length - tail.length);
    const file = spill("txt", text);
    fullOutputPath ??= file;
    const note = file
      ? `…${removedChars} chars truncated (full output saved to ${file})…`
      : `…${removedChars} chars truncated…`;
    content.push({ type: "text", text: `${head}\n${note}\n${tail}` });
  };

  const pushBinary = (data: string, mimeType: string, label: string, fallbackExt: string): void => {
    const mime = baseMime(mimeType);
    if (INLINE_IMAGE_MIME.test(mime)) {
      content.push({ type: "image", data, mimeType: mime });
      return;
    }
    const bytes = Buffer.from(data, "base64");
    const file = spill(extFromMime(mimeType, fallbackExt), bytes);
    content.push({
      type: "text",
      text: file
        ? `[${label} (${mimeType}, ${bytes.length} bytes) saved to ${file}]`
        : `[${label} (${mimeType}, ${bytes.length} bytes)]`,
    });
  };

  const pushResourceContents = (res: JsonObject): void => {
    const uri = typeof res.uri === "string" ? res.uri : "";
    const mimeType = typeof res.mimeType === "string" ? res.mimeType : undefined;
    if (typeof res.text === "string") {
      pushText(res.text);
    } else if (typeof res.blob === "string") {
      pushBinary(
        res.blob,
        mimeType ?? "application/octet-stream",
        `Binary resource "${uri}" from MCP server "${server}"`,
        "bin",
      );
    }
  };

  for (const raw of blocks) {
    if (!isRecord(raw)) continue;
    if (typeof raw.type !== "string") {
      pushResourceContents(raw);
      continue;
    }
    switch (raw.type) {
      case "text":
        if (typeof raw.text === "string") pushText(raw.text);
        break;
      case "image":
        if (typeof raw.data === "string" && typeof raw.mimeType === "string") {
          pushBinary(raw.data, raw.mimeType, `Image from MCP server "${server}"`, "bin");
        }
        break;
      case "audio":
        if (typeof raw.data === "string") {
          const mime = typeof raw.mimeType === "string" ? raw.mimeType : "audio/wav";
          pushBinary(raw.data, mime, `Audio from MCP server "${server}"`, "wav");
        }
        break;
      case "resource_link": {
        const uri = typeof raw.uri === "string" ? raw.uri : "";
        const desc = typeof raw.description === "string" ? ` — ${raw.description}` : "";
        content.push({
          type: "text",
          text: `[Resource link on MCP server "${server}": ${uri}${desc} (read via mcp_resources action="read")]`,
        });
        break;
      }
      case "resource":
        if (isRecord(raw.resource)) pushResourceContents(raw.resource);
        break;
      default:
        break;
    }
  }

  if (content.length === 0) content.push({ type: "text", text: "" });
  return { content, ...(fullOutputPath ? { fullOutputPath } : {}) };
}
