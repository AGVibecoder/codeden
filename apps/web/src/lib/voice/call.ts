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
  /**
   * `headset` (default): the microphone stays on and talking cuts an answer off. `speakers`:
   * the microphone pauses while an answer plays and turns back on when it ends.
   */
  audio?: "headset" | "speakers";
  /** How long you may pause before what you said is sent (default 1.2 s). */
  pauseMs?: number;
  /** Timers (fakes in tests). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Sounds a recognizer writes for a cough or a hesitation, never a word you meant. */
const NOT_WORDS = new Set([
  "uh",
  "uhm",
  "um",
  "umm",
  "hm",
  "hmm",
  "mm",
  "mhm",
  "ah",
  "eh",
  "oh",
  "huh",
  "er",
  "erm",
]);

/**
 * The words in `text`, without what a recognizer writes for noise: anything in brackets or
 * parentheses (`[noise]`, `(coughs)`), punctuation, and hesitation sounds. Empty when nothing
 * real was said, such as a cough.
 */
export function realWords(text: string): string {
  return text
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}'’-]/gu, ""))
    .filter((w) => /\p{L}.*\p{L}|\p{N}/u.test(w) && !NOT_WORDS.has(w.toLowerCase()))
    .join(" ");
}

/**
 * A voice call with the orchestrator (§11.3). Each time you pause, what you said since the
 * last pause is sent straight away, even while the orchestrator is working (it queues behind a
 * running turn), and every answer it finishes is spoken. With a `headset` the microphone stays
 * on and the answer stops as soon as a real word is heard (a cough or "uh" doesn't count).
 * With `speakers` the microphone is off
 * while an answer plays, so it never hears it, and turns back on when the answer ends.
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
  private ended = false;
  /** `speakers`: the microphone is off while an answer plays. */
  private paused = false;

  private get headset(): boolean {
    return (this.deps.audio ?? "headset") === "headset";
  }

  constructor(private readonly deps: CallDeps) {}

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

  /** You started talking: stop the answer that is playing (headset only). */
  private interrupt(): void {
    if (!this.speaking || !this.headset) return;
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
        // Coughs and hesitations aren't words: they neither cut the answer off nor get sent.
        const fresh = realWords(text.final.slice(this.sentLength));
        const draft = [fresh, realWords(text.draft)].filter(Boolean).join(" ");
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
      onLevel: (level) => this.deps.onLevel?.(level),
      onEnd: () => {
        // Paused for an answer (speakers): `answer()` turns the microphone back on.
        if (this.ended || this.paused) return;
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
    // Noise markers (`(coughs)`, `[noise]`) are dropped; a pause with no real words sends nothing.
    const fresh = this.settled
      .slice(this.sentLength)
      .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    this.sentLength = this.settled.length;
    if (realWords(fresh)) void this.send(fresh);
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
    if (!this.headset && !this.paused) {
      // Speakers: send what was already said, then the microphone is off until the answer ends.
      this.clear();
      this.flush();
      this.paused = true;
      this.deps.engine.stop();
      this.deps.onLevel?.(null);
    }
    this.set({ phase: "speaking", reply: markdown, draft: "" });
    try {
      await this.deps.speak(markdown, controller.signal);
    } catch {
      // A failed answer is skipped; the call goes on.
    }
    if (this.speaking === controller) {
      this.speaking = null;
      if (this.ended) return;
      this.set({ phase: this.idlePhase() });
      if (this.paused) {
        this.paused = false;
        this.listen();
      }
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
