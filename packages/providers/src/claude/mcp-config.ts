import { existsSync } from "node:fs";
import type { McpServerConfig, SessionOptions } from "@codeden/contracts";
import { type PrivateMcpConfig, writePrivateMcpConfig } from "../util/private-mcp-config";
import { claudeMcpServers } from "./options";

/**
 * A Claude session's MCP servers as the private file the CLI reads with `--mcp-config <file>`
 * (§15): never inline on its command line, where any local process could read the bearer token.
 * The plugins the agent switched on (`setPlugins`) are in it too, so a query restarted after the
 * CLI exits keeps them.
 */
export class ClaudeMcpConfig {
  private written: PrivateMcpConfig | undefined;
  private plugins: McpServerConfig[] = [];

  constructor(
    private readonly opts: Pick<SessionOptions, "sessionId" | "mcpServers" | "codedenHome">,
  ) {}

  /** Every server of the session: CodeDen's, then the plugins switched on. */
  servers(): McpServerConfig[] {
    const own = new Set(this.opts.mcpServers.map((s) => s.name));
    return [...this.opts.mcpServers, ...this.plugins.filter((p) => !own.has(p.name))];
  }

  /** Replace the plugins; the file is written again the next time it is asked for. */
  setPlugins(plugins: McpServerConfig[]): void {
    this.plugins = [...plugins];
    this.remove();
  }

  /**
   * The file's path, none without servers. Written once, or again when it went missing or the
   * plugins changed, since a query restarted after the CLI exits reads it again.
   */
  file(): string | undefined {
    if (this.opts.mcpServers.length === 0) return undefined;
    if (this.written && existsSync(this.written.file)) return this.written.file;
    this.remove();
    this.written = writePrivateMcpConfig({
      sessionId: this.opts.sessionId,
      ...(this.opts.codedenHome ? { codedenHome: this.opts.codedenHome } : {}),
      config: { mcpServers: claudeMcpServers(this.servers()) },
    });
    return this.written.file;
  }

  /** Delete the file and its folder (when the session closes). */
  remove(): void {
    try {
      this.written?.remove();
    } catch {
      // Best effort: the token in it is revoked when the session ends.
    }
    this.written = undefined;
  }
}
