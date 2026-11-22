import {
  type AgentEventOf,
  agentEventToNewEvent,
  NOTICE_BATCH_CODE,
  type Notice,
  type NoticeBatchData,
  type RawEventEnvelope,
} from "@codeden/contracts";
import type { EventStore } from "../../events/store";

/**
 * Notices a wake (or any message) delivered to a role session, shown as one batch of cards at
 * the start of the turn that carries them (§8.2: notices stay structured data up to the UI).
 * GitHub notices the agent got only as a summary come along folded (`summarized`).
 */
export class NoticeCards {
  private readonly pending = new Map<string, NoticeBatchData>();

  constructor(private readonly store: EventStore) {}

  /** Notices delivered with the next turn of `sessionId`, and those it only got summarized. */
  add(sessionId: string, notices: Notice[], summarized: Notice[] = []): void {
    const batch = this.pending.get(sessionId) ?? { notices: [], summarized: [] };
    this.pending.set(sessionId, {
      notices: [...batch.notices, ...notices],
      summarized: [...batch.summarized, ...summarized],
    });
  }

  /** Forget notices a turn was going to carry: its send failed, they wait for the next one. */
  remove(sessionId: string, ids: string[]): void {
    const batch = this.pending.get(sessionId);
    if (!batch) return;
    const keep = (n: Notice) => !ids.includes(n.id);
    const left = { notices: batch.notices.filter(keep), summarized: batch.summarized.filter(keep) };
    if (left.notices.length + left.summarized.length > 0) this.pending.set(sessionId, left);
    else this.pending.delete(sessionId);
  }

  /** Append the waiting cards to each role session whose turn just started. */
  attach(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (e.type !== "agent.turn.started" || !e.sessionId) continue;
      const batch = this.pending.get(e.sessionId);
      if (!batch) continue;
      this.pending.delete(e.sessionId);
      const event = e.payload as AgentEventOf<"turn.started">;
      const count = batch.notices.length + batch.summarized.length;
      this.store.append([
        agentEventToNewEvent(e.sessionId, {
          type: "item.completed",
          threadId: event.threadId,
          turnId: event.turnId,
          item: {
            id: `notices-${event.turnId}`,
            kind: "notice",
            status: "completed",
            level: "info",
            code: NOTICE_BATCH_CODE,
            message: `${count} update${count === 1 ? "" : "s"} since the last turn`,
            data: JSON.parse(JSON.stringify(batch)),
          },
        }),
      ]);
    }
  }
}
