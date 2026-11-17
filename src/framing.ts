/**
 * Seam: MCP protocol pagination and untrusted-content framing shared by every engine.
 *
 * Owns the `nextCursor` loop (duplicate-cursor and page-ceiling failures), XML attribute/body
 * escaping for `<mcp_*>` wake and tool-result tags, and MCP content-block conversion with private
 * temp-file spills (`./temp-files.ts`). Pure apart from temp-file writes; never touches
 * `ServerClient` beyond `name` and `request`.
 *
 * SEAM STUB: signatures are fixed; bodies land in the framing slice.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ClientRequestOptions, JsonObject, ServerClient } from "./types.ts";

/** Hard ceiling on pages followed by `paginateMcp` before failing with a protocol error. */
export const MAX_PAGINATION_PAGES = 1_000;

/**
 * Follow `nextCursor` from `method` until absent, concatenating `extract(page)`.
 * Rejects with `McpTransportError("protocol")` on a repeated cursor or after
 * `MAX_PAGINATION_PAGES`; never silently truncates.
 */
export async function paginateMcp<T>(
  _client: Pick<ServerClient, "name" | "request">,
  _method: string,
  _extract: (page: JsonObject) => readonly T[],
  _params?: JsonObject,
  _opts?: ClientRequestOptions,
): Promise<T[]> {
  throw new Error("framing.paginateMcp: seam stub, not implemented");
}

export type McpTagAttrs = Readonly<Record<string, string | number | boolean | undefined>>;

/** Escape `& < > " '` for use inside a double-quoted attribute. */
export function escapeMcpAttr(_value: string): string {
  throw new Error("framing.escapeMcpAttr: seam stub, not implemented");
}

/** Neutralize any `</mcp_*` close tag inside an untrusted body so it cannot end the frame early. */
export function escapeMcpBody(_value: string): string {
  throw new Error("framing.escapeMcpBody: seam stub, not implemented");
}

/**
 * Render `<tag a="..">body</tag>`, or `<tag a=".." />` when `body` is undefined.
 * Attributes with `undefined` values are omitted; all others pass through `escapeMcpAttr`,
 * and `body` passes through `escapeMcpBody`.
 */
export function frameMcpTag(_tag: string, _attrs: McpTagAttrs, _body?: string): string {
  throw new Error("framing.frameMcpTag: seam stub, not implemented");
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

/**
 * Convert MCP content blocks (`text`, `image`, `audio`, `resource_link`, `resource`) and
 * resource contents (`{ uri, text | blob, mimeType }`) into Pi content. Never returns an empty
 * `content` array.
 */
export function convertMcpContentBlocks(
  _server: string,
  _blocks: readonly unknown[],
  _opts?: ConvertContentOptions,
): ConvertedContent {
  throw new Error("framing.convertMcpContentBlocks: seam stub, not implemented");
}
