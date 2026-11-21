import { describe, expect, it } from "vitest";
import { type CallState, matchWakeWord, VoiceCall } from "../src/lib/voice/call";
import type { DictationText, SpeechToText } from "../src/lib/voice/engines";

/** A dictation engine the test drives by hand. */
function fakeEngine() {
  let handlers: Parameters<SpeechToText["start"]>[0] | null = null;
  const engine: SpeechToText & { starts: number; stops: number } = {
    supported: true,
    live: "segments",
    finishesAfterStop: false,
    starts: 0,
    stops: 0,
    start(opts) {
      engine.starts++;
      handlers = opts;
    },
    stop() {
      engine.stops++;
      const h = handlers;
      handlers = null;
      h?.onEnd();
    },
  };
  const say = (text: DictationText) => handlers?.onText(text);
  return { engine, say };
}

/** Timers that only run when the test says so. */
function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer: (fn: () => void) => {
      pending.set(next, fn);
      return next++;
    },
    clearTimer: (h: unknown) => pending.delete(h as number),
    flush: () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("VoiceCall", () => {
  it("sends what you said after a pause, speaks the answer, then listens again", async () => {
    const { engine, say } = fakeEngine();
    const timers = fakeTimers();
    const sent: string[] = [];
    const spoken: string[] = [];
    const phases: string[] = [];
    let answer: (text: string) => void = () => {};
    const call = new VoiceCall({
      engine,
      send: async (text) => {
        sent.push(text);
      },
      waitForReply: () => new Promise<string>((r) => (answer = r)),
      speak: async (text) => {
        spoken.push(text);
      },
      onState: (s: CallState) => phases.push(s.phase),
      ...timers,
    });
    call.start();
    say({ final: "How is the", draft: "" });
    say({ final: "How is the", draft: "build doing" }); // still talking: no send yet
    timers.flush();
    expect(sent).toEqual([]);
    say({ final: "How is the build doing", draft: "" });
    timers.flush();
    await tick();
    expect(sent).toEqual(["How is the build doing"]);
    expect(call.phase).toBe("thinking");
    answer("**Green**, all checks passed.");
    await tick();
    await tick();
    expect(spoken).toEqual(["**Green**, all checks passed."]);
    expect(call.phase).toBe("listening");
    expect(engine.starts).toBe(2);
    expect(phases).toContain("speaking");
    call.hangUp();
    expect(call.phase).toBe("ended");
  });

  it("sends the words said with the wake word straight away", async () => {
    const { engine } = fakeEngine();
    const sent: string[] = [];
    const call = new VoiceCall({
      engine,
      send: async (text) => {
        sent.push(text);
      },
      waitForReply: () => new Promise<string>(() => {}),
      speak: async () => {},
      onState: () => {},
    });
    call.start("what changed today");
    await tick();
    expect(sent).toEqual(["what changed today"]);
    expect(engine.starts).toBe(0);
    call.hangUp();
  });

  it("ends the call with the error when listening fails", () => {
    const engine: SpeechToText = {
      supported: true,
      live: "segments",
      finishesAfterStop: false,
      start: (opts) => opts.onError("Microphone blocked"),
      stop: () => {},
    };
    let last: CallState | null = null;
    const call = new VoiceCall({
      engine,
      send: async () => {},
      waitForReply: async () => "",
      speak: async () => {},
      onState: (s) => {
        last = s;
      },
    });
    call.start();
    expect(call.phase).toBe("ended");
    expect((last as CallState | null)?.error).toBe("Microphone blocked");
  });
});

describe("matchWakeWord", () => {
  it("finds the phrase whatever the case, punctuation or accents, and keeps what follows", () => {
    expect(matchWakeWord("Hey, Annie! What's the status?", "Hey Annie")).toEqual({
      rest: "what s the status",
    });
    expect(matchWakeWord("hé annie", "Hey Annie")).toBeNull();
    expect(matchWakeWord("They annie", "Hey Annie")).toBeNull();
    expect(matchWakeWord("okay hey annie", "hey annie")).toEqual({ rest: "" });
  });
});
