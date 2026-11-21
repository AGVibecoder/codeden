import type { SpeechToText } from "./engines";

/**
 * What the orchestrator side of a call is doing: `listening` (waiting for you), `thinking` (a
 * message of yours is being worked on), `speaking` (an answer plays); `ended` once hung up. The
 * microphone is on in every phase but `ended`.
 */
export type CallPhase = "listening" | "thinking" | "speaking" | "ended";

export interface CallState {
  phase: CallPhase;
  /** What you said last (sent). */
  heard: string;
  /** What you are saying now, not sent yet. */
  draft: string;
  /** The orchestrator's last answer, as spoken. */
  reply: string;
  error: string | null;
}

export interface CallDeps {
  /** The dictation engine (browser or a server engine); runs for the whole call. */
  engine: SpeechToText;
  language?: string | null;
  /** Send what was said to the orchestrator (queued behind a running turn). */
  send: (text: string) => Promise<void>;
  /** Calls `onReply` with each answer the orchestrator finishes during the call; returns a stop. */
  watchReplies: (onReply: (markdown: string) => void) => () => void;
  /** Speak an answer; resolves when it has played or `signal` stops it. */
  speak: (markdown: string, signal: AbortSignal) => Promise<void>;
  onState: (state: CallState) => void;
  onLevel?: (level: number | null) => void;
  /** How long you may pause before what you said is sent (default 1.2 s). */
  pauseMs?: number;
  /** Timers and clock (fakes in tests). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

/** Sustained voice this long, in ms, cuts off an answer. */
const BARGE_IN_MS = 150;
/** Quietest level counted as a voice, whatever the room. */
const MIN_VOICE_LEVEL = 0.02;
/** A voice is this many times the room's level. */
const VOICE_RATIO = 3;

/**
 * Tells a voice from the room by the microphone level: a floor that drops to quiet at once and
 * rises slowly, and a voice that stays above it for `BARGE_IN_MS`.
 */
export class VoiceDetector {
  private floor = 0;
  private since: number | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Feed one level; true once a voice has lasted long enough. */
  push(level: number): boolean {
    this.floor =
      level < this.floor || this.floor === 0 ? level : this.floor + (level - this.floor) * 0.01;
    const voice = level > Math.max(MIN_VOICE_LEVEL, this.floor * VOICE_RATIO);
    if (!voice) {
      this.since = null;
      return false;
    }
    this.since ??= this.now();
    return this.now() - this.since >= BARGE_IN_MS;
  }
}

/**
 * A voice call with the orchestrator (§11.3). The microphone stays on for the whole call: each
 * time you pause, what you said since the last pause is sent straight away, even while the
 * orchestrator is working or speaking (it queues behind a running turn). Every answer the
 * orchestrator finishes is spoken, and the moment you start talking it stops speaking. The
 * microphone's echo cancellation keeps CodeDen's own voice out of what it hears.
 */
export class VoiceCall {
  private state: CallState = { phase: "listening", heard: "", draft: "", reply: "", error: null };
  /** How much of the engine's settled text has been sent. */
  private sentLength = 0;
  private settled = "";
  private timer: unknown = null;
  private waiting = 0;
  private speaking: AbortController | null = null;
  private stopReplies: () => void = () => {};
  private readonly voice: VoiceDetector;
  private ended = false;

  constructor(private readonly deps: CallDeps) {
    this.voice = new VoiceDetector(deps.now);
  }

  get phase(): CallPhase {
    return this.state.phase;
  }

  /** Start the call; `first` is sent straight away (words said right after the wake word). */
  start(first?: string): void {
    this.stopReplies = this.deps.watchReplies((markdown) => void this.answer(markdown));
    this.listen();
    if (first?.trim()) void this.send(first.trim());
  }

  /** End the call: the microphone and any answer stop. */
  hangUp(): void {
    if (this.ended) return;
    this.ended = true;
    this.clear();
    this.stopReplies();
    this.speaking?.abort();
    this.speaking = null;
    this.deps.engine.stop();
    this.deps.onLevel?.(null);
    this.set({ phase: "ended", draft: "" });
  }

  private set(patch: Partial<CallState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onState(this.state);
  }

  private idlePhase(): CallPhase {
    return this.waiting > 0 ? "thinking" : "listening";
  }

  private clear(): void {
    if (this.timer !== null) (this.deps.clearTimer ?? clearTimeout)(this.timer as never);
    this.timer = null;
  }

  /** You started talking: stop the answer that is playing. */
  private interrupt(): void {
    if (!this.speaking) return;
    this.speaking.abort();
    this.speaking = null;
    this.set({ phase: this.idlePhase() });
  }

  private listen(): void {
    if (this.ended) return;
    this.sentLength = 0;
    this.settled = "";
    this.deps.engine.start({
      language: this.deps.language,
      onText: (text) => {
        if (this.ended) return;
        this.settled = text.final;
        const fresh = text.final.slice(this.sentLength).trim();
        const draft = [fresh, text.draft.trim()].filter(Boolean).join(" ");
        if (draft) this.interrupt();
        this.set({ draft });
        this.clear();
        // Send once you have said something new and paused, with nothing still being written.
        if (fresh && !text.draft.trim()) {
          this.timer = (this.deps.setTimer ?? setTimeout)(
            () => this.flush(),
            this.deps.pauseMs ?? 1200,
          );
        }
      },
      onLevel: (level) => {
        this.deps.onLevel?.(level);
        if (this.voice.push(level)) this.interrupt();
      },
      onEnd: () => {
        if (this.ended) return;
        // The engine stopped on its own (a browser ends recognition after silence): send what
        // is left and keep listening with a fresh transcript.
        this.flush();
        this.listen();
      },
      onError: (message) => this.fail(message),
    });
  }

  /** Send what was said since the last send. */
  private flush(): void {
    this.timer = null;
    const fresh = this.settled.slice(this.sentLength).trim();
    this.sentLength = this.settled.length;
    if (fresh) void this.send(fresh);
  }

  private async send(text: string): Promise<void> {
    this.waiting++;
    this.set({
      heard: text,
      draft: "",
      phase: this.speaking ? "speaking" : "thinking",
    });
    try {
      await this.deps.send(text);
    } catch (error) {
      this.waiting = Math.max(0, this.waiting - 1);
      this.fail((error as Error).message);
    }
  }

  /** Speak an answer; a newer answer replaces one still playing. */
  private async answer(markdown: string): Promise<void> {
    if (this.ended) return;
    this.waiting = Math.max(0, this.waiting - 1);
    this.speaking?.abort();
    const controller = new AbortController();
    this.speaking = controller;
    this.set({ phase: "speaking", reply: markdown });
    try {
      await this.deps.speak(markdown, controller.signal);
    } catch {
      // A failed answer is skipped; the call goes on.
    }
    if (this.speaking === controller) {
      this.speaking = null;
      if (!this.ended) this.set({ phase: this.idlePhase() });
    }
  }

  private fail(message: string): void {
    if (this.ended) return;
    this.set({ error: message });
    this.hangUp();
  }
}

/** Lowercase letters and digits only, single spaces: how a wake phrase is compared. */
export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Whether `heard` contains the wake `phrase`, and what was said after it (sent as the call's
 * first message). Punctuation, case and accents don't matter.
 */
export function matchWakeWord(heard: string, phrase: string): { rest: string } | null {
  const said = normalizeSpeech(heard);
  const wake = normalizeSpeech(phrase);
  if (!wake) return null;
  const at = ` ${said} `.indexOf(` ${wake} `);
  if (at < 0) return null;
  return { rest: said.slice(at + wake.length).trim() };
}
