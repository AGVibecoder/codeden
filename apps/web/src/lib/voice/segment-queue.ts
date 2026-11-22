import type { DictationText } from "./engines";

/**
 * Transcribes dictation segments as they finish (§11.3) and keeps their text in order. Each
 * segment is sent once, at most `concurrency` (2) at a time so a slow engine can't take every
 * connection the app has to its server, and the results may come back in any order:
 * - `final` is the text of every settled segment before the first one still pending, in order,
 *   so it only ever grows at the end;
 * - `draft` is the text of segments that came back ahead of one still pending.
 *
 * The first failure is reported once. The text of every segment that succeeded is kept,
 * including those after the failed one.
 */
export interface SegmentQueue<T> {
  /** Send a finished segment for transcription. Ignored after a failure. */
  add(segment: T): void;
  /** Resolves once every segment sent so far has come back or failed. */
  drain(): Promise<void>;
  /** The text of every segment that succeeded, in segment order. */
  readonly text: string;
  /** True once a segment failed. */
  readonly failed: boolean;
  /**
   * Drop every segment not back yet: waiting ones are never sent and running ones are aborted.
   * No text or error is reported after it, and `drain()` resolves.
   */
  cancel(): void;
}

/**
 * Characters of scripts written without spaces between words (Chinese, Japanese, Thai, Lao,
 * Khmer, Burmese), with the CJK and full-width punctuation they use. Script extensions also
 * cover marks those scripts share, such as the Japanese long vowel mark.
 */
const SPACELESS =
  "\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Thai}\\p{scx=Lao}\\p{scx=Khmer}\\p{scx=Myanmar}\\u3000-\\u303f\\uff01-\\uff60";
const ENDS_SPACELESS = new RegExp(`[${SPACELESS}]$`, "u");
const STARTS_SPACELESS = new RegExp(`^[${SPACELESS}]`, "u");

/**
 * What goes between two pieces of dictated text: nothing where both sides are in a script
 * written without spaces (a pause there is not a word break), a single space otherwise.
 */
export function separator(before: string, after: string): string {
  return ENDS_SPACELESS.test(before) && STARTS_SPACELESS.test(after) ? "" : " ";
}

/** Join transcribed pieces the way their language is written, skipping empty ones. */
export function joinSegments(pieces: readonly string[]): string {
  let text = "";
  for (const piece of pieces) {
    const p = piece.trim();
    if (p) text = text ? text + separator(text, p) + p : p;
  }
  return text;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createSegmentQueue<T>(opts: {
  transcribe: (segment: T, signal: AbortSignal) => Promise<string>;
  onText: (text: DictationText) => void;
  onPending?: (count: number) => void;
  onError: (message: string) => void;
  /** Segments being transcribed at once (default 2); the rest wait their turn. */
  concurrency?: number;
}): SegmentQueue<T> {
  /** One entry per segment, in order: its text, `null` when it failed, `undefined` while pending. */
  const results: (string | null | undefined)[] = [];
  const jobs: Promise<void>[] = [];
  const limit = Math.max(1, opts.concurrency ?? 2);
  /** Segments waiting for a free slot, each with the function that starts it. */
  const waiting: (() => void)[] = [];
  let running = 0;
  let pending = 0;
  let failed = false;
  let cancelled = false;
  const abort = new AbortController();
  let last: DictationText = { final: "", draft: "" };

  /** A free slot, once one is free (or right away). */
  const slot = () =>
    new Promise<void>((resolve) => {
      if (running < limit) {
        running++;
        resolve();
      } else {
        waiting.push(() => {
          running++;
          resolve();
        });
      }
    });
  const release = () => {
    running--;
    waiting.shift()?.();
  };

  const emit = () => {
    if (cancelled) return;
    let settled = 0;
    while (settled < results.length && results[settled] !== undefined) settled++;
    const texts = (from: number, to: number) =>
      results.slice(from, to).filter((r): r is string => typeof r === "string");
    const next = {
      final: joinSegments(texts(0, settled)),
      draft: joinSegments(texts(settled, results.length)),
    };
    if (next.final === last.final && next.draft === last.draft) return;
    last = next;
    opts.onText(next);
  };

  return {
    get text() {
      return joinSegments(results.filter((r): r is string => typeof r === "string"));
    },
    get failed() {
      return failed;
    },
    add(segment) {
      if (failed || cancelled) return;
      const index = results.length;
      results.push(undefined);
      pending++;
      opts.onPending?.(pending);
      const job = slot()
        .then(async () => {
          try {
            if (cancelled) return null;
            return await opts.transcribe(segment, abort.signal);
          } finally {
            release();
          }
        })
        .then(
          (text) => {
            results[index] = text;
          },
          (error: unknown) => {
            results[index] = null;
            if (failed || cancelled) return;
            failed = true;
            opts.onError(message(error));
          },
        )
        .finally(() => {
          pending--;
          if (!cancelled) opts.onPending?.(pending);
          emit();
        });
      jobs.push(job);
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      abort.abort();
      // Waiting segments start, see the cancel and finish without sending anything.
      while (waiting.length > 0) waiting.shift()?.();
    },
    async drain() {
      // Segments can be added while earlier ones are in flight; wait until none are left.
      let seen = -1;
      while (seen !== jobs.length) {
        seen = jobs.length;
        await Promise.all(jobs);
      }
    },
  };
}
