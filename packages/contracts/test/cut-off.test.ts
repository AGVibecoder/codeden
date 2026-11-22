import { describe, expect, it } from "vitest";
import {
  ContinueBriefing,
  ContinueSessionRequest,
  ContinueSessionResponse,
  canContinueAt,
  isCutOff,
  Notice,
  SessionCutOff,
  Settings,
} from "../src";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

const cutOff = {
  reason: "usage_limit",
  at: "2026-11-22T10:00:00.000Z",
  turnId: "t1",
  resetsAt: "2026-11-22T12:00:00.000Z",
  continueWhenReset: false,
} as const;

describe("cut-off contracts", () => {
  it("round-trips a cut-off and its briefing", () => {
    roundTrip(SessionCutOff, cutOff);
    roundTrip(SessionCutOff, { ...cutOff, reason: "crash", resetsAt: null, turnId: null });
    roundTrip(ContinueBriefing, {
      task: "Fix the login bug",
      laterRequests: ["Also add a test"],
      reason: "app_closed",
      detail: null,
      lastActivity: { kind: "command", title: "pnpm test", finished: false, output: "FAIL a" },
      changes: { since: "checkpoint", files: ["src/a.ts"], diff: "+x", truncated: false },
      unavailable: null,
      quotesUntrusted: false,
    });
    expect(() => SessionCutOff.parse({ ...cutOff, reason: "bored" })).toThrow();
  });

  it("defaults the continue mode to now and round-trips the response", () => {
    expect(ContinueSessionRequest.parse({})).toEqual({ mode: "now" });
    roundTrip(ContinueSessionRequest, { mode: "when_usage_resets" });
    roundTrip(ContinueSessionResponse, { status: "scheduled" });
  });

  it("round-trips the orchestrator's cut-off notice", () => {
    roundTrip(Notice, {
      id: "sessions.cut_off:home:1",
      type: "sessions.cut_off",
      projectId: null,
      target: "orchestrator",
      sessionId: null,
      title: "2 workers were cut off",
      createdAt: "2026-11-22T10:00:00.000Z",
      deliveredAt: null,
      data: {
        sessions: [{ sessionId: "s1", projectId: "p1", title: "Fix login", reason: "crash" }],
      },
    });
  });

  it("is off by default in settings", () => {
    expect(Settings.parse({}).sessions.continueWhenUsageResets).toBe(false);
  });

  it("counts only interrupted sessions with a cut-off, and waits for the usage reset", () => {
    expect(isCutOff({ status: "interrupted", cutOff })).toBe(true);
    expect(isCutOff({ status: "interrupted" })).toBe(false);
    expect(isCutOff({ status: "running", cutOff })).toBe(false);
    const reset = Date.parse(cutOff.resetsAt);
    expect(canContinueAt(cutOff, reset - 1)).toBe(false);
    expect(canContinueAt(cutOff, reset)).toBe(true);
    expect(canContinueAt({ ...cutOff, resetsAt: null }, 0)).toBe(true);
    expect(canContinueAt({ ...cutOff, reason: "crash" }, 0)).toBe(true);
  });
});
