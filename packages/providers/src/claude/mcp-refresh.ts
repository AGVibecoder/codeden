import type { McpServerState } from "@codeden/contracts";

/** Waits between status reads while a server is still starting; then it waits for the next turn. */
const STARTING_DELAYS_MS = [2_000, 5_000, 10_000, 20_000] as const;

/** How often a failed server is tried again while the session runs. */
const RETRY_FAILED_MS = 30_000;

export interface McpStatusRefresherOptions {
  /** `Query.mcpServerStatus()` of the running query; undefined when none runs. */
  read: () => Promise<unknown> | undefined;
  /** Report the list (`ClaudeEventMapper.reportMcpServers`), returning the states it holds. */
  report: (list: unknown) => readonly McpServerState[];
  /**
   * `Query.reconnectMcpServer(name)` of the running query; undefined when none runs. Without
   * it, failed servers are only reported.
   */
  reconnect?: (name: string) => Promise<void> | undefined;
  delaysMs?: readonly number[];
  retryFailedMs?: number;
}

/**
 * Keeps a Claude session's MCP server states current between `system/init` messages: reads
 * `mcpServerStatus()` (which also carries a failed server's error) when asked, and again a few
 * times while a server is still starting. A server that failed (a local server whose program
 * wasn't running yet, such as an editor's MCP plugin) is reconnected every 30 seconds while the
 * session runs, so its tools arrive once the program is up, without restarting the session. A
 * CLI that can't answer is left alone.
 */
export class McpStatusRefresher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private stopped = false;

  constructor(private readonly opts: McpStatusRefresherOptions) {}

  /** Read the statuses now: after `system/init` and after each turn. */
  refresh(): void {
    if (this.stopped) return;
    this.attempt = 0;
    this.clearTimer();
    void this.read();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.clearRetry();
  }

  private async read(): Promise<void> {
    let list: unknown;
    try {
      list = await this.opts.read();
    } catch {
      return;
    }
    if (this.stopped || list === undefined) return;
    const states = this.opts.report(list);
    this.scheduleRetry(states);
    if (!states.some((s) => s.state === "starting")) return;
    const delay = (this.opts.delaysMs ?? STARTING_DELAYS_MS)[this.attempt++];
    if (delay === undefined) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.stopped) void this.read();
    }, delay);
    this.timer.unref?.();
  }

  /** While a server is failed, try it again later; one retry timer at a time. */
  private scheduleRetry(states: readonly McpServerState[]): void {
    const failed = states.filter((s) => s.state === "failed").map((s) => s.name);
    if (!this.opts.reconnect || failed.length === 0) {
      this.clearRetry();
      return;
    }
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.stopped) void this.retry(failed);
    }, this.opts.retryFailedMs ?? RETRY_FAILED_MS);
    this.retryTimer.unref?.();
  }

  private async retry(names: string[]): Promise<void> {
    for (const name of names) {
      try {
        await this.opts.reconnect?.(name);
      } catch {
        // Still down: the read below reports it and schedules the next try.
      }
      if (this.stopped) return;
    }
    this.attempt = 0;
    await this.read();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}
