import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceError } from "../src/services/errors";
import { ChatterboxService } from "../src/services/voice/chatterbox/chatterbox-service";
import { pickGpu } from "../src/services/voice/chatterbox/gpu";
import { chatterboxPaths, type RunProgram } from "../src/services/voice/chatterbox/install";
import { ChatterboxSpeech } from "../src/services/voice/chatterbox/speech";
import { removeTree } from "./support/remove-tree";

/** A speech process that answers each request through `answer`. */
function fakeProcess(answer: (req: Record<string, unknown>) => string): () => ChildProcess {
  return () => {
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr: new PassThrough(), kill: () => true });
    let buffer = "";
    stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const req = JSON.parse(line) as Record<string, unknown>;
        stdout.write(`${answer(req)}\n`);
      }
    });
    setImmediate(() => stdout.write("ready\n"));
    return child;
  };
}

describe("pickGpu", () => {
  it("prefers NVIDIA, then AMD Radeon, and supports nothing else", () => {
    expect(pickGpu(["Intel(R) UHD Graphics", "NVIDIA GeForce RTX 4070", ""])).toEqual({
      gpu: "nvidia",
      name: "NVIDIA GeForce RTX 4070",
    });
    expect(pickGpu(["AMD Radeon RX 7900 XTX"])).toEqual({
      gpu: "amd",
      name: "AMD Radeon RX 7900 XTX",
    });
    expect(pickGpu(["Intel(R) Arc A770"])).toEqual({ gpu: null, name: "Intel(R) Arc A770" });
    expect(pickGpu([])).toEqual({ gpu: null, name: null });
  });
});

describe("ChatterboxSpeech", () => {
  it("matches answers to requests and passes errors on", async () => {
    const speech = new ChatterboxSpeech({
      spawn: fakeProcess((req) =>
        req.op === "probe" ? `ok ${req.id} 9.50` : `err ${req.id} The voice file is missing`,
      ),
    });
    expect(await speech.request({ op: "probe", path: "a.wav" }, 5_000)).toBe("9.50");
    await expect(speech.request({ op: "speak", text: "Hi" }, 5_000)).rejects.toThrow(
      "The voice file is missing",
    );
    speech.stop();
  });
});

describe("ChatterboxService", () => {
  let dir: string;
  let assets: string;
  let calls: string[][];
  const run: RunProgram = async (command, args, _opts, onLine) => {
    calls.push([command, ...args]);
    if (args.includes("check")) onLine("ok 2.9.1 AMD Radeon RX 7900 XTX");
    return 0;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codeden-chatterbox-"));
    assets = join(dir, "assets");
    mkdirSync(join(assets, "voices"), { recursive: true });
    writeFileSync(join(assets, "chatterbox_tts.py"), "");
    writeFileSync(join(assets, "voices", "annie.wav"), "RIFF");
    calls = [];
  });
  afterEach(() => removeTree(dir));

  const service = (over: Partial<ConstructorParameters<typeof ChatterboxService>[0]> = {}) =>
    new ChatterboxService({
      baseDir: join(dir, "chatterbox"),
      assetsDir: assets,
      platform: "win32",
      detectGpu: async () => ({ gpu: "amd", name: "AMD Radeon RX 7900 XTX" }),
      run,
      ...over,
    });

  /** Pretend uv is already there, so no download happens. */
  const fakeUv = (base: string) => {
    const paths = chatterboxPaths(base);
    mkdirSync(paths.uvDir, { recursive: true });
    writeFileSync(paths.uv, "");
    mkdirSync(join(paths.venv, "Scripts"), { recursive: true });
    writeFileSync(paths.python, "");
    return paths;
  };

  it("says why Chatterbox can't run without a supported card or off Windows", async () => {
    const noCard = await service({
      detectGpu: async () => ({ gpu: null, name: "Intel Arc" }),
    }).status();
    expect(noCard).toMatchObject({ supported: false, gpu: null });
    expect(noCard.unsupportedReason).toContain("Intel Arc");
    expect((await service({ platform: "linux" }).status()).unsupportedReason).toContain("Windows");
  });

  it("installs AMD's PyTorch, Chatterbox and the model in order", async () => {
    const svc = service();
    const paths = fakeUv(svc.paths.base);
    expect((await svc.install({ model: "multilingual" })).runtime).toBe("installing");
    await expect.poll(async () => (await svc.status()).models.multilingual).toBe("installed");
    const steps = calls.map((c) => c.slice(1).join(" "));
    expect(steps[0]).toBe("python install 3.12");
    expect(steps[1]).toContain("rocm7.2.1"); // PyTorch for AMD
    expect(steps[2]).toContain("--no-deps chatterbox-tts==0.1.7");
    expect(steps.some((s) => s.endsWith("check"))).toBe(true);
    expect(steps.at(-1)).toMatch(/download multilingual$/);
    expect(existsSync(paths.runtimeMarker)).toBe(true);
    expect((await svc.status()).models.turbo).toBe("missing");
  });

  it("installs NVIDIA's PyTorch for an NVIDIA card", async () => {
    const svc = service({ detectGpu: async () => ({ gpu: "nvidia", name: "RTX 4070" }) });
    fakeUv(svc.paths.base);
    await svc.install({ model: "turbo" });
    await expect.poll(async () => (await svc.status()).models.turbo).toBe("installed");
    expect(calls.map((c) => c.join(" ")).some((c) => c.includes("whl/cu128"))).toBe(true);
  });

  it("reports a failed step and lets the next install try again", async () => {
    let fail = true;
    const svc = service({
      run: async (command, args, opts, onLine) => {
        if (fail && args.includes("chatterbox-tts==0.1.7")) {
          onLine("No matching distribution");
          return 1;
        }
        return run(command, args, opts, onLine);
      },
    });
    fakeUv(svc.paths.base);
    await svc.install({ model: "turbo" });
    await expect.poll(async () => (await svc.status()).runtime).toBe("failed");
    expect((await svc.status()).error).toContain("No matching distribution");
    fail = false;
    await svc.install({ model: "turbo" });
    await expect.poll(async () => (await svc.status()).models.turbo).toBe("installed");
  });

  it("asks for the install before speaking", async () => {
    const error = await service()
      .speak({ text: "Hi", language: "en" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("not_installed");
  });

  it("keeps a voice clip of the right length and refuses a short one", async () => {
    // The first clip is 12 seconds long, every later one 3 (stored clips are named by id).
    let probes = 0;
    const svc = service({
      spawn: fakeProcess((req) => `ok ${req.id} ${++probes === 1 ? "12.0" : "3.0"}`),
    });
    const paths = fakeUv(svc.paths.base);
    writeFileSync(paths.runtimeMarker, "{}");
    const status = await svc.addVoice("Mine", new Uint8Array([1, 2, 3]), "me.wav");
    expect(status.voices.map((v) => v.name)).toEqual(["Annie", "Mine"]);
    const short = await svc
      .addVoice("Short", new Uint8Array([1]), "short.wav")
      .catch((e: unknown) => e);
    expect((short as ServiceError).code).toBe("voice_length");
    expect((await svc.status()).voices).toHaveLength(2);
    await expect(svc.addVoice("Bad", new Uint8Array([1]), "me.m4a")).rejects.toThrow(/WAV|\.wav/);
    svc.close();
  });
});
