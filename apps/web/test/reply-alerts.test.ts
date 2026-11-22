import { describe, expect, it } from "vitest";
import {
  raisesReplyAlert,
  replyLine,
  replyPath,
  replyTarget,
  replyTitle,
} from "@/lib/attention/replies";

/** Alerts when the orchestrator or a project manager replies; never for workers. */
const on = { enabled: true, watching: false, inCall: false };

describe("reply alerts", () => {
  it("fire when the orchestrator or a project manager finishes a turn", () => {
    expect(raisesReplyAlert({ role: "pm" }, "running", "idle", on)).toBe(true);
    expect(raisesReplyAlert({ role: "orchestrator" }, "waiting", "idle", on)).toBe(true);
  });

  it("never fire for workers", () => {
    expect(raisesReplyAlert({ role: "agent" }, "running", "idle", on)).toBe(false);
    expect(raisesReplyAlert({ role: "agent" }, "running", "completed", on)).toBe(false);
  });

  it("stay quiet when switched off, while watching that chat, in a call, or mid-turn", () => {
    expect(raisesReplyAlert({ role: "pm" }, "running", "idle", { ...on, enabled: false })).toBe(
      false,
    );
    expect(raisesReplyAlert({ role: "pm" }, "running", "idle", { ...on, watching: true })).toBe(
      false,
    );
    expect(raisesReplyAlert({ role: "pm" }, "running", "idle", { ...on, inCall: true })).toBe(
      false,
    );
    expect(raisesReplyAlert({ role: "pm" }, "idle", "running", on)).toBe(false);
    expect(raisesReplyAlert({ role: "pm" }, undefined, "idle", on)).toBe(false);
  });

  it("say who replied, its first line, and open its chat", () => {
    expect(replyTitle({ role: "pm", title: "PM" }, "Leonida")).toBe(
      "Leonida project manager replied",
    );
    expect(replyTitle({ role: "orchestrator", title: null }, null)).toBe("Orchestrator replied");
    expect(replyLine("\n## **Done**: PR [#12](https://x) is merged.\nMore")).toBe(
      "Done: PR #12 is merged.",
    );
    expect(replyLine(null)).toBeUndefined();
    const pm = { id: "s1", role: "pm" as const, projectId: "p1" };
    expect(replyTarget(pm)).toEqual({ to: "/projects/$projectId/pm", params: { projectId: "p1" } });
    expect(replyPath(pm)).toBe("/projects/p1/pm");
    expect(replyPath({ id: "o1", role: "orchestrator", projectId: null })).toBe("/sessions/o1");
  });
});
