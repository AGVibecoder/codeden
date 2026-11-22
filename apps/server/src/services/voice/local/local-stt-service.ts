import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  isoLanguage,
  type LocalSttStatus,
  type SttResponse,
  type WhisperModelId,
} from "@codeden/contracts";
import type { SettingsStore } from "../../../settings-store";
import { errorMessage, ServiceError } from "../../errors";
import { type GpuInfo, pickGpu, windowsAdapterNames } from "../gpu";
import {
  currentPlatform,
  GPU_RUNTIME_PINS,
  MODEL_PINS,
  type ModelPin,
  RUNTIME_PINS,
  type RuntimePin,
  WHISPER_RUNTIME_VERSION,
} from "./catalog";
import { downloadVerified, partialPath } from "./download";
import { isMadeUp } from "./hallucinations";
import { type LoadWhisperRuntime, loadNativeRuntime, type WhisperModel } from "./runtime";
import { extractTgzEntry } from "./tgz";
import { parseWav } from "./wav";

export interface LocalSttServiceDeps {
  /** `<home>/deps/whisper`: the runtime, one folder per version and platform. */
  runtimeDir: string;
  /** `<home>/models/whisper`: downloaded models. */
  modelsDir: string;
  settings: SettingsStore;
  /** Overridable for tests (a local fake server and tiny fixture files). */
  fetch?: typeof fetch;
  platform?: string;
  runtimePins?: Record<string, RuntimePin>;
  /** Graphics card builds by platform (`GPU_RUNTIME_PINS`). */
  gpuRuntimePins?: Record<string, RuntimePin>;
  /** Finds a supported graphics card (Windows' display adapters by default). */
  detectGpu?: () => Promise<GpuInfo>;
  models?: ModelPin[];
  loadRuntime?: LoadWhisperRuntime;
  /** Unload the model after this long without use (default 10 minutes). */
  idleUnloadMs?: number;
  log?: (message: string) => void;
}

interface Job {
  received: number;
  abort: AbortController;
  promise: Promise<void>;
}

const RUNTIME = "runtime";

/** 16-bit mono PCM at 16 kHz, padded with silence to at least one second. */
function atLeastOneSecond(pcm: ArrayBuffer): ArrayBuffer {
  const second = 16_000 * 2;
  if (pcm.byteLength >= second) return pcm;
  const padded = new Uint8Array(second);
  padded.set(new Uint8Array(pcm));
  return padded.buffer;
}

/**
 * Strip Whisper's non-speech markers such as `[BLANK_AUDIO]` or `(silence)`, and drop a
 * transcript that is only a sentence Whisper makes up for silence ("This is the end of the
 * video.", `isMadeUp`).
 */
export function cleanTranscript(text: string): string {
  const cleaned = text
    .replace(/\[[^\]]*\]|\((?:silence|blank[ _]audio|music|inaudible|noise)[^)]*\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return isMadeUp(cleaned) ? "" : cleaned;
}

/** Stop waiting for `promise` when `signal` aborts (the work itself carries on). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** Why the prebuilt runtime cannot load on this Linux (it needs glibc 2.34 or newer). */
function linuxProblem(): string | null {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
  const glibc = report?.header?.glibcVersionRuntime;
  if (!glibc) return "Local Whisper needs a glibc-based Linux (musl is not supported)";
  const [major = 0, minor = 0] = glibc.split(".").map(Number);
  return major > 2 || (major === 2 && minor >= 34)
    ? null
    : `Local Whisper needs glibc 2.34 or newer (this system has ${glibc})`;
}

/**
 * Local Whisper (§11.3): downloads the runtime and models into the CodeDen home on demand,
 * with progress, resume and checksum checks, and transcribes uploaded WAV audio in the
 * server process. Downloads run in the background; the UI polls `status()`.
 */
export class LocalSttService {
  private readonly platform: string;
  private readonly runtimePin: RuntimePin | undefined;
  private readonly gpuPin: RuntimePin | undefined;
  /** The graphics card check, once started; `gpu` null when no supported card was found. */
  private gpuCheck: Promise<GpuInfo> | null = null;
  private gpu: GpuInfo | null = null;
  /** The graphics card build failed to load here: the processor build is used instead. */
  private gpuFailed = false;
  private readonly models: ModelPin[];
  private readonly problem: string | null;
  private readonly jobs = new Map<string, Job>();
  private readonly errors = new Map<string, string>();
  /** The loaded model, and whether it runs on the graphics card build. */
  private loaded: { id: WhisperModelId; model: WhisperModel; onGpu: boolean } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: LocalSttServiceDeps) {
    this.platform = deps.platform ?? currentPlatform();
    this.runtimePin = (deps.runtimePins ?? RUNTIME_PINS)[this.platform];
    this.gpuPin = (deps.gpuRuntimePins ?? GPU_RUNTIME_PINS)[this.platform];
    this.models = deps.models ?? MODEL_PINS;
    this.problem = !this.runtimePin
      ? `No prebuilt Whisper runtime for ${this.platform}`
      : !deps.platform && process.platform === "linux"
        ? linuxProblem()
        : null;
    if (this.gpuPin) void this.checkGpu();
  }

  /**
   * Look for a supported graphics card (only where a graphics card build exists). A check that
   * found no display adapter at all failed (it timed out on a busy machine), so it isn't kept:
   * the next transcription asks again instead of using the processor for the whole run.
   */
  private checkGpu(): Promise<GpuInfo> {
    if (!this.gpuPin) return Promise.resolve({ gpu: null, name: null });
    if (this.gpu?.gpu) return Promise.resolve(this.gpu);
    this.gpuCheck ??= (this.deps.detectGpu ?? (() => windowsAdapterNames().then(pickGpu)))()
      .catch((): GpuInfo => ({ gpu: null, name: null }))
      .then((info) => {
        this.gpu = info;
        if (!info.name) {
          this.gpuCheck = null;
          this.deps.log?.("Whisper: the graphics card check found no display adapter; retrying");
        }
        return info;
      });
    return this.gpuCheck;
  }

  /** The build to use: the graphics card one when a card was found and it loads, else the processor one. */
  private activePin(): RuntimePin | undefined {
    return this.gpuPin && this.gpu?.gpu && !this.gpuFailed ? this.gpuPin : this.runtimePin;
  }

  private addonPath(pin: RuntimePin | undefined = this.activePin()): string {
    const version = pin?.version ?? WHISPER_RUNTIME_VERSION;
    const variant = pin?.variant ? `-${pin.variant}` : "";
    return join(this.deps.runtimeDir, `${version}-${this.platform}${variant}`, "whisper.node");
  }

  private modelPath(pin: ModelPin): string {
    return join(this.deps.modelsDir, pin.file);
  }

  /** A model by id; one no longer offered (an older setting) is the model offered now. */
  private pin(id: WhisperModelId): ModelPin {
    const pin = this.models.find((m) => m.id === id) ?? this.models[0];
    if (!pin) throw new ServiceError(404, "unknown_model", `Unknown Whisper model: ${id}`);
    return pin;
  }

  private runtimeInstalled(pin: RuntimePin | undefined = this.activePin()): boolean {
    return existsSync(this.addonPath(pin));
  }

  private modelInstalled(pin: ModelPin): boolean {
    return fileSize(this.modelPath(pin)) === pin.bytes;
  }

  status(): LocalSttStatus {
    const entry = (key: string, total: number, installedPath: string | null, partial: string) => {
      const job = this.jobs.get(key);
      const sizeOnDisk = installedPath ? fileSize(installedPath) : null;
      const state = job
        ? "downloading"
        : sizeOnDisk !== null
          ? "installed"
          : this.errors.has(key)
            ? "failed"
            : "missing";
      return {
        state,
        // A stopped download keeps its partial file and resumes from there.
        receivedBytes: job?.received ?? (state === "installed" ? total : (fileSize(partial) ?? 0)),
        totalBytes: total,
        sizeOnDisk,
        error: state === "failed" ? (this.errors.get(key) ?? null) : null,
      } as const;
    };
    const runtime = this.activePin();
    const onGpu = Boolean(runtime?.variant);
    return {
      supported: this.problem === null,
      platform: this.platform,
      unsupportedReason: this.problem,
      runtime: {
        version: runtime?.version ?? WHISPER_RUNTIME_VERSION,
        accelerator: this.gpuPin && !this.gpu ? null : onGpu ? "gpu" : "cpu",
        device: onGpu ? (this.gpu?.name ?? null) : null,
        ...entry(
          this.runtimeKey(runtime),
          runtime?.bytes ?? 0,
          this.runtimeInstalled(runtime) ? this.addonPath(runtime) : null,
          partialPath(this.archivePath(runtime)),
        ),
      },
      models: this.models.map((m) => ({
        id: m.id,
        label: m.label,
        hint: m.hint,
        englishOnly: m.englishOnly,
        recommended: m.recommended,
        ...entry(
          m.id,
          m.bytes,
          this.modelInstalled(m) ? this.modelPath(m) : null,
          partialPath(this.modelPath(m)),
        ),
      })),
      location: this.deps.modelsDir,
    };
  }

  /** Start (or join) downloading the runtime and a model; returns right away. */
  download(id: WhisperModelId): LocalSttStatus {
    if (this.problem) throw new ServiceError(409, "unsupported_platform", this.problem);
    const pin = this.pin(id);
    if (!this.jobs.has(pin.id) && !(this.runtimeInstalled() && this.modelInstalled(pin))) {
      this.track(pin.id, async (signal, progress) => {
        // Which build to fetch depends on the graphics card check.
        await abortable(this.checkGpu(), signal);
        await abortable(this.ensureRuntime(this.activePin()), signal);
        if (this.modelInstalled(pin)) return;
        await downloadVerified({
          file: pin,
          dest: this.modelPath(pin),
          fetch: this.deps.fetch,
          signal,
          onProgress: progress,
        });
        this.deps.log?.(`Whisper model ${pin.id} downloaded`);
      }).catch(() => {});
    }
    return this.status();
  }

  /** Cancel a running download or delete a downloaded model (and its partial file). */
  async remove(id: WhisperModelId): Promise<LocalSttStatus> {
    const pin = this.pin(id);
    const job = this.jobs.get(pin.id);
    if (job) {
      job.abort.abort();
      await job.promise.catch(() => {});
    }
    // Wait for a transcription that is using the model before freeing it.
    if (this.loaded?.id === pin.id) await this.serially(() => this.unload());
    rmSync(this.modelPath(pin), { force: true });
    rmSync(partialPath(this.modelPath(pin)), { force: true });
    this.errors.delete(pin.id);
    return this.status();
  }

  /** Transcribe a WAV upload with the model chosen in Settings. */
  async transcribe(
    audio: Uint8Array,
    opts: {
      language?: string | null;
      /**
       * Without `language`: the languages you speak, main one first. With several, Whisper
       * detects the language, and a segment it hears as another language is transcribed again
       * in the main one.
       */
      languages?: string[];
      signal?: AbortSignal;
    } = {},
  ): Promise<SttResponse> {
    if (this.problem) throw new ServiceError(409, "unsupported_platform", this.problem);
    // Whisper's encoder works on at least a second: a very short phrase gets silence after it.
    const pcm = atLeastOneSecond(parseWav(audio).pcm);
    const pin = this.pin(this.deps.settings.get().voice.dictation.local.model);
    // Wait for the graphics card check, however long it takes: deciding before it answers
    // would run the model on the processor, many times slower.
    await this.checkGpu();
    // A card found later than the download: fetch its build (about 13 MB) instead of the processor's.
    const active = this.activePin();
    if (active?.variant && !this.runtimeInstalled(active) && this.modelInstalled(pin)) {
      await this.ensureRuntime(active);
    }
    if (!this.runtimeInstalled() || !this.modelInstalled(pin)) {
      throw new ServiceError(
        409,
        "model_not_installed",
        `The ${pin.label} Whisper model isn't downloaded yet. Download it in Settings > Voice.`,
      );
    }
    const allowed = [
      ...new Set((opts.languages ?? []).map(isoLanguage).filter((l): l is string => Boolean(l))),
    ];
    const language = pin.englishOnly
      ? "en"
      : (isoLanguage(opts.language) ?? (allowed.length === 1 ? allowed[0] : null) ?? "auto");
    return this.serially(async () => {
      const model = await this.model(pin);
      const started = performance.now();
      try {
        let result = await model.transcribe(pcm, { language, signal: opts.signal });
        // Heard as a language you don't speak (Dutch taken for German): your main language.
        const main = allowed[0];
        if (
          language === "auto" &&
          main &&
          allowed.length > 1 &&
          result.language &&
          !allowed.includes(result.language.toLowerCase())
        ) {
          result = await model.transcribe(pcm, { language: main, signal: opts.signal });
          result = { ...result, language: main };
        }
        return {
          text: cleanTranscript(result.text),
          language: result.language ?? (language === "auto" ? null : language),
          engine: "local" as const,
          elapsedMs: Math.round(performance.now() - started),
        };
      } catch (error) {
        if (opts.signal?.aborted) throw new ServiceError(400, "aborted", "Cancelled");
        throw new ServiceError(500, "transcription_failed", errorMessage(error));
      } finally {
        this.armIdleUnload();
      }
    });
  }

  /** Resolves when no download is running (tests). */
  async settled(): Promise<void> {
    while (this.jobs.size > 0) {
      await Promise.allSettled([...this.jobs.values()].map((j) => j.promise));
    }
  }

  /** Cancel downloads and free the model (server shutdown). */
  async stop(): Promise<void> {
    for (const job of this.jobs.values()) job.abort.abort();
    await this.settled();
    await this.unload();
  }

  private archivePath(pin: RuntimePin | undefined = this.activePin()): string {
    const name = pin?.url.split("/").pop() ?? "runtime.tgz";
    return join(this.deps.runtimeDir, ".downloads", name);
  }

  /** The download key of a build: `runtime`, or `runtime-vulkan` for the graphics card one. */
  private runtimeKey(pin: RuntimePin | undefined): string {
    return pin?.variant ? `${RUNTIME}-${pin.variant}` : RUNTIME;
  }

  private ensureRuntime(pin: RuntimePin | undefined): Promise<void> {
    if (!pin) return Promise.reject(new Error(this.problem ?? "No runtime"));
    if (this.runtimeInstalled(pin)) return Promise.resolve();
    return this.track(this.runtimeKey(pin), async (signal, progress) => {
      const archive = this.archivePath(pin);
      await downloadVerified({
        file: pin,
        dest: archive,
        fetch: this.deps.fetch,
        signal,
        onProgress: progress,
      });
      const addon = extractTgzEntry(readFileSync(archive), pin.entry);
      const target = this.addonPath(pin);
      mkdirSync(join(target, ".."), { recursive: true });
      const staging = `${target}.tmp`;
      writeFileSync(staging, addon, { mode: 0o755 });
      renameSync(staging, target);
      rmSync(archive, { force: true });
      this.deps.log?.(
        `Whisper runtime ${pin.version}${pin.variant ? ` (${pin.variant})` : ""} installed for ${this.platform}`,
      );
    });
  }

  /** Run one download at a time per key; callers join a running one. */
  private track(
    key: string,
    work: (signal: AbortSignal, progress: (received: number) => void) => Promise<void>,
  ): Promise<void> {
    const running = this.jobs.get(key);
    if (running) return running.promise;
    const abort = new AbortController();
    const job: Job = { received: 0, abort, promise: Promise.resolve() };
    this.errors.delete(key);
    job.promise = work(abort.signal, (received) => {
      job.received = received;
    })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) {
          this.errors.set(key, errorMessage(error));
          this.deps.log?.(`Whisper download (${key}) failed: ${errorMessage(error)}`);
        }
        throw error;
      })
      .finally(() => this.jobs.delete(key));
    this.jobs.set(key, job);
    return job.promise;
  }

  private serially<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private async model(pin: ModelPin): Promise<WhisperModel> {
    clearTimeout(this.idleTimer);
    const active = this.activePin();
    // A model loaded on the processor before the graphics card was found is loaded again on it.
    if (this.loaded?.id === pin.id && (this.loaded.onGpu || !active?.variant)) {
      return this.loaded.model;
    }
    await this.unload();
    const load = async (runtimePin: RuntimePin | undefined) => {
      const runtime = await (this.deps.loadRuntime ?? loadNativeRuntime)(
        this.addonPath(runtimePin),
      );
      return runtime.loadModel(this.modelPath(pin));
    };
    let model: WhisperModel;
    let onGpu = Boolean(active?.variant);
    try {
      model = await load(active);
    } catch (error) {
      // The graphics card build didn't load (no Vulkan driver, an unsupported card): use the
      // processor build, fetching it first (about 1 MB) if needed.
      if (!active?.variant) throw error;
      this.gpuFailed = true;
      this.deps.log?.(
        `Whisper on the graphics card failed, using the processor: ${errorMessage(error)}`,
      );
      await this.ensureRuntime(this.runtimePin);
      model = await load(this.runtimePin);
      onGpu = false;
    }
    this.loaded = { id: pin.id, model, onGpu };
    return model;
  }

  private armIdleUnload(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => void this.serially(() => this.unload()),
      this.deps.idleUnloadMs ?? 10 * 60_000,
    );
    this.idleTimer.unref();
  }

  private async unload(): Promise<void> {
    clearTimeout(this.idleTimer);
    const current = this.loaded;
    this.loaded = null;
    await current?.model.release().catch(() => {});
  }
}
