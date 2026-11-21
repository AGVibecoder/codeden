import { matchWakeWord } from "./call";
import type { SpeechToText } from "./engines";

/** Restart listening this often, so the running transcript never grows long. */
const RESTART_MS = 5 * 60_000;

/**
 * Listens for the wake phrase with the dictation engine (§11.3) and calls `onWake` with what
 * was said after it. Stops listening while `onWake` runs a call; `resume()` starts it again.
 * The engine restarts after it ends on its own (browsers stop after a long silence) and every
 * few minutes.
 */
export class WakeWordListener {
  private running = false;
  private stopped = true;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly opts: {
      engine: SpeechToText;
      phrase: string;
      language?: string | null;
      onWake: (rest: string) => void;
      onError?: (message: string) => void;
    },
  ) {}

  start(): void {
    this.stopped = false;
    this.listen();
  }

  /** Stop listening for good (the caller makes a new listener for new settings). */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    if (this.running) this.opts.engine.stop();
    this.running = false;
  }

  /** Listen again after a call ends. */
  resume(): void {
    if (!this.stopped && !this.running) this.listen();
  }

  private listen(): void {
    if (this.stopped || this.running) return;
    this.running = true;
    let woke = false;
    let failed = false;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      if (this.running && !woke) this.opts.engine.stop();
    }, RESTART_MS);
    this.opts.engine.start({
      language: this.opts.language,
      onText: (text) => {
        if (woke) return;
        const match = matchWakeWord(text.final, this.opts.phrase);
        if (!match) return;
        woke = true;
        this.opts.engine.stop();
        this.opts.onWake(match.rest);
      },
      onEnd: () => {
        this.running = false;
        clearTimeout(this.restartTimer);
        // After a wake the call owns the microphone; `resume()` comes when it ends. After an
        // error (no microphone, the engine failing) it waits before trying again.
        if (!woke) setTimeout(() => this.listen(), failed ? 30_000 : 500);
      },
      onError: (message) => {
        failed = true;
        this.opts.onError?.(message);
      },
    });
  }
}
