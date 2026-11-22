import { canContinueAt } from "@codeden/contracts";
import { z } from "zod";
import { defineTool } from "../../define";

/** `list_cut_off_sessions` (§4.2): sessions whose work was cut off and that wait for a Continue. */
export const listCutOffSessions = defineTool({
  name: "list_cut_off_sessions",
  description:
    "Sessions whose work was cut off (CodeDen closed or crashed mid-turn, or a usage limit) and that wait for someone to continue them. Nothing continues them by itself. Tell the user about them; continue one only when the user asks.",
  roles: ["orchestrator"],
  scope: "global",
  alwaysLoad: true,
  input: z.object({}),
  handler: async (_input, { services }) => {
    const now = Date.now();
    const sessions = services.cutOffs.list();
    return {
      count: sessions.length,
      sessions: sessions.map((s) => ({
        sessionId: s.id,
        projectId: s.projectId,
        title: s.title ?? s.purpose,
        reason: s.cutOff?.reason,
        cutOffAt: s.cutOff?.at,
        usageResetsAt: s.cutOff?.resetsAt ?? null,
        canContinueNow: s.cutOff ? canContinueAt(s.cutOff, now) : false,
        continuesWhenUsageResets: s.cutOff?.continueWhenReset ?? false,
      })),
    };
  },
});

/** `continue_session` (§4.2): continue a cut-off session with its briefing, as Continue does. */
export const continueSession = defineTool({
  name: "continue_session",
  description:
    "Continue a cut-off session, as its Continue button does: CodeDen sends it a briefing read from its log (its original task, where it was, why it stopped, what it already changed) and asks it to check where things stand before picking up. Use only when the user asks. `when_usage_resets` makes a session stopped by a usage limit continue by itself once usage resets; `cancel` undoes that.",
  roles: ["orchestrator"],
  scope: "global",
  alwaysLoad: true,
  input: z.object({
    sessionId: z.string().min(1),
    mode: z.enum(["now", "when_usage_resets", "cancel"]).optional(),
  }),
  handler: async ({ sessionId, mode }, { services }) => {
    const res = await services.cutOffs.continue(sessionId, { mode: mode ?? "now" });
    if (res.status === "scheduled") return `Session ${sessionId} continues once usage resets.`;
    if (res.status === "cancelled") return `Session ${sessionId} waits for Continue again.`;
    return `Session ${sessionId} is continuing with its briefing.`;
  },
});
