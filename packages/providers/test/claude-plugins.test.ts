import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig, SessionOptions } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeMcpConfig } from "../src/claude/mcp-config";
import { buildQueryOptions } from "../src/claude/options";

/**
 * The plugin hub (§12.4) on Claude: a session with plugins on demand loads only CodeDen's own
 * servers (`strictMcpConfig`), and the plugins switched on travel in its private MCP config.
 */
const codeden: McpServerConfig = {
  transport: "http",
  name: "codeden",
  url: "http://127.0.0.1:4318/mcp",
  headers: { Authorization: "Bearer cdm_x" },
  trusted: true,
};
const unreal: McpServerConfig = {
  transport: "http",
  name: "unreal-mcp",
  url: "http://127.0.0.1:8000/mcp",
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function session(extra: Partial<SessionOptions> = {}): SessionOptions {
  const dir = mkdtempSync(join(tmpdir(), "codeden-plugins-"));
  dirs.push(dir);
  return {
    sessionId: "s1",
    role: "agent",
    cwd: dir,
    autonomy: "auto",
    mcpServers: [codeden],
    additionalDirectories: [],
    planMode: false,
    codedenHome: join(dir, "home"),
    ...extra,
  };
}

const options = (s: SessionOptions) =>
  buildQueryOptions({
    session: s,
    executable: { kind: "native", path: "/bin/claude" } as never,
    canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
    hooks: {},
    abortController: new AbortController(),
    mcpConfigFile: "/tmp/mcp.json",
  });

describe("Claude with plugins on demand", () => {
  it("loads only CodeDen's servers, never those in Claude's config files", () => {
    expect(options(session({ pluginsOnDemand: true })).strictMcpConfig).toBe(true);
    expect(options(session()).strictMcpConfig).toBeUndefined();
  });

  it("writes the plugins switched on into the private config, beside CodeDen's own", () => {
    const opts = session({ pluginsOnDemand: true });
    const config = new ClaudeMcpConfig(opts);
    const read = () =>
      Object.keys(
        (JSON.parse(readFileSync(config.file() as string, "utf8")) as { mcpServers: object })
          .mcpServers,
      );
    expect(read()).toEqual(["codeden"]);
    config.setPlugins([unreal, { ...unreal, name: "events", sse: true }]);
    expect(read()).toEqual(["codeden", "unreal-mcp", "events"]);
    const servers = JSON.parse(readFileSync(config.file() as string, "utf8")).mcpServers;
    expect(servers.events.type).toBe("sse");
    // A plugin can never replace CodeDen's own server.
    config.setPlugins([{ ...unreal, name: "codeden" }]);
    expect(read()).toEqual(["codeden"]);
    config.setPlugins([]);
    expect(read()).toEqual(["codeden"]);
    config.remove();
  });
});
