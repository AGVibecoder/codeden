import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CHATTERBOX_VOICE_MAX_SECONDS,
  CHATTERBOX_VOICE_MIN_SECONDS,
  type ChatterboxInstallRequest,
  type ChatterboxModel,
  type ChatterboxPartState,
  type ChatterboxSpeakRequest,
  type ChatterboxStatus,
  chatterboxModelFor,
} from "@codeden/contracts";
import { badRequest, conflict, errorMessage } from "../../errors";
import { type GpuInfo, pickGpu, windowsAdapterNames } from "./gpu";
import {
  type ChatterboxPaths,
  chatterboxEnv,
  chatterboxPaths,
  type InstallContext,
  installModel,
  installRuntime,
  type RunProgram,
} from "./install";
import { ChatterboxSpeech, type SpawnSpeech, spawnChatterbox } from "./speech";
import { ChatterboxVoices } from "./voices";

/**
 * CodeDen's Chatterbox files: `dist/chatterbox` next to the bundle, or `apps/server/chatterbox`
 * in the workspace (`chatterbox_tts.py` and `voices/annie.wav`).
 */
export function findChatterboxDir(explicit?: string): string | null {
  const here = import.meta.dirname;
  const candidates = [
    explicit,
    resolve(here, "chatterbox"),
    resolve(here, "../../../../chatterbox"),
  ];
  return (
    candidates.find(
      (c): c is string => Boolean(c) && existsSync(join(c as string, "chatterbox_tts.py")),
    ) ?? null
  );
}

export interface ChatterboxServiceDeps {
  /** `<home>/deps/chatterbox`. */
  baseDir: string;
  /** Overridable for tests. */
  assetsDir?: string | null;
  platform?: NodeJS.Platform;
  detectGpu?: () => Promise<GpuInfo>;
  run?: RunProgram;
  spawn?: SpawnSpeech;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

/** How long one spoken text may take, the first model load included. */
const SPEAK_TIMEOUT_MS = 10 * 60_000;

/**
 * Chatterbox read aloud (§11.3): installs Python, PyTorch for the graphics card, Chatterbox and
 * the model a language needs into the CodeDen home, and speaks text with a voice clip. Windows
 * with an NVIDIA or AMD Radeon card only, for now; installs run in the background and the UI
 * polls `status()`.
 */
export class ChatterboxService {
  readonly paths: ChatterboxPaths;
  private readonly assets: string | null;
  private readonly voices: ChatterboxVoices;
  private readonly speech: ChatterboxSpeech;
  private gpu: Promise<GpuInfo> | null = null;
  private job: { target: ChatterboxModel; runtime: boolean; promise: Promise<void> } | null = null;
  private abort: AbortController | null = null;
  private progress: { step: string | null; detail: string | null } = { step: null, detail: null };
  private errors: { runtime?: string; turbo?: string; multilingual?: string } = {};

  constructor(private readonly deps: ChatterboxServiceDeps) {
    this.paths = chatterboxPaths(deps.baseDir);
    this.assets = deps.assetsDir === undefined ? findChatterboxDir() : deps.assetsDir;
    this.voices = new ChatterboxVoices(
      this.paths.voices,
      this.assets ? join(this.assets, "voices", "annie.wav") : null,
    );
    this.speech = new ChatterboxSpeech({
      spawn:
        deps.spawn ??
        spawnChatterbox(this.paths.python, this.script, this.paths.base, chatterboxEnv(this.paths)),
      log: deps.log,
    });
  }

  private get script(): string {
    return this.assets ? join(this.assets, "chatterbox_tts.py") : "chatterbox_tts.py";
  }

  private detect(): Promise<GpuInfo> {
    if (!this.gpu) {
      this.gpu = this.deps.detectGpu ? this.deps.detectGpu() : windowsAdapterNames().then(pickGpu);
    }
    return this.gpu;
  }

  private runtimeInstalled(): boolean {
    return existsSync(this.paths.runtimeMarker) && existsSync(this.paths.python);
  }

  private modelInstalled(model: ChatterboxModel): boolean {
    return existsSync(this.paths.modelMarker(model));
  }

  async status(): Promise<ChatterboxStatus> {
    const platform = this.deps.platform ?? process.platform;
    const gpu = platform === "win32" ? await this.detect() : { gpu: null, name: null };
    const unsupportedReason =
      platform !== "win32"
        ? "Chatterbox runs on Windows for now"
        : !this.assets
          ? "CodeDen's Chatterbox files are missing from this install"
          : !gpu.gpu
            ? `Chatterbox needs an NVIDIA or AMD Radeon graphics card${gpu.name ? ` (found: ${gpu.name})` : ""}`
            : null;
    const job = this.job;
    const state = (part: "runtime" | ChatterboxModel, installed: boolean): ChatterboxPartState => {
      const busy = job && (part === "runtime" ? job.runtime : job.target === part);
      if (busy) return "installing";
      if (installed) return "installed";
      return this.errors[part] ? "failed" : "missing";
    };
    return {
      supported: unsupportedReason === null,
      unsupportedReason,
      gpu: gpu.gpu,
      gpuName: gpu.name,
      runtime: state("runtime", this.runtimeInstalled()),
      models: {
        turbo: state("turbo", this.modelInstalled("turbo")),
        multilingual: state("multilingual", this.modelInstalled("multilingual")),
      },
      step: job ? this.progress.step : null,
      detail: job ? this.progress.detail : null,
      error: job
        ? null
        : (this.errors.runtime ?? this.errors.turbo ?? this.errors.multilingual ?? null),
      voices: this.voices.list(),
      location: this.paths.base,
    };
  }

  /** Start (or join) installing the runtime when missing, then `model`; returns right away. */
  async install(req: ChatterboxInstallRequest): Promise<ChatterboxStatus> {
    const status = await this.status();
    if (!status.supported || !status.gpu) {
      throw conflict(status.unsupportedReason ?? "Chatterbox isn't supported here", "unsupported");
    }
    if (this.job) return status;
    const gpu = status.gpu;
    const runtime = !this.runtimeInstalled();
    if (!runtime && this.modelInstalled(req.model)) return status;
    this.errors = {};
    this.abort = new AbortController();
    const ctx: InstallContext = {
      paths: this.paths,
      script: this.script,
      signal: this.abort.signal,
      report: (step, detail) => {
        this.progress = { step, detail };
      },
      run: this.deps.run,
      fetch: this.deps.fetch,
    };
    const job = { target: req.model, runtime, promise: Promise.resolve() };
    job.promise = (async () => {
      try {
        if (runtime) {
          this.speech.stop();
          await installRuntime(ctx, gpu);
          job.runtime = false;
        }
        if (!this.modelInstalled(req.model)) await installModel(ctx, req.model);
      } catch (error) {
        const message = errorMessage(error);
        this.deps.log?.(`chatterbox install: ${message}`);
        if (job.runtime) this.errors.runtime = message;
        else this.errors[req.model] = message;
      } finally {
        this.job = null;
        this.abort = null;
        this.progress = { step: null, detail: null };
      }
    })();
    this.job = job;
    return this.status();
  }

  /** WAV audio of `text`, in the voice and with the model the language needs. */
  async speak(req: ChatterboxSpeakRequest): Promise<Uint8Array<ArrayBuffer>> {
    const model = chatterboxModelFor(req.language);
    if (!this.runtimeInstalled()) throw conflict("Install Chatterbox first", "not_installed");
    if (!this.modelInstalled(model)) {
      throw conflict(
        `Install Chatterbox ${model === "turbo" ? "Turbo (English)" : "Multilingual"} first`,
        "model_missing",
      );
    }
    const out = join(this.paths.base, "out");
    mkdirSync(out, { recursive: true });
    const file = join(out, `${randomUUID()}.wav`);
    try {
      await this.speech.request(
        {
          op: "speak",
          text: req.text,
          lang: req.language,
          voice: this.voices.path(req.voice),
          out: file,
        },
        SPEAK_TIMEOUT_MS,
      );
      return new Uint8Array(readFileSync(file));
    } catch (error) {
      throw badRequest(friendly(errorMessage(error)), "speech_failed");
    } finally {
      rmSync(file, { force: true });
    }
  }

  /** Add a voice clip after checking its length; returns the new status. */
  async addVoice(name: string, bytes: Uint8Array, fileName: string): Promise<ChatterboxStatus> {
    if (!this.runtimeInstalled()) throw conflict("Install Chatterbox first", "not_installed");
    const added = this.voices.add(name, bytes, fileName);
    let seconds: number;
    try {
      seconds = Number(await this.speech.request({ op: "probe", path: added.path }, 120_000));
    } catch (error) {
      this.voices.remove(added.id);
      throw badRequest(`That sound file can't be read: ${errorMessage(error)}`, "bad_voice_file");
    }
    if (
      !Number.isFinite(seconds) ||
      seconds < CHATTERBOX_VOICE_MIN_SECONDS ||
      seconds > CHATTERBOX_VOICE_MAX_SECONDS
    ) {
      this.voices.remove(added.id);
      throw badRequest(
        `A voice clip has to be ${CHATTERBOX_VOICE_MIN_SECONDS} to ${CHATTERBOX_VOICE_MAX_SECONDS} seconds of speech (this one is ${Number.isFinite(seconds) ? seconds.toFixed(1) : "?"} s)`,
        "voice_length",
      );
    }
    return this.status();
  }

  async removeVoice(id: string): Promise<ChatterboxStatus> {
    this.voices.remove(id);
    return this.status();
  }

  /** Stop the speech process and any install (server shutdown). */
  close(): void {
    this.abort?.abort();
    this.speech.stop();
  }
}

/** Chatterbox's own wording where it is unclear. */
function friendly(message: string): string {
  if (/longer than 5 seconds/i.test(message)) {
    return "The voice clip is too short: use more than 5 seconds of speech";
  }
  return message;
}
