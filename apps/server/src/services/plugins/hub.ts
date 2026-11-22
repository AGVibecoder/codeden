import { spawn } from "node:child_process";
import type { McpServerConfig, McpServerEntry, Session, SessionStatus } from "@codeden/contracts";
import type { AgentConfigService } from "../agent-config/agent-config-service";
import type { RunnerDeps } from "../runner-port";
import { runnerForSession } from "../runner-port";
import type { SessionRepo } from "../sessions/repo";

/** A plugin: one of the user's MCP servers beyond CodeDen's own. */
export interface Plugin {
  name: string;
  /** `stdio` (a program Claude runs) or `http`/`sse` (an address, maybe with a start command). */
  type: McpServerEntry["spec"]["type"];
  /** CodeDen opens its program when it isn't running (a start command is set). */
  startsProgram: boolean;
  /** On for this session. */
  on: boolean;
}

export interface PluginHubDeps extends RunnerDeps {
  repo: SessionRepo;
  agentConfig: () => AgentConfigService;
  onDemand: () => boolean;
  /** Stops a process and what it started (the program a start command opened). */
  killTree?: (pid: number) => void;
  log?: (message: string) => void;
}

/** Sessions that no longer run: their plugins are gone. */
const ENDED = new Set<SessionStatus>(["completed", "stopped", "failed"]);

/** CodeDen's own MCP server, never a plugin. */
const OWN_SERVER = "codeden";

/**
 * The plugin hub (§12.4). Agent sessions on providers that can switch MCP servers live
 * (`capabilities.livePlugins`) start with only CodeDen's own tools; the user's other MCP servers
 * are plugins, off (and costing no tokens) until the agent switches one on with `use_plugin`.
 * Switching one on opens its program first when it has a start command and isn't running (the
 * same as Test on Agents › MCP servers), then adds it to that session only. The agent switches it
 * off with `close_plugin` when it no longer needs it, and a session's plugins go when it ends. A
 * program CodeDen opened for a plugin is closed once no session has that plugin on; one the user
 * opened is never closed.
 */
export class PluginHub {
  /** Plugins on, by session. */
  private readonly on = new Map<string, Set<string>>();
  /** Programs CodeDen opened for a plugin, by plugin name. */
  private readonly opened = new Map<string, number>();

  constructor(private readonly deps: PluginHubDeps) {}

  /** True when `session` works with plugins on demand (setting on, agent, provider able). */
  appliesTo(session: Pick<Session, "id" | "role" | "provider">): boolean {
    if (!this.deps.onDemand() || session.role !== "agent") return false;
    const runner = runnerForSession(this.deps, session.id);
    if (runner !== this.deps.runner) return false;
    return runner.providers().some((p) => p.id === session.provider && p.capabilities.livePlugins);
  }

  /** True when the hub applies to the session and at least one plugin is set up for it. */
  offersTo(session: Pick<Session, "id" | "role" | "provider" | "projectId">): boolean {
    if (!this.appliesTo(session)) return false;
    try {
      return this.entries(session).length > 0;
    } catch {
      return false;
    }
  }

  /** The plugins the session's provider config offers, and whether each is on for it. */
  list(sessionId: string): Plugin[] {
    const session = this.deps.repo.get(sessionId);
    const on = this.on.get(sessionId) ?? new Set();
    return this.entries(session).map((e) => ({
      name: e.name,
      type: e.spec.type,
      startsProgram: Boolean(e.startCommand),
      on: on.has(e.name),
    }));
  }

  /** The configs of the plugins on for the session, for its next start (`SessionOptions.plugins`). */
  configsFor(sessionId: string): McpServerConfig[] {
    const names = this.on.get(sessionId);
    if (!names?.size) return [];
    const session = this.deps.repo.find(sessionId)?.session;
    if (!session) return [];
    return this.entries(session)
      .filter((e) => names.has(e.name))
      .map(toConfig)
      .filter((c): c is McpServerConfig => c !== null);
  }

  /** The names of the session's plugins (for its brief), on or off. */
  namesFor(session: Session): string[] {
    return this.entries(session).map((e) => e.name);
  }

  /**
   * Switch a plugin on for the session: open its program when needed, then add it live.
   * Returns what the agent is told; throws with a message for the agent when it can't.
   */
  async use(sessionId: string, name: string): Promise<string> {
    const session = this.deps.repo.get(sessionId);
    if (!this.appliesTo(session)) throw new Error("Plugins aren't switched on demand here.");
    const entry = this.entries(session).find((e) => e.name === name);
    if (!entry) throw new Error(`No plugin named ${name}. Plugins: ${this.namesText(session)}.`);
    const config = toConfig(entry);
    if (!config) throw new Error(`${name} can't be switched on here.`);
    let tools: string[] = [];
    if (entry.spec.type !== "stdio") {
      // Opens the program behind the address when it has a start command and isn't running.
      const test = await this.deps.agentConfig().mcpTest({
        provider: "claude",
        scope: entry.scope,
        name,
        ...(session.projectId ? { projectId: session.projectId } : {}),
      });
      if (!test.ok) throw new Error(`${name} isn't reachable: ${test.error}`);
      if (test.startedPid && !this.opened.has(name)) this.opened.set(name, test.startedPid);
      tools = test.tools.map((t) => t.name);
    }
    const names = new Set(this.on.get(sessionId) ?? []);
    names.add(name);
    await this.apply(session, names);
    const list = tools.length
      ? ` Its tools: ${tools
          .slice(0, 40)
          .map((t) => `mcp__${name}__${t}`)
          .join(", ")}${tools.length > 40 ? ", …" : ""}.`
      : ` Its tools are named mcp__${name}__<tool>.`;
    return `${name} is on.${list} Leave it on while you still need it; call close_plugin when you're done with it.`;
  }

  /** Switch a plugin off for the session; closes the program CodeDen opened once no one uses it. */
  async close(sessionId: string, name: string): Promise<string> {
    const session = this.deps.repo.get(sessionId);
    const names = new Set(this.on.get(sessionId) ?? []);
    if (!names.delete(name)) return `${name} wasn't on.`;
    await this.apply(session, names);
    const closed = this.closeUnused(name);
    return `${name} is off${closed ? ", and the program CodeDen opened for it is closed" : ""}.`;
  }

  /** A session's status changed: an ended one loses its plugins. */
  onSessionStatus(sessionId: string, status: SessionStatus): void {
    if (!ENDED.has(status)) return;
    const names = this.on.get(sessionId);
    if (!names) return;
    this.on.delete(sessionId);
    for (const name of names) this.closeUnused(name);
  }

  private async apply(session: Session, names: Set<string>): Promise<void> {
    const configs = this.entries(session)
      .filter((e) => names.has(e.name))
      .map(toConfig)
      .filter((c): c is McpServerConfig => c !== null);
    await runnerForSession(this.deps, session.id).request(
      { name: "session.plugins", sessionId: session.id, servers: configs },
      30_000,
    );
    if (names.size) this.on.set(session.id, names);
    else this.on.delete(session.id);
  }

  /** Close the program CodeDen opened for `name` when no session has it on. */
  private closeUnused(name: string): boolean {
    const pid = this.opened.get(name);
    if (!pid) return false;
    for (const names of this.on.values()) if (names.has(name)) return false;
    this.opened.delete(name);
    this.deps.log?.(`plugins: closing ${name}'s program (pid ${pid})`);
    (this.deps.killTree ?? killTree)(pid);
    return true;
  }

  /** The session's plugins: Claude's MCP servers for its project, minus CodeDen's, enabled ones. */
  private entries(session: Pick<Session, "projectId">): McpServerEntry[] {
    const seen = new Set<string>();
    return this.deps
      .agentConfig()
      .mcpList(session.projectId ?? undefined)
      .filter((e) => {
        if (e.provider !== "claude" || e.name === OWN_SERVER || e.spec.enabled === false) {
          return false;
        }
        if (seen.has(e.name)) return false;
        seen.add(e.name);
        return true;
      });
  }

  private namesText(session: Session): string {
    const names = this.namesFor(session);
    return names.length ? names.join(", ") : "none";
  }
}

/** A configured server as the session config the provider gets; null when it can't be one. */
export function toConfig(entry: McpServerEntry): McpServerConfig | null {
  const spec = entry.spec;
  if (spec.type === "stdio") {
    return {
      transport: "stdio",
      name: entry.name,
      command: spec.command,
      args: spec.args ?? [],
      ...(spec.env ? { env: spec.env } : {}),
    };
  }
  try {
    new URL(spec.url);
  } catch {
    return null;
  }
  return {
    transport: "http",
    name: entry.name,
    url: spec.url,
    ...(spec.type === "sse" ? { sse: true } : {}),
    ...(spec.headers ? { headers: spec.headers } : {}),
  };
}

/** Stop a process and what it started. */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).on("error", () => undefined);
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    // Already gone.
  }
}
