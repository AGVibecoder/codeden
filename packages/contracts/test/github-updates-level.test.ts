import { describe, expect, it } from "vitest";
import { GithubUpdatesLevel, Notice, Project, UpdateProjectRequest } from "../src";
import { sampleProject } from "./fixtures";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

// Which GitHub activity wakes a project's PM and reaches its chat, per project.
describe("GitHub updates level", () => {
  it("defaults to important, so projects written before the setting existed parse", () => {
    const { githubUpdates: _g, ...rest } = sampleProject;
    expect(Project.parse(rest).githubUpdates).toBe("important");
  });

  it("round-trips every level on a project and in the update request", () => {
    for (const level of GithubUpdatesLevel.options) {
      expect(roundTrip(Project, { ...sampleProject, githubUpdates: level }).githubUpdates).toBe(
        level,
      );
      expect(roundTrip(UpdateProjectRequest, { githubUpdates: level })).toEqual({
        githubUpdates: level,
      });
    }
    expect(Project.safeParse({ ...sampleProject, githubUpdates: "loud" }).success).toBe(false);
    expect(UpdateProjectRequest.safeParse({ githubUpdates: "none" }).success).toBe(false);
  });

  it("round-trips a merge conflict notice", () => {
    const notice = {
      id: "pr.conflicting:p1:7:sha",
      type: "pr.conflicting",
      projectId: "p1",
      target: "pm",
      sessionId: "s1",
      title: "PR #7 has merge conflicts: Fix",
      createdAt: "2026-11-22T10:00:00.000Z",
      deliveredAt: null,
      wake: true,
      data: {
        sessionId: "s1",
        pr: { number: 7, url: "https://github.com/o/r/pull/7", state: "open", title: "Fix" },
      },
    };
    expect(roundTrip(Notice, notice)).toEqual(notice);
  });
});
