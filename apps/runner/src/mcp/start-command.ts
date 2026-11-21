/// <reference path="../types/cross-spawn.d.ts" />
import { connect } from "node:net";
import type { McpStartCommand } from "@codeden/contracts";
import crossSpawn from "cross-spawn";
import type { SpawnServer } from "./stdio-transport";

/** How long one "is the address answering" check may take. */
const PROBE_TIMEOUT_MS = 1_000;
/** Pause between checks while a started server comes up. */
const POLL_MS = 1_000;

export interface EnsureStartedOptions {
  /** The server's URL; its host and port are what gets checked. */
  url: URL;
  start: McpStartCommand;
  cwd: string;
  env: Record<string, string>;
  /** Longest wait for the address to answer after the command was started. */
  waitMs: number;
  /** True when something accepts connections on `host:port` (a TCP connect by default). */
  probe?: (host: string, port: number) => Promise<boolean>;
  /** Starts the command (`cross-spawn` by default; tests pass a fake child process). */
  spawn?: SpawnServer;
  /** Waits between checks (a timer by default). */
  sleep?: (ms: number) => Promise<void>;
  /** The clock the wait is measured on (`performance.now` by default). */
  now?: () => number;
}

/**
 * Make sure the program behind an `http` or `sse` MCP server is running (§12.4): when nothing
 * answers on the URL's host and port, run the server's start command and wait for the address
 * to answer. Returns whether the command was run. What it starts is the user's own program
 * (an editor, a local service): it runs on its own and is never stopped by CodeDen.
 * Throws when the command can't be started or nothing answers in time.
 */
export async function ensureServerStarted(opts: EnsureStartedOptions): Promise<boolean> {
  const probe = opts.probe ?? tcpProbe;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => performance.now());
  const host = opts.url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(opts.url.port) || (opts.url.protocol === "https:" ? 443 : 80);
  if (await probe(host, port)) return false;

  await launch(opts);
  const deadline = now() + opts.waitMs;
  while (now() < deadline) {
    await sleep(POLL_MS);
    if (await probe(host, port)) return true;
  }
  throw new Error(
    `Started "${opts.start.command}", but nothing answered on ${host}:${port} within ${Math.round(opts.waitMs / 1000)} s. It may still be opening: test again in a moment`,
  );
}

/** Start the command on its own: no pipes, not tied to the runner, its window shown. */
function launch(opts: EnsureStartedOptions): Promise<void> {
  const spawn = opts.spawn ?? crossSpawn;
  return new Promise((resolve, reject) => {
    const child = spawn(opts.start.command, opts.start.args ?? [], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: "ignore",
      detached: true,
      windowsHide: false,
    });
    child.once("error", (error) =>
      reject(new Error(`Start command failed: ${error.message}`, { cause: error })),
    );
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function tcpProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
