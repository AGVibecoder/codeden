import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ensureServerStarted } from "../src/mcp/start-command";
import type { SpawnServer } from "../src/mcp/stdio-transport";

/** A child process that reports `spawn` (or `error`) on the next tick, and records its call. */
function fakeSpawn(fail?: Error) {
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  let unrefs = 0;
  const spawn: SpawnServer = (command, args, options) => {
    calls.push({ command, args, options: options as Record<string, unknown> });
    const child = new EventEmitter() as ChildProcess;
    child.unref = () => {
      unrefs++;
    };
    queueMicrotask(() => (fail ? child.emit("error", fail) : child.emit("spawn")));
    return child;
  };
  return { spawn, calls, unrefs: () => unrefs };
}

/** A clock that only moves when the code under test sleeps. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const base = {
  url: new URL("http://127.0.0.1:8000/mcp"),
  start: { command: "editor", args: ["project.file"] },
  cwd: "/work",
  env: { PATH: "/bin" },
  waitMs: 10_000,
};

describe("ensureServerStarted", () => {
  it("does nothing when the address already answers", async () => {
    const { spawn, calls } = fakeSpawn();
    const probed: [string, number][] = [];
    const started = await ensureServerStarted({
      ...base,
      spawn,
      probe: async (host, port) => {
        probed.push([host, port]);
        return true;
      },
    });
    expect(started).toBe(false);
    expect(calls).toHaveLength(0);
    expect(probed).toEqual([["127.0.0.1", 8000]]);
  });

  it("starts the command on its own and waits until the address answers", async () => {
    const { spawn, calls, unrefs } = fakeSpawn();
    let probes = 0;
    const started = await ensureServerStarted({
      ...base,
      spawn,
      ...fakeClock(),
      probe: async () => ++probes > 3,
    });
    expect(started).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "editor",
      args: ["project.file"],
      options: { cwd: "/work", env: { PATH: "/bin" }, detached: true, stdio: "ignore" },
    });
    expect(unrefs()).toBe(1);
  });

  it("fails when nothing answers in time", async () => {
    const { spawn } = fakeSpawn();
    await expect(
      ensureServerStarted({ ...base, spawn, ...fakeClock(), probe: async () => false }),
    ).rejects.toThrow(/nothing answered on 127\.0\.0\.1:8000 within 10 s/);
  });

  it("fails when the command can't be started", async () => {
    const { spawn } = fakeSpawn(new Error("spawn editor ENOENT"));
    await expect(
      ensureServerStarted({ ...base, spawn, ...fakeClock(), probe: async () => false }),
    ).rejects.toThrow(/Start command failed: spawn editor ENOENT/);
  });

  it("uses the scheme's port when the URL has none", async () => {
    const probed: [string, number][] = [];
    await ensureServerStarted({
      ...base,
      url: new URL("https://localhost/mcp"),
      probe: async (host, port) => {
        probed.push([host, port]);
        return true;
      },
    });
    expect(probed).toEqual([["localhost", 443]]);
  });
});
