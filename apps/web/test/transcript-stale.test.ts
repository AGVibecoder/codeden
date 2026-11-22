import { describe, expect, it } from "vitest";
import { applyAgentEvent, emptyTranscript } from "@/lib/transcript/reducer";
import { staleRunningTurn } from "@/lib/transcript/stale";

/**
 * A transcript that missed a turn's end keeps saying "Working". The session status, kept by the
 * global stream, tells the view to reload it.
 */
const thread = "s1:thread-root";
const started = applyAgentEvent(
  applyAgentEvent(emptyTranscript("s1"), {
    type: "thread.started",
    thread: { id: thread },
  } as never),
  { type: "turn.started", threadId: thread, turnId: "t1" },
);

describe("a turn still shown running", () => {
  it("is stale once the session is at rest", () => {
    expect(staleRunningTurn(started, "idle")).toBe("t1");
    expect(staleRunningTurn(started, "stopped")).toBe("t1");
  });

  it("is not stale while the session works or waits for an answer", () => {
    expect(staleRunningTurn(started, "running")).toBeNull();
    expect(staleRunningTurn(started, "waiting")).toBeNull();
    expect(staleRunningTurn(started, undefined)).toBeNull();
  });

  it("is not stale once the transcript heard the turn end", () => {
    const done = applyAgentEvent(started, {
      type: "turn.completed",
      threadId: thread,
      turnId: "t1",
    } as never);
    expect(staleRunningTurn(done, "idle")).toBeNull();
    expect(staleRunningTurn(undefined, "idle")).toBeNull();
  });
});
