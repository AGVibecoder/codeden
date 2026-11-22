import type { RunnerCommandName, RunnerCommandOf } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunnerPort } from "../src/services/runner-port";
import { pushWritableFolders } from "../src/services/sessions/live-folders";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

let env: GithubEnv;
let calls: Array<RunnerCommandOf<RunnerCommandName>>;
let runner: RunnerPort;

beforeEach(() => {
  env = createGithubEnv();
  calls = [];
  runner = {
    request: (async (command: RunnerCommandOf<RunnerCommandName>) => {
      calls.push(command);
      if (command.name === "session.configure" && command.sessionId === "gone") {
        throw Object.assign(new Error("unknown session"), { code: "unknown_session" });
      }
      return {};
    }) as RunnerPort["request"],
  } as unknown as RunnerPort;
});

afterEach(() => env.close());

describe("folders agents may write to, changed in Settings", () => {
  it("go to every open session at once, and a session the runner lost doesn't stop the rest", async () => {
    const idle = env.addSession({ status: "idle" });
    const running = env.addSession({ status: "running" });
    env.addSession({ status: "stopped" });
    const folders = ["E:\\PROJECTS", "E:\\claude"];
    const taken = await pushWritableFolders({ repo: env.repo, runner }, folders);
    expect(taken).toBe(2);
    const sent = calls.filter((c) => c.name === "session.configure");
    expect(sent.map((c) => c.name === "session.configure" && c.sessionId).sort()).toEqual(
      [idle.id, running.id].sort(),
    );
    expect(sent.every((c) => c.name === "session.configure" && c.writableFolders === folders)).toBe(
      true,
    );
  });
});
