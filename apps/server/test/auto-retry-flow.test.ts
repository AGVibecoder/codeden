import { StartSessionResponse } from "@codeden/contracts";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type Harness, startHarness, waitUntil } from "./support/harness";

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ autoRetry: { delaysMs: [50, 50, 50] } });
});

afterAll(async () => {
  await h?.close();
});

const messages = (id: string) => {
  const session = h.server.services.sessionRepo.get(id);
  if (!session.rootThreadId) return [];
  return h.server.services.sessionRepo
    .threadPage(id, session.rootThreadId, { limit: 200 })
    .items.flatMap((r) => (r.item.kind === "user_message" ? [r.item.input] : []));
};

it("retries a session whose turn failed on an overloaded API with its briefing", async () => {
  const id = await h.startFakeSession("Do the work [fail:transient]");
  // The Fake answers the briefing normally.
  await waitUntil(async () => (messages(id).length >= 2 ? true : undefined));
  const detail = await waitUntil(async () => {
    const d = await h.detail(id);
    return d.session.status === "idle" && messages(id).length === 2 ? d : undefined;
  });
  const briefing = messages(id)[1];
  expect(briefing?.from).toBe("codeden");
  expect(briefing?.text).toContain(
    "## Your task, as you were given it\n\nDo the work [fail:transient]",
  );
  expect(briefing?.text).toContain("passing error while you were working. (Scripted overload)");
  expect(detail.session.status).toBe("idle");
  expect(h.server.services.inbox.list({ sessionId: id }).map((i) => i.kind)).toEqual([]);
});

it("cuts a session off at its usage limit, and continues it with a briefing on Continue", async () => {
  // Not `startFakeSession`, which waits for the session to go idle: this one is cut off.
  const res = await h.api("POST", "/sessions", {
    projectId: h.projectId,
    provider: "fake",
    purpose: "Usage-limited work",
    input: { text: "Do the work [fail:usage]" },
  });
  const started = StartSessionResponse.parse(res.body);
  if (started.status !== "started") throw new Error(started.status);
  const id = started.sessionId;
  const cut = await waitUntil(async () => {
    const s = h.server.services.sessionRepo.get(id);
    return s.status === "interrupted" && s.cutOff ? s : undefined;
  });
  expect(cut.cutOff).toMatchObject({ reason: "usage_limit", continueWhenReset: false });
  const { cutOffs } = h.server.services;
  // Before the reset Continue is refused; nothing continues it by itself.
  if (Date.parse(cut.cutOff?.resetsAt ?? "") > Date.now()) {
    await expect(cutOffs.continue(id, { mode: "now" })).rejects.toMatchObject({
      code: "usage_not_reset",
    });
  }
  await waitUntil(async () =>
    Date.parse(cut.cutOff?.resetsAt ?? "") <= Date.now() ? true : undefined,
  );
  expect(messages(id)).toHaveLength(1);
  await expect(cutOffs.continue(id, { mode: "now" })).resolves.toEqual({ status: "continued" });
  await waitUntil(async () =>
    h.server.services.sessionRepo.get(id).status === "idle" ? true : undefined,
  );
  expect(messages(id)[1]?.text).toContain("usage limit was reached while you were working");
  expect(h.server.services.sessionRepo.get(id).cutOff).toBeNull();
});
