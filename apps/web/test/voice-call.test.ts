import type { Session } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { type CallState, matchWakeWord, realWords, VoiceCall } from "../src/lib/voice/call";
import type { DictationText, SpeechToText } from "../src/lib/voice/engines";
import { isTargetSession, sameTarget } from "../src/stores/call";

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
  return {
    engine,
    say: (text: DictationText) => handlers?.onText(text),
    level: (value: number) => handlers?.onLevel?.(value),
  };
}

/** Timers and a clock that only move when the test says so. */
function fakeTime() {
  const pending = new Map<number, () => void>();
  let next = 1;
  let now = 0;
  return {
    setTimer: (fn: () => void) => {
      pending.set(next, fn);
      return next++;
    },
    clearTimer: (h: unknown) => pending.delete(h as number),
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    flush: () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A call with fakes; `reply` delivers an orchestrator answer, `spoken` records what played. */
function setup() {
  const { engine, say, level } = fakeEngine();
  const time = fakeTime();
  const sent: string[] = [];
  const spoken: { text: string; signal: AbortSignal }[] = [];
  let reply: (markdown: string) => void = () => {};
  const call = new VoiceCall({
    engine,
    send: async (text) => {
      sent.push(text);
    },
    watchReplies: (onReply) => {
      reply = onReply;
      return () => {
        reply = () => {};
      };
    },
    // Plays until stopped.
    speak: (text, signal) =>
      new Promise<void>((resolve) => {
        spoken.push({ text, signal });
        signal.addEventListener("abort", () => resolve());
      }),
    onState: (_s: CallState) => {},
    ...time,
  });
  return { call, engine, say, level, time, sent, spoken, reply: (m: string) => reply(m) };
}

describe("VoiceCall", () => {
  it("sends each pause straight away and keeps the microphone on", async () => {
    const { call, engine, say, time, sent } = setup();
    call.start();
    say({ final: "How is the", draft: "build doing" }); // still talking: no send yet
    time.flush();
    expect(sent).toEqual([]);
    say({ final: "How is the build doing", draft: "" });
    time.flush();
    await tick();
    expect(sent).toEqual(["How is the build doing"]);
    expect(call.phase).toBe("thinking");
    // Only the new words go next time; the engine never stopped.
    say({ final: "How is the build doing and the tests", draft: "" });
    time.flush();
    await tick();
    expect(sent).toEqual(["How is the build doing", "and the tests"]);
    expect(engine.stops).toBe(0);
    call.hangUp();
    expect(call.phase).toBe("ended");
  });

  it("stops speaking the moment you talk, and still sends what you said", async () => {
    const { call, say, time, sent, spoken, reply } = setup();
    call.start();
    reply("All checks passed on main.");
    await tick();
    expect(call.phase).toBe("speaking");
    expect(spoken[0]?.signal.aborted).toBe(false);
    say({ final: "", draft: "wait" });
    expect(spoken[0]?.signal.aborted).toBe(true);
    expect(call.phase).toBe("listening");
    say({ final: "wait, also run the slow tests", draft: "" });
    time.flush();
    await tick();
    expect(sent).toEqual(["wait, also run the slow tests"]);
    call.hangUp();
  });

  it("keeps talking through a cough or an uh, and sends nothing for it", async () => {
    const { call, say, level, time, sent, spoken, reply } = setup();
    call.start();
    reply("Here is the status.");
    await tick();
    level(0.3); // loud, but no words
    say({ final: "(coughs)", draft: "" });
    say({ final: "(coughs) uh", draft: "hmm" });
    expect(spoken[0]?.signal.aborted).toBe(false);
    time.flush();
    await tick();
    expect(sent).toEqual([]);
    say({ final: "(coughs) uh stop", draft: "" });
    expect(spoken[0]?.signal.aborted).toBe(true);
    time.flush();
    await tick();
    expect(sent).toEqual(["uh stop"]);
    call.hangUp();
  });

  it("with speakers, pauses the microphone while an answer plays", async () => {
    const { engine, say } = fakeEngine();
    const time = fakeTime();
    const sent: string[] = [];
    let reply: (m: string) => void = () => {};
    let finish: () => void = () => {};
    const call = new VoiceCall({
      engine,
      audio: "speakers",
      send: async (text) => {
        sent.push(text);
      },
      watchReplies: (onReply) => {
        reply = onReply;
        return () => {};
      },
      speak: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      onState: () => {},
      ...time,
    });
    call.start();
    say({ final: "check the logs", draft: "" }); // said before the answer: still sent
    reply("Looking now.");
    await tick();
    expect(sent).toEqual(["check the logs"]);
    expect(engine.stops).toBe(1);
    expect(engine.starts).toBe(1);
    finish();
    await tick();
    expect(engine.starts).toBe(2); // listening again
    expect(call.phase).toBe("thinking");
    call.hangUp();
  });

  it("sends the words said with the wake word straight away", async () => {
    const { call, sent } = setup();
    call.start("what changed today");
    await tick();
    expect(sent).toEqual(["what changed today"]);
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
      watchReplies: () => () => {},
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

describe("call targets", () => {
  const orchestrator = { role: "orchestrator" as const, projectId: null };
  const pmA = { role: "pm" as const, projectId: "p-a" };
  const pmB = { role: "pm" as const, projectId: "p-b" };
  const session = (role: string, projectId: string | null) =>
    ({ role, projectId }) as unknown as Session;

  it("tells calls with the orchestrator and each project manager apart", () => {
    expect(sameTarget(orchestrator, { role: "orchestrator", projectId: "ignored" })).toBe(true);
    expect(sameTarget(pmA, pmA)).toBe(true);
    expect(sameTarget(pmA, pmB)).toBe(false);
    expect(sameTarget(orchestrator, pmA)).toBe(false);
    expect(sameTarget(null, pmA)).toBe(false);
  });

  it("matches the role session a call talks to", () => {
    expect(isTargetSession(pmA, session("pm", "p-a"))).toBe(true);
    expect(isTargetSession(pmA, session("pm", "p-b"))).toBe(false);
    expect(isTargetSession(pmA, session("agent", "p-a"))).toBe(false);
    expect(isTargetSession(orchestrator, session("orchestrator", null))).toBe(true);
  });
});

describe("realWords", () => {
  it("drops noise markers, punctuation and hesitations", () => {
    expect(realWords("(coughs)")).toBe("");
    expect(realWords("[noise] uh, hmm... *sneezes*")).toBe("");
    expect(realWords("Uh, run the tests.")).toBe("run the tests");
    expect(realWords("deploy v2")).toBe("deploy v2");
    expect(realWords("a")).toBe("");
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
