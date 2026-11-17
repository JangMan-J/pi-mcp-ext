/**
 * OAuth 2.0 Client Credentials extension (`io.modelcontextprotocol/oauth-client-credentials`).
 *
 * Implements RFC 6749 §4.4 (`client_secret`) and RFC 7523 / RFC 10070 (`private_key_jwt`) with
 * RFC 9728 Protected Resource Metadata + RFC 8414 / OIDC Authorization Server discovery, strict
 * issuer pinning, RFC 8707 `resource` indicator binding, and in-memory token caching.
 * Never writes or locks `mcp-auth.json`.
 */

import { backgroundTimer } from "./timer.ts";
import { createPrivateKey, createSign, randomUUID, sign as cryptoSign } from "node:crypto";
import { PROTOCOL_VERSION } from "./types.ts";
import type {
  AuthResolver,
  ConfigScope,
  JwtSigningAlgorithm,
  OAuthClientCredentialsConfig,
  ResolvedHttpServer,
} from "./types.ts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const JWT_BEARER_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const ALLOWED_ALGORITHMS: ReadonlySet<string> = new Set([
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isLoopbackUrl(raw: string): boolean {
  if (!URL.canParse(raw)) return false;
  return LOOPBACK_HOSTS.has(new URL(raw).hostname);
}

export function isSecureOrLoopbackUrl(raw: string): boolean {
  if (!URL.canParse(raw)) return false;
  const u = new URL(raw);
  return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname));
}

function isAllowedEndpointForServer(endpointUrl: string, serverIsLoopback: boolean): boolean {
  if (!isSecureOrLoopbackUrl(endpointUrl)) return false;
  if (!serverIsLoopback && isLoopbackUrl(endpointUrl)) return false;
  return true;
}

const OAUTH_HTTP_TIMEOUT_MS = 10_000;

function withBoundedSignal(outer?: AbortSignal, timeoutMs = OAUTH_HTTP_TIMEOUT_MS): {
  signal: AbortSignal;
  cleanup(): void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  outer?.addEventListener("abort", onAbort, { once: true });
  if (outer?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  backgroundTimer(timer);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    },
  };
}

function pathSuffix(pathname: string): string {
  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return trimmed === "" ? "" : trimmed;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

/**
 * Extract and validate optional `clientCredentials` (or `oauth.grantType === "client_credentials"`)
 * from a raw HTTP server entry. Allowed only in `global` or `session` scope on `https:` or loopback.
 */
export function parseClientCredentialsConfig(
  rawEntry: Record<string, unknown>,
  serverUrl: string,
  scope: ConfigScope,
): { config?: OAuthClientCredentialsConfig; warning?: string } {
  const topLevel = rawEntry.clientCredentials;
  const oauthObj = isRecord(rawEntry.oauth) ? rawEntry.oauth : undefined;
  const raw =
    topLevel !== undefined
      ? topLevel
      : oauthObj?.grantType === "client_credentials"
        ? oauthObj
        : undefined;

  if (raw === undefined) return {};
  if (scope === "project") {
    return { warning: "clientCredentials is only allowed in global or session scope; ignored" };
  }
  if (!isSecureOrLoopbackUrl(serverUrl)) {
    return {
      warning:
        "clientCredentials requires an https server URL, or http on localhost, 127.0.0.1, or [::1]; ignored",
    };
  }
  if (!isRecord(raw)) {
    return { warning: "clientCredentials must be an object; ignored" };
  }

  const clientId = raw.clientId;
  if (typeof clientId !== "string" || !clientId.trim()) {
    return { warning: "clientCredentials.clientId must be a non-empty string; ignored" };
  }

  const clientSecret = raw.clientSecret;
  if (clientSecret !== undefined && (typeof clientSecret !== "string" || !clientSecret)) {
    return { warning: "clientCredentials.clientSecret must be a non-empty string; ignored" };
  }

  const privateKey = raw.privateKey;
  if (privateKey !== undefined && (typeof privateKey !== "string" || !privateKey.trim())) {
    return { warning: "clientCredentials.privateKey must be a non-empty PEM string; ignored" };
  }

  if (clientSecret === undefined && privateKey === undefined) {
    return {
      warning: "clientCredentials requires either clientSecret or privateKey; ignored",
    };
  }

  const algorithm = raw.algorithm;
  if (algorithm !== undefined && (typeof algorithm !== "string" || !ALLOWED_ALGORITHMS.has(algorithm))) {
    return {
      warning: `clientCredentials.algorithm must be one of ${[...ALLOWED_ALGORITHMS].join(", ")}; ignored`,
    };
  }

  const kid = raw.kid;
  if (kid !== undefined && (typeof kid !== "string" || !kid.trim())) {
    return { warning: "clientCredentials.kid must be a non-empty string; ignored" };
  }

  const scopeVal = raw.scope;
  if (scopeVal !== undefined && typeof scopeVal !== "string") {
    return { warning: "clientCredentials.scope must be a string; ignored" };
  }

  const serverIsLoopback = isLoopbackUrl(serverUrl);

  const issuer = raw.issuer ?? raw.expectedIssuer;
  if (typeof issuer !== "string" || !issuer.trim()) {
    return {
      warning:
        "clientCredentials requires a pinned issuer URL to prevent credential redirection; ignored",
    };
  }
  if (!issuer.startsWith("!") && !issuer.includes("$") && !isAllowedEndpointForServer(issuer, serverIsLoopback)) {
    return {
      warning:
        "clientCredentials.issuer must be an https URL (or loopback URL when MCP server is loopback); ignored",
    };
  }

  const authServerMetadataUrl = raw.authServerMetadataUrl;
  if (
    authServerMetadataUrl !== undefined &&
    (typeof authServerMetadataUrl !== "string" ||
      (!authServerMetadataUrl.startsWith("!") &&
        !authServerMetadataUrl.includes("$") &&
        !isAllowedEndpointForServer(authServerMetadataUrl, serverIsLoopback)))
  ) {
    return {
      warning:
        "clientCredentials.authServerMetadataUrl must be an https URL (or loopback when server is loopback); ignored",
    };
  }

  const tokenEndpoint = raw.tokenEndpoint;
  if (
    tokenEndpoint !== undefined &&
    (typeof tokenEndpoint !== "string" ||
      (!tokenEndpoint.startsWith("!") &&
        !tokenEndpoint.includes("$") &&
        !isAllowedEndpointForServer(tokenEndpoint, serverIsLoopback)))
  ) {
    return {
      warning: "clientCredentials.tokenEndpoint must be an https URL (or loopback when server is loopback); ignored",
    };
  }

  return {
    config: {
      clientId,
      ...(typeof clientSecret === "string" ? { clientSecret } : {}),
      ...(typeof privateKey === "string" ? { privateKey } : {}),
      ...(typeof algorithm === "string" ? { algorithm: algorithm as JwtSigningAlgorithm } : {}),
      ...(typeof kid === "string" ? { kid } : {}),
      ...(typeof scopeVal === "string" ? { scope: scopeVal } : {}),
      issuer,
      ...(typeof authServerMetadataUrl === "string" ? { authServerMetadataUrl } : {}),
      ...(typeof tokenEndpoint === "string" ? { tokenEndpoint } : {}),
    },
  };
}

/** Sign an RFC 7523 + RFC 10070 JWT Bearer Assertion (`aud` strictly equals the AS `issuer`). */
export function createJwtBearerAssertion(params: {
  clientId: string;
  issuer: string;
  privateKeyPem: string;
  algorithm?: JwtSigningAlgorithm;
  kid?: string;
  nowSeconds?: number;
  lifetimeSeconds?: number;
}): string {
  const alg: JwtSigningAlgorithm = params.algorithm ?? "RS256";
  const iat = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + (params.lifetimeSeconds ?? 300);

  const header = {
    alg,
    typ: "JWT",
    ...(params.kid ? { kid: params.kid } : {}),
  };
  const payload = {
    iss: params.clientId,
    sub: params.clientId,
    aud: params.issuer,
    iat,
    exp,
    jti: randomUUID(),
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const key = createPrivateKey(params.privateKeyPem);

  let signature: Buffer;
  if (alg === "EdDSA") {
    signature = cryptoSign(null, Buffer.from(signingInput, "utf8"), key);
  } else if (alg.startsWith("ES")) {
    const hashAlg = alg === "ES256" ? "SHA256" : alg === "ES384" ? "SHA384" : "SHA512";
    const signer = createSign(hashAlg);
    signer.update(signingInput, "utf8");
    signer.end();
    signature = signer.sign({ key, dsaEncoding: "ieee-p1363" });
  } else {
    const hashAlg = alg === "RS256" ? "RSA-SHA256" : alg === "RS384" ? "RSA-SHA384" : "RSA-SHA512";
    const signer = createSign(hashAlg);
    signer.update(signingInput, "utf8");
    signer.end();
    signature = signer.sign(key);
  }

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

interface DiscoveredEndpoints {
  issuer: string;
  tokenEndpoint: string;
  resourceUri: string;
  authMethods?: readonly string[];
  defaultScopes?: readonly string[];
}

function validateProtectedResourceMatch(serverUrl: string, resourceUri: string): string {
  const requested = new URL(serverUrl);
  requested.hash = "";
  const configured = new URL(resourceUri);
  if (requested.origin !== configured.origin) {
    throw new Error(
      `OAuth protected resource "${resourceUri}" origin does not match MCP server "${requested.href}"`,
    );
  }
  const reqPath = requested.pathname.endsWith("/") ? requested.pathname : `${requested.pathname}/`;
  const cfgPath = configured.pathname.endsWith("/") ? configured.pathname : `${configured.pathname}/`;
  if (!reqPath.startsWith(cfgPath)) {
    throw new Error(
      `OAuth protected resource "${resourceUri}" path does not cover MCP server "${requested.href}"`,
    );
  }
  return configured.href;
}

async function fetchJson(
  url: URL,
  fetchFn: typeof fetch,
  outerSignal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body?: Record<string, unknown> }> {
  const bounded = withBoundedSignal(outerSignal);
  try {
    const res = await fetchFn(url, {
      method: "GET",
      redirect: "error",
      signal: bounded.signal,
      headers: {
        Accept: "application/json",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
      },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, status: res.status };
    }
    const parsed: unknown = await res.json();
    if (!isRecord(parsed)) {
      throw new Error(`Invalid JSON object from OAuth metadata endpoint ${url.href}`);
    }
    return { ok: true, status: res.status, body: parsed };
  } finally {
    bounded.cleanup();
  }
}

async function discoverEndpoints(
  serverUrl: string,
  cfg: {
    issuer?: string;
    authServerMetadataUrl?: string;
    tokenEndpoint?: string;
  },
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<DiscoveredEndpoints> {
  const serverParsed = new URL(serverUrl);
  serverParsed.hash = "";
  const serverIsLoopback = isLoopbackUrl(serverUrl);
  let resourceUri = serverParsed.href;
  let advertisedIssuer: string | undefined;
  let defaultScopes: string[] | undefined;

  if (!cfg.issuer || !isAllowedEndpointForServer(cfg.issuer, serverIsLoopback)) {
    throw new Error(
      `OAuth client_credentials requires a pinned https issuer (or loopback issuer when MCP server is loopback)`,
    );
  }
  const pinnedIssuer = cfg.issuer;

  // Step 1: Protected Resource Metadata (RFC 9728) to obtain resource URI, scopes, and verify advertised AS.
  if (!cfg.tokenEndpoint || !cfg.authServerMetadataUrl) {
    const suffix = pathSuffix(serverParsed.pathname);
    const candidates = [
      new URL(`/.well-known/oauth-protected-resource${suffix}`, serverParsed.origin),
      ...(suffix ? [new URL("/.well-known/oauth-protected-resource", serverParsed.origin)] : []),
    ];
    for (const candidate of candidates) {
      const resp = await fetchJson(candidate, fetchFn, signal);
      if (!resp.ok) {
        if ((resp.status >= 400 && resp.status < 500) || resp.status === 502) continue;
        throw new Error(`HTTP ${resp.status} discovering OAuth protected resource metadata`);
      }
      const meta = resp.body!;
      if (typeof meta.resource === "string") {
        resourceUri = validateProtectedResourceMatch(serverUrl, meta.resource);
      }
      if (Array.isArray(meta.authorization_servers) && typeof meta.authorization_servers[0] === "string") {
        advertisedIssuer = meta.authorization_servers[0];
      }
      if (Array.isArray(meta.scopes_supported) && meta.scopes_supported.every((s) => typeof s === "string")) {
        defaultScopes = meta.scopes_supported as string[];
      }
      break;
    }
  }

  if (advertisedIssuer !== undefined && advertisedIssuer !== pinnedIssuer) {
    throw new Error(
      `OAuth issuer mismatch: expected "${pinnedIssuer}", resource advertised "${advertisedIssuer}"`,
    );
  }

  // If tokenEndpoint is explicitly configured alongside pinned issuer, skip AS discovery.
  if (cfg.tokenEndpoint && !cfg.authServerMetadataUrl) {
    if (!isAllowedEndpointForServer(cfg.tokenEndpoint, serverIsLoopback)) {
      throw new Error(`OAuth tokenEndpoint "${cfg.tokenEndpoint}" is not permitted for server "${serverUrl}"`);
    }
    return {
      issuer: pinnedIssuer,
      tokenEndpoint: cfg.tokenEndpoint,
      resourceUri,
      defaultScopes,
    };
  }

  // Step 2: Authorization Server Metadata (RFC 8414 / OpenID Connect Discovery 1.0) strictly from pinned issuer.
  let asMeta: Record<string, unknown> | undefined;
  if (cfg.authServerMetadataUrl) {
    if (!isAllowedEndpointForServer(cfg.authServerMetadataUrl, serverIsLoopback)) {
      throw new Error(`OAuth authServerMetadataUrl "${cfg.authServerMetadataUrl}" is not permitted`);
    }
    const resp = await fetchJson(new URL(cfg.authServerMetadataUrl), fetchFn, signal);
    if (!resp.ok || !resp.body) {
      throw new Error(
        `HTTP ${resp.status} loading authorization server metadata from ${cfg.authServerMetadataUrl}`,
      );
    }
    asMeta = resp.body;
  } else {
    const issuerUrl = new URL(pinnedIssuer);
    const suffix = pathSuffix(issuerUrl.pathname);
    const asCandidates = [
      new URL(`/.well-known/oauth-authorization-server${suffix}`, issuerUrl.origin),
      new URL(`/.well-known/openid-configuration${suffix}`, issuerUrl.origin),
      ...(suffix ? [new URL(`${suffix}/.well-known/openid-configuration`, issuerUrl.origin)] : []),
    ];
    for (const candidate of asCandidates) {
      const resp = await fetchJson(candidate, fetchFn, signal);
      if (!resp.ok) {
        if ((resp.status >= 400 && resp.status < 500) || resp.status === 502) continue;
        throw new Error(`HTTP ${resp.status} loading authorization server metadata from ${candidate.href}`);
      }
      const meta = resp.body!;
      if (typeof meta.issuer !== "string" || meta.issuer !== pinnedIssuer) {
        throw new Error(
          `OAuth issuer mismatch: expected "${pinnedIssuer}", metadata reported "${String(meta.issuer)}"`,
        );
      }
      asMeta = meta;
      break;
    }
  }

  if (!asMeta) {
    throw new Error(`Could not discover OAuth authorization server metadata for MCP server "${serverUrl}"`);
  }

  const discoveredIssuer = typeof asMeta.issuer === "string" ? asMeta.issuer : undefined;
  if (!discoveredIssuer) {
    throw new Error("Authorization server metadata is missing required \"issuer\" field");
  }
  if (discoveredIssuer !== pinnedIssuer) {
    throw new Error(
      `OAuth issuer mismatch: expected "${pinnedIssuer}", metadata reported "${discoveredIssuer}"`,
    );
  }

  const tokenEndpoint = cfg.tokenEndpoint ?? (typeof asMeta.token_endpoint === "string" ? asMeta.token_endpoint : undefined);
  if (!tokenEndpoint || !isAllowedEndpointForServer(tokenEndpoint, serverIsLoopback)) {
    throw new Error("Authorization server metadata is missing a valid https (or matching loopback) \"token_endpoint\"");
  }

  const authMethods = Array.isArray(asMeta.token_endpoint_auth_methods_supported)
    ? asMeta.token_endpoint_auth_methods_supported.filter((m): m is string => typeof m === "string")
    : undefined;

  return {
    issuer: discoveredIssuer,
    tokenEndpoint,
    resourceUri,
    authMethods,
    defaultScopes,
  };
}

/**
 * Create an in-memory `AuthResolver` using `grant_type=client_credentials` (`client_secret` or
 * RFC 7523 `private_key_jwt`). Refreshes proactively before expiry and once after HTTP 401.
 */
export function createClientCredentialsResolver(
  server: ResolvedHttpServer,
  opts?: {
    fetch?: typeof fetch;
    resolveValue?: (v: string) => string | Promise<string>;
  },
): AuthResolver {
  const fetchFn = opts?.fetch ?? fetch;
  const resolveVal = opts?.resolveValue ?? ((v: string) => v);
  const rawCfg = server.clientCredentials;
  if (!rawCfg) {
    throw new Error(`MCP server "${server.name}" has no clientCredentials configuration`);
  }
  const cfg = rawCfg;

  let cachedToken: string | undefined;
  let expiresAtMs = 0;
  let cachedEndpoints: DiscoveredEndpoints | undefined;
  let inflight: Promise<string> | undefined;

  async function acquireToken(forceRefresh: boolean, signal?: AbortSignal): Promise<string> {
    if (!forceRefresh && cachedToken && Date.now() < expiresAtMs) {
      return cachedToken;
    }
    if (inflight && !signal?.aborted) return inflight;

    const run = (async (): Promise<string> => {
      const clientId = await resolveVal(cfg.clientId);
      const clientSecret = cfg.clientSecret !== undefined ? await resolveVal(cfg.clientSecret) : undefined;
      const privateKey = cfg.privateKey !== undefined ? await resolveVal(cfg.privateKey) : undefined;
      const issuer = cfg.issuer !== undefined ? await resolveVal(cfg.issuer) : undefined;
      const authServerMetadataUrl =
        cfg.authServerMetadataUrl !== undefined ? await resolveVal(cfg.authServerMetadataUrl) : undefined;
      const tokenEndpoint = cfg.tokenEndpoint !== undefined ? await resolveVal(cfg.tokenEndpoint) : undefined;
      const scope = cfg.scope !== undefined ? await resolveVal(cfg.scope) : undefined;
      const kid = cfg.kid !== undefined ? await resolveVal(cfg.kid) : undefined;

      if (!cachedEndpoints || forceRefresh) {
        cachedEndpoints = await discoverEndpoints(
          server.url,
          { issuer, authServerMetadataUrl, tokenEndpoint },
          fetchFn,
          signal,
        );
      }

      const body = new URLSearchParams();
      body.set("grant_type", "client_credentials");
      body.set("resource", cachedEndpoints.resourceUri);

      const effectiveScope =
        scope !== undefined
          ? scope.trim()
          : cachedEndpoints.defaultScopes && cachedEndpoints.defaultScopes.length > 0
            ? cachedEndpoints.defaultScopes.join(" ")
            : undefined;
      if (effectiveScope) {
        body.set("scope", effectiveScope);
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      };

      if (privateKey !== undefined) {
        const assertion = createJwtBearerAssertion({
          clientId,
          issuer: cachedEndpoints.issuer,
          privateKeyPem: privateKey,
          algorithm: cfg.algorithm,
          kid,
        });
        body.set("client_id", clientId);
        body.set("client_assertion_type", JWT_BEARER_ASSERTION_TYPE);
        body.set("client_assertion", assertion);
      } else if (clientSecret !== undefined) {
        const methods = cachedEndpoints.authMethods;
        const useBasic =
          !methods ||
          methods.includes("client_secret_basic") ||
          !methods.includes("client_secret_post");
        if (useBasic) {
          const encoded = Buffer.from(
            `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
            "utf8",
          ).toString("base64");
          headers.Authorization = `Basic ${encoded}`;
        } else {
          body.set("client_id", clientId);
          body.set("client_secret", clientSecret);
        }
      } else {
        throw new Error(`MCP server "${server.name}" clientCredentials has neither clientSecret nor privateKey`);
      }

      const bounded = withBoundedSignal(signal);
      let res: Response;
      try {
        res = await fetchFn(cachedEndpoints.tokenEndpoint, {
          method: "POST",
          redirect: "error",
          signal: bounded.signal,
          headers,
          body: body.toString(),
        });
      } finally {
        bounded.cleanup();
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(
          `OAuth client_credentials token request failed for "${server.name}" (HTTP ${res.status})${errText ? `: ${errText.slice(0, 200)}` : ""}`,
        );
      }
      const tokenJson: unknown = await res.json();
      if (!isRecord(tokenJson) || typeof tokenJson.access_token !== "string" || !tokenJson.access_token) {
        throw new Error(`OAuth token endpoint for "${server.name}" returned no access_token`);
      }

      const expiresInSec =
        typeof tokenJson.expires_in === "number" && Number.isFinite(tokenJson.expires_in) && tokenJson.expires_in > 0
          ? tokenJson.expires_in
          : 300;
      const ttlMs =
        expiresInSec > 60
          ? (expiresInSec - 30) * 1000
          : Math.max(1_000, Math.floor(expiresInSec * 800));
      cachedToken = tokenJson.access_token;
      expiresAtMs = Date.now() + ttlMs;
      return cachedToken;
    })().finally(() => {
      if (inflight === run) inflight = undefined;
    });

    inflight = run;
    return run;
  }

  return {
    async authorization(signal?: AbortSignal): Promise<string | undefined> {
      const token = await acquireToken(false, signal);
      return `Bearer ${token}`;
    },
    async refreshAfterUnauthorized(signal?: AbortSignal): Promise<boolean> {
      const previous = cachedToken;
      cachedToken = undefined;
      expiresAtMs = 0;
      try {
        const next = await acquireToken(true, signal);
        return Boolean(next && next !== previous);
      } catch {
        return false;
      }
    },
  };
}
