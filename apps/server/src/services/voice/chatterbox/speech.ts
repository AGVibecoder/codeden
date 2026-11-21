import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Starts the speech process (`chatterbox_tts.py serve`); tests pass a fake. */
export type SpawnSpeech = () => ChildProcess;

interface Pending {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The long-running Chatterbox process (§11.3): one JSON request per line in, `ok <id> <value>`
 * or `err <id> <message>` out. Started on first use; stopped after `idleMs` without a request so
 * the graphics card's memory is free again, and started again when needed.
 */
export class ChatterboxSpeech {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly opts: {
      spawn: SpawnSpeech;
      /** Unload after this long without a request (default 10 minutes). */
      idleMs?: number;
      log?: (message: string) => void;
    },
  ) {}

  /** Send one request; resolves with what follows `ok <id>`. */
  async request(body: Record<string, unknown>, timeoutMs: number): Promise<string> {
    clearTimeout(this.idleTimer);
    await this.start();
    const child = this.child;
    if (!child?.stdin) throw new Error("Chatterbox isn't running");
    const id = this.nextId++;
    const answer = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chatterbox didn't answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
    try {
      return await answer;
    } finally {
      this.armIdle();
    }
  }

  /** Stop the process (pending requests fail). */
  stop(): void {
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = null;
    this.ready = null;
    child?.kill();
    this.failAll(new Error("Chatterbox stopped"));
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => this.stop(), this.opts.idleMs ?? 10 * 60_000);
    this.idleTimer.unref?.();
  }

  private failAll(error: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
      this.pending.delete(id);
    }
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const child = this.opts.spawn();
    this.child = child;
    let tail = "";
    this.ready = new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
      lines.on("line", (raw) => {
        const line = raw.trim();
        if (line === "ready") return resolve();
        const m = /^(ok|err) (\d+)(?: (.*))?$/.exec(line);
        if (!m) return;
        const p = this.pending.get(Number(m[2]));
        if (!p) return;
        this.pending.delete(Number(m[2]));
        clearTimeout(p.timer);
        if (m[1] === "ok") p.resolve(m[3] ?? "");
        else p.reject(new Error(m[3] || "Chatterbox failed"));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        tail = (tail + text).slice(-2000);
        for (const l of text.split(/\r?\n/))
          if (l.trim()) this.opts.log?.(`chatterbox: ${l.trim()}`);
      });
      child.once("error", (error) => reject(error));
      child.once("exit", (code) => {
        const last = tail.trim().split(/\r?\n/).pop() ?? "";
        const error = new Error(
          `Chatterbox stopped (exit ${code ?? "?"})${last ? `: ${last.slice(0, 300)}` : ""}`,
        );
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
        reject(error);
        this.failAll(error);
      });
    });
    this.ready.catch(() => {
      if (this.child === child) this.ready = null;
    });
    return this.ready;
  }
}

/** Spawn `python chatterbox_tts.py serve` with the given environment. */
export function spawnChatterbox(
  python: string,
  script: string,
  cwd: string,
  env: Record<string, string>,
): SpawnSpeech {
  return () =>
    spawn(python, [script, "serve"], {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
}
