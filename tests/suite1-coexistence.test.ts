import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CONFIG_DIR_NAME,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  wrapRegisteredTool,
  type ExtensionFactory,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

import { createAuthResolver } from "../src/config.ts";
import type { ResolvedHttpServer } from "../src/types.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  pi: { extensions: string[] };
};
const extensionEntries = manifest.pi.extensions.map((entry) => resolve(root, entry));

function findPiPackageDir(): string {
  const pkgName = (dir: string): string | undefined => {
    try {
      return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name;
    } catch {
      return undefined;
    }
  };
  let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  while (pkgName(dir) !== "@earendil-works/pi-coding-agent") {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Cannot locate @earendil-works/pi-coding-agent package root");
    }
    dir = parent;
  }
  return dir;
}

const piDir = findPiPackageDir();

interface BuiltinExtensionDescriptor {
  name: string;
  factory: ExtensionFactory;
  replaceable?: boolean;
  builtin: true;
}

const loaderMod = (await import(
  pathToFileURL(join(piDir, "dist/core/extensions/loader.js")).href
)) as {
  loadExtensions: (
    paths: string[],
    cwd: string,
    eventBus?: unknown,
    runtime?: ReturnType<typeof import("@earendil-works/pi-coding-agent").createExtensionRuntime>,
  ) => Promise<LoadExtensionsResult>;
  createExtensionRuntime: typeof import("@earendil-works/pi-coding-agent").createExtensionRuntime;
  clearExtensionCache: () => void;
};

const builtinsMod = (await import(
  pathToFileURL(join(piDir, "dist/extensions/index.js")).href
)) as {
  builtInExtensions: BuiltinExtensionDescriptor[];
};

const FORBIDDEN_TOOL_NAMES = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

function getActiveHandles(): unknown[] {
  const proc = process as NodeJS.Process & { _getActiveHandles?: () => unknown[] };
  return proc._getActiveHandles ? [...proc._getActiveHandles()] : [];
}

function isChildProcessHandle(handle: unknown): boolean {
  return (
    typeof handle === "object" &&
    handle !== null &&
    (handle as { constructor?: { name?: string } }).constructor?.name === "Process"
  );
}

test("Suite 1: factory load opens no handles or child processes and coexists with replaceable builtin:mcp", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "pi-mcp-ext-coexist-"));
  const agentDir = join(scratch, "agent");
  const cwd = join(scratch, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    // 1. Direct loader check: prime jiti once, clear extension cache, and verify factory load opens
    //    zero handles, spawns zero child processes, and registers no MCP servers during load.
    loaderMod.clearExtensionCache();
    await loaderMod.loadExtensions(extensionEntries, cwd, undefined, loaderMod.createExtensionRuntime());
    loaderMod.clearExtensionCache();

    const handlesBefore = getActiveHandles();
    const directRuntime = loaderMod.createExtensionRuntime();
    const directLoaded = await loaderMod.loadExtensions(extensionEntries, cwd, undefined, directRuntime);
    const handlesAfter = getActiveHandles();

    assert.deepEqual(directLoaded.errors, []);
    assert.equal(
      handlesAfter.filter(isChildProcessHandle).length,
      0,
      "factory load must not spawn child processes",
    );
    assert.equal(
      handlesAfter.length,
      handlesBefore.length,
      "factory load must not leave new active handles open",
    );
    assert.deepEqual(
      directRuntime.mcpServers.list(),
      [],
      "factory load must not call pi.registerMcpServer()",
    );

    // 2. Full DefaultResourceLoader check: load Pi's builtInExtensions (where builtin:mcp has
    //    replaceable: true) alongside package.json pi.extensions in a single runtime.
    const builtinMcpDef = builtinsMod.builtInExtensions.find((ext) => ext.name === "mcp");
    assert.ok(builtinMcpDef, "builtInExtensions must include mcp");
    assert.equal(builtinMcpDef.replaceable, true, "builtin:mcp is marked replaceable: true");

    const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: builtinsMod.builtInExtensions,
      additionalExtensionPaths: extensionEntries,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const loaded = resourceLoader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(
      (loaded.warnings ?? []).some((w) => w.path === "builtin:mcp"),
      false,
      "builtin:mcp must not emit a replacement warning",
    );

    const builtinMcp = loaded.extensions.find((ext) => ext.path === "builtin:mcp");
    assert.ok(builtinMcp, "builtin:mcp must remain loaded alongside pi-mcp-ext");
    assert.equal(builtinMcp.replaceable, true);
    assert.equal(builtinMcp.commands.has("mcp"), true, "builtin:mcp must still own /mcp");

    const ourExt = loaded.extensions.find((ext) => ext.resolvedPath === extensionEntries[0]);
    assert.ok(ourExt, "package.json pi.extensions entry must load");

    assert.equal(ourExt.commands.has("mcp"), false, "pi-mcp-ext must not register /mcp");
    assert.deepEqual([...ourExt.commands.keys()].sort(), ["mcp-prompt"]);
    assert.equal(ourExt.flags.size, 0, "pi-mcp-ext must not register CLI flags");

    const ourTools = [...ourExt.tools.keys()].sort();
    assert.deepEqual(ourTools, [
      "mcp_events",
      "mcp_prompts",
      "mcp_resources",
      "mcp_skills",
      "mcp_tasks",
    ]);
    for (const toolName of ourTools) {
      assert.equal(FORBIDDEN_TOOL_NAMES.has(toolName), false);
      assert.equal(toolName.startsWith("mcp__"), false);
    }

    assert.deepEqual(
      [...ourExt.messageRenderers.keys()].sort(),
      ["mcp-event", "mcp-resource", "mcp-task"],
    );
  } finally {
    if (prevAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("Suite 1: real session_start ignores untrusted .pi/mcp.json and never writes or locks mcp-auth.json", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "pi-mcp-ext-session-"));
  const agentDir = join(scratch, "agent");
  const cwd = join(scratch, "untrusted-repo");
  const projectConfigDir = join(cwd, CONFIG_DIR_NAME);
  const markerPath = join(scratch, "untrusted-spawned.marker");

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectConfigDir, { recursive: true });

  // Global config defines one disabled stdio server so mcp_events { action: "servers" } proves
  // global mcp.json was loaded while untrusted project overrides and servers were ignored.
  writeFileSync(
    join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        global_idle: {
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          enabled: false,
        },
      },
    }),
  );

  // Untrusted project .pi/mcp.json defines a stdio server that creates markerPath if spawned,
  // plus a partial override attempting to enable global_idle.
  writeFileSync(
    join(projectConfigDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        evil_project: {
          command: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeFileSync(process.argv[1], 'spawned')",
            markerPath,
          ],
        },
        global_idle: {
          enabled: true,
        },
      },
    }),
  );

  // Pre-seed mcp-auth.json with a legacy URL key (which builtin:mcp's store would migrate on write)
  // and backdate mtime so any touch/write is immediately observable.
  const mcpAuthPath = join(agentDir, "mcp-auth.json");
  const initialAuthContent = JSON.stringify(
    {
      "https://auth.example.test/mcp": {
        tokens: { access_token: "readonly-token" },
      },
    },
    null,
    2,
  );
  writeFileSync(mcpAuthPath, initialAuthContent);
  const fixedDate = new Date("2025-01-01T00:00:00.000Z");
  utimesSync(mcpAuthPath, fixedDate, fixedDate);
  const authStatBefore = statSync(mcpAuthPath);

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
    assert.equal(settingsManager.isProjectTrusted(), false);

    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: builtinsMod.builtInExtensions,
      additionalExtensionPaths: extensionEntries,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const { session, extensionsResult } = await createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      resourceLoader,
      noTools: "builtin",
    });

    try {
      assert.deepEqual(extensionsResult.errors, []);
      assert.ok(
        extensionsResult.extensions.some((ext) => ext.path === "builtin:mcp"),
        "builtin:mcp active in session",
      );

      // Drive real session_start across both builtin:mcp and pi-mcp-ext.
      await session.bindExtensions({});

      const mcpEventsReg = session.extensionRunner
        .getAllRegisteredTools()
        .find((tool) => tool.definition.name === "mcp_events");
      assert.ok(mcpEventsReg, "mcp_events must be registered on the session ExtensionRunner");

      const mcpEventsTool = wrapRegisteredTool(mcpEventsReg, session.extensionRunner);
      const serversResult = await mcpEventsTool.execute("call-servers-1", { action: "servers" });
      const servers = serversResult.details as Array<{ name: string; era: string }>;

      assert.equal(
        servers.some((s) => s.name === "evil_project"),
        false,
        "untrusted project server must be absent from mcp_events { action: 'servers' }",
      );
      const globalIdle = servers.find((s) => s.name === "global_idle");
      assert.ok(globalIdle, "global mcp.json server must be present");
      assert.equal(
        globalIdle.era,
        "disabled",
        "untrusted project partial override must not enable global_idle",
      );
      assert.equal(existsSync(markerPath), false, "untrusted stdio command must never run");
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }

    // Also drive a real AgentSession for pi-mcp-ext with an enabled HTTP server in global mcp.json
    // plus createAuthResolver read/refresh cycles to prove mcp-auth.json is strictly read-only.
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          remote_http: {
            url: "https://auth.example.test/mcp",
          },
        },
      }),
    );

    const httpLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [],
      additionalExtensionPaths: extensionEntries,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await httpLoader.reload();

    const { session: httpSession } = await createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      resourceLoader: httpLoader,
      noTools: "builtin",
    });

    try {
      await httpSession.bindExtensions({});

      const httpMcpEventsReg = httpSession.extensionRunner
        .getAllRegisteredTools()
        .find((tool) => tool.definition.name === "mcp_events");
      assert.ok(httpMcpEventsReg);
      const httpMcpEvents = wrapRegisteredTool(httpMcpEventsReg, httpSession.extensionRunner);
      const httpServers = (
        await httpMcpEvents.execute("call-servers-2", { action: "servers" })
      ).details as Array<{ name: string }>;
      assert.equal(httpServers.some((s) => s.name === "remote_http"), true);
      assert.equal(httpServers.some((s) => s.name === "evil_project"), false);
      assert.equal(existsSync(markerPath), false);

      const httpServerConfig: ResolvedHttpServer = {
        name: "remote_http",
        namespace: "mcp__remote_http",
        scope: "global",
        transport: "http",
        enabled: true,
        timeoutMs: 5_000,
        url: "https://auth.example.test/mcp",
        headers: {},
      };
      const resolver = createAuthResolver(httpServerConfig, async () => undefined);
      assert.equal(await resolver.authorization(), "Bearer readonly-token");
      assert.equal(await resolver.refreshAfterUnauthorized(), false);
    } finally {
      await httpSession.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      httpSession.dispose();
    }

    const authStatAfter = statSync(mcpAuthPath);
    const authContentAfter = readFileSync(mcpAuthPath, "utf8");
    assert.equal(authContentAfter, initialAuthContent, "mcp-auth.json content must not change");
    assert.equal(
      authStatAfter.mtimeMs,
      authStatBefore.mtimeMs,
      "mcp-auth.json mtime must not change",
    );

    const agentEntries = readdirSync(agentDir);
    assert.equal(
      agentEntries.some((entry) => entry.startsWith("mcp-auth-refresh-")),
      false,
      "no mcp-auth-refresh-* lock files may be created",
    );
    assert.equal(
      agentEntries.some((entry) => entry.includes("mcp-auth") && entry !== "mcp-auth.json"),
      false,
      "no mcp-auth lockfile or temp file may be created",
    );
  } finally {
    if (prevAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});
