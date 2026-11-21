import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatterboxGpu, ChatterboxModel } from "@codeden/contracts";
import { downloadVerified } from "../local/download";
import {
  CHATTERBOX_PACKAGE,
  CHATTERBOX_REQUIREMENTS,
  MODEL_LABELS,
  PYTHON_VERSION,
  TORCH,
  UV_PINS,
  UV_VERSION,
} from "./catalog";

/** Where everything Chatterbox needs lives, inside `<home>/deps/chatterbox`. */
export function chatterboxPaths(base: string) {
  const venv = join(base, "venv");
  return {
    base,
    uvDir: join(base, "uv", UV_VERSION),
    uv: join(base, "uv", UV_VERSION, "uv.exe"),
    pythonDir: join(base, "python"),
    venv,
    python: join(venv, "Scripts", "python.exe"),
    runtimeMarker: join(base, "runtime.json"),
    modelMarker: (model: ChatterboxModel) => join(base, "models", `${model}.done`),
    constraints: join(base, "constraints.txt"),
    log: join(base, "install.log"),
    hfHome: join(base, "hf"),
    cache: join(base, "cache"),
    voices: join(base, "voices"),
  };
}
export type ChatterboxPaths = ReturnType<typeof chatterboxPaths>;

/** The environment every Chatterbox process gets: caches in CodeDen's folder, nothing of its own secrets. */
export function chatterboxEnv(paths: ChatterboxPaths): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.toUpperCase().startsWith("CODEDEN_")) env[key] = value;
  }
  return {
    ...env,
    HF_HOME: paths.hfHome,
    HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
    PKUSEG_HOME: join(paths.cache, "pkuseg"),
    UV_CACHE_DIR: uvCache(paths),
    UV_PYTHON_INSTALL_DIR: paths.pythonDir,
    // PyTorch for AMD is one file of several GB from AMD's server, which can stall for longer
    // than uv's default 30 s; wait longer and try again before giving up.
    UV_HTTP_TIMEOUT: "600",
    UV_HTTP_RETRIES: "5",
    // AMD's MIOpen otherwise searches for the fastest method again for every new sound length.
    MIOPEN_FIND_MODE: "FAST",
    MIOPEN_USER_DB_PATH: join(paths.cache, "miopen"),
    MIOPEN_CUSTOM_CACHE_DIR: join(paths.cache, "miopen"),
    PYTHONIOENCODING: "utf-8",
  };
}

/** Runs one program, reporting each output line; resolves with its exit code. */
export type RunProgram = (
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; signal: AbortSignal },
  onLine: (line: string) => void,
) => Promise<number>;

export const runProgram: RunProgram = (command, args, opts, onLine) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      signal: opts.signal,
    });
    let rest = "";
    const read = (chunk: Buffer) => {
      const text = rest + chunk.toString("utf8");
      const lines = text.split(/\r?\n|\r/);
      rest = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line.trim());
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.once("error", reject);
    child.once("close", (code) => {
      if (rest.trim()) onLine(rest.trim());
      resolve(code ?? 1);
    });
  });

export interface InstallContext {
  paths: ChatterboxPaths;
  /** `chatterbox_tts.py`, shipped with CodeDen. */
  script: string;
  signal: AbortSignal;
  /** Shows what the install is doing (`step`) and its latest output line (`detail`). */
  report: (step: string | null, detail: string | null) => void;
  run?: RunProgram;
  fetch?: typeof fetch;
}

async function step(ctx: InstallContext, label: string, command: string, args: string[]) {
  const run = ctx.run ?? runProgram;
  const { paths } = ctx;
  ctx.report(label, null);
  appendFileSync(paths.log, `\n== ${label}\n> ${command} ${args.join(" ")}\n`);
  let last = "";
  const code = await run(
    command,
    args,
    { cwd: paths.base, env: chatterboxEnv(paths), signal: ctx.signal },
    (line) => {
      last = line;
      appendFileSync(paths.log, `${line}\n`);
      ctx.report(label, line.slice(0, 300));
    },
  );
  if (code !== 0) {
    throw new Error(`${label} failed${last ? `: ${last.slice(0, 300)}` : ""} (see ${paths.log})`);
  }
  return last;
}

/**
 * Install Python, PyTorch for `gpu`, Chatterbox and what it needs into the CodeDen home, then
 * check that PyTorch sees the graphics card. A finished install writes `runtime.json`; a
 * failed one leaves what it fetched, so trying again goes faster.
 */
export async function installRuntime(ctx: InstallContext, gpu: ChatterboxGpu): Promise<void> {
  const { paths } = ctx;
  mkdirSync(paths.base, { recursive: true });
  writeFileSync(paths.log, `Chatterbox install, ${new Date().toISOString()}, ${gpu}\n`);
  const pin = UV_PINS[process.arch];
  if (!pin) throw new Error(`No uv for ${process.arch} Windows`);
  if (!existsSync(paths.uv)) {
    ctx.report("Downloading the Python installer (15 MB)", null);
    const zip = join(paths.uvDir, "uv.zip");
    await downloadVerified({ file: pin, dest: zip, fetch: ctx.fetch, signal: ctx.signal });
    // Windows' own tar opens zip files.
    await step(ctx, "Unpacking the Python installer", "tar.exe", ["-xf", zip, "-C", paths.uvDir]);
    rmSync(zip, { force: true });
  }
  await step(ctx, `Installing Python ${PYTHON_VERSION}`, paths.uv, [
    "python",
    "install",
    PYTHON_VERSION,
  ]);
  if (!existsSync(paths.python)) {
    await step(ctx, "Making Chatterbox's Python environment", paths.uv, [
      "venv",
      "--python",
      PYTHON_VERSION,
      paths.venv,
    ]);
  }
  const torch = TORCH[gpu];
  const pip = (extra: string[]) => ["pip", "install", "--python", paths.python, ...extra];
  await step(ctx, `Installing ${torch.label}`, paths.uv, pip(torch.install));
  await step(ctx, "Installing Chatterbox", paths.uv, pip(["--no-deps", CHATTERBOX_PACKAGE]));
  writeFileSync(paths.constraints, `${torch.constraints.join("\n")}\n`);
  await step(
    ctx,
    "Installing what Chatterbox needs",
    paths.uv,
    pip(["-c", paths.constraints, ...CHATTERBOX_REQUIREMENTS]),
  );
  const check = await step(ctx, "Checking the graphics card", paths.python, [ctx.script, "check"]);
  writeFileSync(
    paths.runtimeMarker,
    `${JSON.stringify({ gpu, check, at: new Date().toISOString() }, null, 2)}\n`,
  );
  // uv's cache: mostly the installed files themselves under a second name (hard links, no
  // extra space), plus downloads it keeps only there (about 0.1 GB). Once the install works it
  // is never needed again; a failed install keeps it, so a retry goes faster.
  ctx.report("Cleaning up downloads", null);
  try {
    rmSync(uvCache(paths), { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A file still in use stays; the install itself is done.
  }
}

/** Where uv keeps its download cache (`UV_CACHE_DIR`). */
export const uvCache = (paths: ChatterboxPaths) => join(paths.cache, "uv");

/** Download a model into the Hugging Face cache in the CodeDen home; a marker says it is done. */
export async function installModel(ctx: InstallContext, model: ChatterboxModel): Promise<void> {
  const { paths } = ctx;
  await step(ctx, MODEL_LABELS[model], paths.python, [ctx.script, "download", model]);
  mkdirSync(join(paths.base, "models"), { recursive: true });
  writeFileSync(paths.modelMarker(model), `${new Date().toISOString()}\n`);
}
