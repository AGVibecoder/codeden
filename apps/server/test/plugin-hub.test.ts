import type {
  McpServerEntry,
  McpServerTestResult,
  RunnerCommandName,
  RunnerCommandOf,
} from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfigService } from "../src/services/agent-config/agent-config-service";
import { PluginHub } from "../src/services/plugins/hub";
import type { RunnerPort } from "../src/services/runner-port";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

/**
 * The plugin hub (§12.4): a worker switches a plugin on when it needs it (CodeDen opens its
 * program first), off when it's done, and a program CodeDen opened closes once no one uses it.
 */
let env: GithubEnv;
let calls: Array<RunnerCommandOf<RunnerCommandName>>;
let killed: number[];
let tested: string[];
let onDemand: boolean;
let hub: PluginHub;

const entries: McpServerEntry[] = [
  {
    provider: "claude",
    scope: "user",
    name: "unreal-mcp",
    spec: { type: "http", url: "http://127.0.0.1:8000/mcp" },
    startCommand: { command: "UnrealEditor.exe", args: ["{project}\\*.uproject"] },
    file: "~/.claude.json",
    projectId: null,
  },
  {
    provider: "claude",
    scope: "user",
    name: "playwright",
    spec: { type: "stdio", command: "npx", args: ["@playwright/mcp"] },
    file: "~/.claude.json",
    projectId: null,
  },
  {
    provider: "codeden",
    scope: "user",
    name: "codeden",
    spec: { type: "http", url: "http://127.0.0.1:1/mcp" },
    file: "CodeDen",
    projectId: null,
  },
];

beforeEach(() => {
  env = createGithubEnv();
  calls = [];
  killed = [];
  tested = [];
  onDemand = true;
  const runner = {
    providers: () => [{ id: "claude", capabilities: { livePlugins: true } }],
    request: (async (command: RunnerCommandOf<RunnerCommandName>) => {
      calls.push(command);
      return {};
    }) as RunnerPort["request"],
  } as unknown as RunnerPort;
  let opened = false;
  const agentConfig = {
    mcpList: () => entries,
    mcpTest: async (req: { name: string }): Promise<McpServerTestResult> => {
      tested.push(req.name);
      const first = !opened;
      opened = true;
      return {
        ok: true,
        durationMs: 1,
        server: { name: "unreal", version: "1" },
        protocolVersion: null,
        toolCount: 2,
        morePages: false,
        tools: [{ name: "spawn_actor" }, { name: "get_level" }],
        ...(first ? { started: true, startedPid: 4242 } : {}),
      };
    },
  } as unknown as AgentConfigService;
  hub = new PluginHub({
    repo: env.repo,
    runner,
    agentConfig: () => agentConfig,
    onDemand: () => onDemand,
    killTree: (pid) => killed.push(pid),
  });
});

afterEach(() => env.close());

const plugins = () =>
  calls
    .filter((c) => c.name === "session.plugins")
    .map((c) => (c.name === "session.plugins" ? c.servers.map((s) => s.name) : []));

describe("the plugin hub", () => {
  it("lists the user's MCP servers as plugins, all off, never CodeDen's own", () => {
    const session = env.addSession({ status: "running", provider: "claude" });
    expect(hub.appliesTo(session)).toBe(true);
    expect(hub.list(session.id)).toEqual([
      { name: "unreal-mcp", type: "http", startsProgram: true, on: false },
      { name: "playwright", type: "stdio", startsProgram: false, on: false },
    ]);
    onDemand = false;
    expect(hub.appliesTo(session)).toBe(false);
  });

  it("opens a plugin's program, switches it on for that session only, and names its tools", async () => {
    const a = env.addSession({ status: "running", provider: "claude" });
    const text = await hub.use(a.id, "unreal-mcp");
    expect(tested).toEqual(["unreal-mcp"]);
    expect(text).toContain("mcp__unreal-mcp__spawn_actor");
    expect(plugins()).toEqual([["unreal-mcp"]]);
    expect(hub.configsFor(a.id)).toEqual([
      { transport: "http", name: "unreal-mcp", url: "http://127.0.0.1:8000/mcp" },
    ]);
    // A stdio plugin is started by the agent's CLI itself: no test first.
    await hub.use(a.id, "playwright");
    expect(tested).toEqual(["unreal-mcp"]);
    expect(plugins().at(-1)).toEqual(["unreal-mcp", "playwright"]);
    await expect(hub.use(a.id, "nope")).rejects.toThrow("No plugin named nope");
  });

  it("closes the program it opened only once no session has the plugin on", async () => {
    const a = env.addSession({ status: "running", provider: "claude" });
    const b = env.addSession({ status: "running", provider: "claude" });
    await hub.use(a.id, "unreal-mcp");
    await hub.use(b.id, "unreal-mcp");
    await hub.close(a.id, "unreal-mcp");
    expect(killed).toEqual([]);
    expect(plugins().at(-1)).toEqual([]);
    // The other session ends: its plugins go, and the program CodeDen opened closes.
    hub.onSessionStatus(b.id, "completed");
    expect(killed).toEqual([4242]);
    expect(hub.configsFor(b.id)).toEqual([]);
  });

  it("never closes a program it didn't open", async () => {
    const a = env.addSession({ status: "running", provider: "claude" });
    await hub.use(a.id, "playwright");
    expect(await hub.close(a.id, "playwright")).toBe("playwright is off.");
    expect(killed).toEqual([]);
  });
});
