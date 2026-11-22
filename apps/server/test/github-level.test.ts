import type { GithubUpdatesLevel } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GithubWakeThrottle,
  isOwnWork,
  presentation,
  renderGithubSummary,
} from "../src/services/orchestration/github-level";
import { deriveGithubNotices } from "../src/services/orchestration/github-notices";
import type { NoticeDraft } from "../src/services/orchestration/notices";
import { createGithubEnv, type GithubEnv } from "./support/github-env";
import { TEST_START } from "./support/test-clock";

const pr = (number: number) => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  state: "open" as const,
  title: `PR ${number}`,
});
const base = { projectId: "p1", target: "pm" as const, title: "t" };

const checksFailed = (sessionId: string | null): NoticeDraft => ({
  ...base,
  id: `cf:${sessionId}`,
  type: "pr.checks_failed",
  sessionId,
  data: { sessionId, pr: pr(1), failedChecks: ["ci"] },
});
const review = (
  state: "approved" | "changes_requested",
  sessionId: string | null,
  untrusted?: boolean,
): NoticeDraft => ({
  ...base,
  id: `r:${state}:${sessionId}:${untrusted}`,
  type: "review.submitted",
  sessionId,
  data: {
    sessionId,
    pr: pr(2),
    reviewer: "lee",
    state,
    body: "",
    ...(untrusted ? { untrusted } : {}),
  },
});
const issue = (number: number): NoticeDraft => ({
  ...base,
  id: `i:${number}`,
  type: "issue.opened",
  sessionId: null,
  data: {
    issue: { number, url: `https://github.com/o/r/issues/${number}` },
    author: "x",
    labels: [],
  },
});
const merged = (sessionId: string | null): NoticeDraft => ({
  ...base,
  id: `m:${sessionId}`,
  type: "pr.merged",
  sessionId,
  data: { sessionId, pr: pr(3), linkedIssues: [] },
});
const conflicting: NoticeDraft = {
  ...base,
  id: "c",
  type: "pr.conflicting",
  sessionId: "s1",
  data: { sessionId: "s1", pr: pr(4) },
};
const finished: NoticeDraft = {
  ...base,
  id: "f",
  type: "session.finished",
  sessionId: "s1",
  data: {
    sessionId: "s1",
    workKey: "issue:1",
    purpose: "Fix",
    startedBy: { kind: "pm" },
    summary: null,
    outcome: null,
  },
};

describe("is this about our own work?", () => {
  it("counts failed checks, change requests, merges and conflicts on CodeDen's PRs", () => {
    expect(isOwnWork(checksFailed("s1"))).toBe(true);
    expect(isOwnWork(review("changes_requested", "s1"))).toBe(true);
    expect(isOwnWork(merged("s1"))).toBe(true);
    expect(isOwnWork(conflicting)).toBe(true);
  });

  it("leaves out other people's PRs, approvals, untrusted reviews and new issues", () => {
    expect(isOwnWork(checksFailed(null))).toBe(false);
    expect(isOwnWork(merged(null))).toBe(false);
    expect(isOwnWork(review("approved", "s1"))).toBe(false);
    expect(isOwnWork(review("changes_requested", null))).toBe(false);
    expect(isOwnWork(review("changes_requested", "s1", true))).toBe(false);
    expect(isOwnWork(issue(5))).toBe(false);
  });
});

describe("where a notice goes at each GitHub updates level", () => {
  const where = (level: GithubUpdatesLevel) => ({
    own: presentation(checksFailed("s1"), level),
    other: presentation(issue(5), level),
    session: presentation(finished, level),
  });

  it("off hides all GitHub activity, digest only summarizes it", () => {
    expect(where("off")).toEqual({ own: "hidden", other: "hidden", session: "live" });
    expect(where("digest")).toEqual({ own: "summary", other: "summary", session: "live" });
  });

  it("important shows only our own work live, all shows everything", () => {
    expect(where("important")).toEqual({ own: "live", other: "summary", session: "live" });
    expect(where("all")).toEqual({ own: "live", other: "live", session: "live" });
  });

  it("summarizes the rest in one short block, with counts and numbers", () => {
    const text = renderGithubSummary([
      issue(12),
      issue(13),
      checksFailed(null),
      review("approved", null),
    ]);
    expect(text).toContain("2 issues opened (#12, #13)");
    expect(text).toContain("1 PR failed its checks (#1)");
    expect(text).toContain("1 review (#2)");
    expect(text.startsWith("<codeden_github_summary>")).toBe(true);
  });
});

describe("GitHub wakes at the all level, batched every 15 minutes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_START);
  });
  afterEach(() => vi.useRealTimers());

  const min = 60_000;

  it("wakes at once, then holds further activity until 15 minutes have passed", () => {
    const wake = vi.fn();
    const throttle = new GithubWakeThrottle(wake);
    throttle.request("pm:p1");
    expect(wake).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2 * min);
    throttle.request("pm:p1");
    vi.advanceTimersByTime(5 * min);
    throttle.request("pm:p1");
    expect(wake).toHaveBeenCalledTimes(1);

    // The held activity goes out as one wake, 15 minutes after the first.
    vi.advanceTimersByTime(8 * min - 1);
    expect(wake).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(Date.now() - TEST_START.getTime()).toBe(15 * min);
    throttle.dispose();
  });

  it("wakes at once again once the interval has passed, and counts each PM on its own", () => {
    const wake = vi.fn();
    const throttle = new GithubWakeThrottle(wake);
    throttle.request("pm:p1");
    throttle.request("pm:p2");
    expect(wake.mock.calls).toEqual([["pm:p1"], ["pm:p2"]]);
    vi.advanceTimersByTime(20 * min);
    throttle.request("pm:p1");
    expect(wake).toHaveBeenCalledTimes(3);
    throttle.dispose();
  });

  it("drops the held wake when disposed", () => {
    const wake = vi.fn();
    const throttle = new GithubWakeThrottle(wake);
    throttle.request("pm:p1");
    throttle.request("pm:p1");
    throttle.dispose();
    vi.advanceTimersByTime(30 * min);
    expect(wake).toHaveBeenCalledTimes(1);
  });
});

describe("merge conflicts on our PRs", () => {
  let env: GithubEnv;
  beforeEach(() => {
    env = createGithubEnv();
  });
  afterEach(() => env.close());

  it("become a notice only for a PR a CodeDen session opened", async () => {
    const owned = env.addSession({ branch: "codeden/task-1", startedBy: { kind: "pm" } });
    env.gh.addPr("codeden/task-1");
    env.gh.addPr("feature/human");
    await env.service.syncNow("p-gh");
    for (const n of [1, 2]) {
      env.gh.touch(n, (i) => {
        if (i.pr) i.pr.mergeable = "CONFLICTING";
      });
    }
    const mark = env.events.length;
    await env.service.syncNow("p-gh");
    const derived = deriveGithubNotices(env.events.slice(mark), (id) => env.repo.find(id)?.session);
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({
      wake: true,
      notice: { type: "pr.conflicting", sessionId: owned.id, data: { pr: { number: 1 } } },
    });
  });
});
