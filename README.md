# @jangmanj/pi-mcp-ext

Stateless MCP `2026-07-28` events and asynchronous tasks for Pi, running alongside `builtin:mcp`.

## What It Adds Next to `builtin:mcp`

Pi's `builtin:mcp` extension owns `/mcp`, synchronous `mcp__<server>__<tool>` tool exposure, resource tools, and `mcp-auth.json` sign-in and token refresh. `@jangmanj/pi-mcp-ext` loads in the same Pi session without replacing `builtin:mcp` and adds the `2026-07-28` protocol capabilities on configured `stdio` and Streamable HTTP servers:

- **Stateless discovery and change streams**: probes enabled servers with `server/discover` (falling back cleanly when a server speaks an older MCP version) and maintains at most one `subscriptions/listen` stream per modern server when needed.
- **Events (`io.modelcontextprotocol/events`)**: discovers event types via `events/list`, catches up with `events/poll`, streams live occurrences via `events/stream`, persists replay cursors in the session branch, deduplicates deliveries, and wakes Pi turns with `mcp-event` messages.
- **Tasks (`io.modelcontextprotocol/tasks`)**: invokes task-augmented MCP tools, tracks `working` and `input_required` tasks across `subscriptions/listen` push notifications and fallback `tasks/get` polling, supplies interactive input via `tasks/update`, cancels via `tasks/cancel`, and wakes Pi turns with `mcp-task` messages.
- **Task-capability hint**: when a synchronous `mcp__<server>__<tool>` call fails with `-32021` naming `io.modelcontextprotocol/tasks` on a server that supports tasks, appends a hint showing the equivalent `mcp_tasks` call.
- **Headless settle hold**: keeps `-p` and `--mode json` runs alive while non-terminal tasks or `holdSettle` event subscriptions are active, settling cleanly once deliveries drain.
- **Read-only configuration and credentials**: reads global `mcp.json`, trusted project `.pi/mcp.json`, session-registered servers, and `mcp-auth.json` without writing or locking config or credential files.

## Install

```sh
pi install npm:@jangmanj/pi-mcp-ext
```

## Tools

Both tools register directly (and are callable from `codemode` scripts as `tools.mcp_events(...)` and `tools.mcp_tasks(...)`).

### `mcp_events`

Manage MCP `2026-07-28` event discovery, subscriptions, and polling.

- `action`: `"servers" | "list" | "subscribe" | "unsubscribe" | "subscriptions" | "poll"`
- `server?: string` — MCP server name (required for `list`, `subscribe`, `unsubscribe`, `poll`).
- `name?: string` — event type name (required for `subscribe`, `unsubscribe`, `poll`).
- `arguments?: Record<string, unknown>` — event filter or subscription arguments validated against the event's `inputSchema`.
- `delivery?: "auto" | "push" | "poll"` — delivery preference (default `"auto"`, preferring push with poll catch-up).
- `cursor?: string | null` — explicit starting cursor (`null` starts from now; omit to resume from the persisted session cursor).
- `maxAgeMs?: number` — optional replay age limit in integer milliseconds.
- `maxEvents?: number` — optional batch size limit for `action: "poll"`.
- `holdSettle?: boolean` — keep headless (`-p` / `--mode json`) runs open until an event arrives or `unsubscribe` is called.

### `mcp_tasks`

Invoke and manage MCP `2026-07-28` task-augmented tool calls.

- `action`: `"call" | "get" | "update" | "cancel" | "active"`
- `server?: string` — MCP server name (required for `call`, `get`, `update`, `cancel`; optional filter for `active`).
- `tool?: string` — tool name on `server` for `action: "call"`. Returns the completed tool result immediately if the server finishes synchronously, or tracks the created task if the server returns `resultType: "task"`.
- `arguments?: Record<string, unknown>` — tool arguments for `action: "call"`.
- `taskId?: string` — task identifier for `get`, `update`, and `cancel`.
- `inputResponses?: Record<string, unknown>` — responses keyed by `inputRequests` id for `action: "update"`.

`action: "active"` reads the client's session task ledger directly without issuing a server RPC.

## Declarative Subscriptions (`subscribe`)

Any server entry in global `mcp.json`, a trusted project `.pi/mcp.json` (full server definition), or `pi.registerMcpServer()` may include an optional `subscribe` array. `builtin:mcp` ignores unknown fields, while `@jangmanj/pi-mcp-ext` activates the declared subscriptions automatically on `session_start` once `server/discover` confirms `io.modelcontextprotocol/events`:

```json
{
  "mcpServers": {
    "alerts": {
      "url": "https://alerts.example.com/mcp",
      "subscribe": ["*"]
    },
    "ci": {
      "command": "ci-mcp",
      "subscribe": [
        "build.failed",
        {
          "name": "deploy.finished",
          "arguments": { "env": "prod" },
          "delivery": "push",
          "maxAgeMs": 600000,
          "holdSettle": false
        }
      ]
    }
  }
}
```

- Each item is `"*"` (all push- or poll-capable events in `events/list`), an event name string, or `{ name, arguments?, delivery?, maxAgeMs?, holdSettle? }`.
- Defaults are `delivery: "auto"` and `holdSettle: false`, so declarative subscriptions do not hold headless runs open unless `holdSettle: true` is set.
- Subscriptions resume from the latest persisted session cursor when present, or start from `cursor: null` so restarts do not replay previously delivered events.
- Invalid `subscribe` values log a warning without blocking the server entry; legacy servers or servers without `io.modelcontextprotocol/events` ignore `subscribe`.
- Removing an entry from `subscribe` does not cancel an already-persisted subscription; call `mcp_events` with `action: "unsubscribe"` to stop it.

## Development

```sh
npm run typecheck   # Type-check src/ and tests/ with tsc --noEmit
npm test            # Run the node:test suite
npm run check       # Run typecheck and tests
npm run smoke:pack  # Pack tarball, install in a scratch directory, and load in Pi
```
