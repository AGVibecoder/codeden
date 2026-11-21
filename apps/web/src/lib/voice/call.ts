import type { SpeechToText } from "./engines";

/**
 * Where a call stands: `listening` (the microphone is on), `sending` (what you said goes to the
 * orchestrator), `thinking` (its turn runs), `speaking` (its answer plays), then listening
 * again; `ended` once hung up.
 */
export type CallPhase = "listening" | "sending" | "thinking" | "speaking" | "ended";

export interface CallState {
  phase: CallPhase;
  /** What you said last. */
  heard: string;
  /** Text in progress while you speak. */
  draft: string;
  /** The orchestrator's last answer, as spoken. */
  reply: string;
  error: string | null;
}

export interface CallDeps {
  /** The dictation engine (browser or a server engine). */
  engine: SpeechToText;
  language?: string | null;
  /** Send what was said to the orchestrator. */
  send: (text: string) => Promise<void>;
  /** Resolves with the orchestrator's answer to the message just sent (markdown). */
  waitForReply: (signal: AbortSignal) => Promise<string>;
  /** Speak an answer; resolves when it has played. */
  speak: (markdown: string, signal: AbortSignal) => Promise<void>;
  onState: (state: CallState) => void;
  onLevel?: (level: number | null) => void;
  /** How long you may pause before what you said is sent (default 1.2 s). */
  pauseMs?: number;
  /** Timers (fakes in tests). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * A voice call with the orchestrator (§11.3), one turn at a time: listen until you pause, send
 * what you said, wait for its answer, speak it, listen again. The microphone is off while the
 * answer plays, so the answer never hears itself; you can't talk over it (hang up instead).
 */
export class VoiceCall {
  private state: CallState = { phase: "listening", heard: "", draft: "", reply: "", error: null };
  private said = "";
  private timer: unknown = null;
  private abort = new AbortController();
  private listening = false;

  constructor(private readonly deps: CallDeps) {}

  get phase(): CallPhase {
    return this.state.phase;
  }

  /** Start listening; `first` is sent straight away (words said right after the wake word). */
  start(first?: string): void {
    if (first?.trim()) void this.turn(first.trim());
    else this.listen();
  }

  /** End the call: the microphone, the wait and the answer all stop. */
  hangUp(): void {
    if (this.state.phase === "ended") return;
    this.abort.abort();
    this.clear();
    if (this.listening) this.deps.engine.stop();
    this.listening = false;
    this.deps.onLevel?.(null);
    this.set({ phase: "ended", draft: "" });
  }

  private set(patch: Partial<CallState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onState(this.state);
  }

  private clear(): void {
    if (this.timer !== null) (this.deps.clearTimer ?? clearTimeout)(this.timer as never);
    this.timer = null;
  }

  private listen(): void {
    if (this.abort.signal.aborted) return;
    this.said = "";
    this.listening = true;
    this.set({ phase: "listening", draft: "" });
    this.deps.engine.start({
      language: this.deps.language,
      onText: (text) => {
        if (!this.listening) return;
        this.said = text.final;
        this.set({ draft: [text.final, text.draft].filter(Boolean).join(" ") });
        this.clear();
        // Send once you have said something and paused, with nothing still being written.
        if (text.final.trim() && !text.draft.trim()) {
          this.timer = (this.deps.setTimer ?? setTimeout)(
            () => this.endUtterance(),
            this.deps.pauseMs ?? 1200,
          );
        }
      },
      onLevel: (level) => this.deps.onLevel?.(level),
      onEnd: () => {
        if (!this.listening) return;
        // The engine stopped on its own (a browser ends recognition after silence): go on.
        this.listening = false;
        if (this.said.trim()) void this.turn(this.said.trim());
        else this.listen();
      },
      onError: (message) => this.fail(message),
    });
  }

  private endUtterance(): void {
    this.timer = null;
    if (!this.listening) return;
    const text = this.said.trim();
    this.listening = false;
    this.deps.engine.stop();
    this.deps.onLevel?.(null);
    if (text) void this.turn(text);
  }

  private async turn(text: string): Promise<void> {
    const signal = this.abort.signal;
    try {
      this.set({ phase: "sending", heard: text, draft: "" });
      const reply = this.deps.waitForReply(signal);
      await this.deps.send(text);
      if (signal.aborted) return;
      this.set({ phase: "thinking" });
      const answer = await reply;
      if (signal.aborted) return;
      this.set({ phase: "speaking", reply: answer });
      await this.deps.speak(answer, signal);
      if (!signal.aborted) this.listen();
    } catch (error) {
      if (!signal.aborted) this.fail((error as Error).message);
    }
  }

  private fail(message: string): void {
    if (this.state.phase === "ended") return;
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
