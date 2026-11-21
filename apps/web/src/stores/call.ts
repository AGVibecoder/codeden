import {
  dictationLanguageFor,
  READ_ALOUD_FULL_MAX_CHARS,
  type Session,
  type SessionStatus,
  type Snapshot,
  speechExcerpt,
} from "@codeden/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import type { CodeDenClient } from "@/lib/api";
import { snapshotKey } from "@/lib/queries";
import { onLiveEvent } from "@/lib/realtime";
import { transcriptFromSnapshot } from "@/lib/transcript/reducer";
import { finalAssistantText } from "@/lib/transcript/timeline";
import { type CallState, VoiceCall } from "@/lib/voice/call";
import { createCloudStt } from "@/lib/voice/cloud-stt";
import { stt as browserStt } from "@/lib/voice/engines";
import { latestCompletedRootTurn, turnJustFinished } from "@/lib/voice/read-aloud";
import { cancelSpeech, speak } from "@/lib/voice/speak";
import { stripForSpeech } from "@/lib/voice/speech-text";

/**
 * Put in front of what you say in a call, so the orchestrator answers the way a voice call
 * needs: short and without anything that can't be spoken.
 */
export const CALL_HINT =
  "(Voice call: answer in one to three short spoken sentences, without markdown, lists or code.)";

interface CallStore {
  /** The call in progress, or the last one's final state; null before any call. */
  state: CallState | null;
  /** Microphone level while listening (0..1). */
  level: number | null;
  start: (first?: string) => void;
  hangUp: () => void;
}

let current: VoiceCall | null = null;
let deps: { client: CodeDenClient; queryClient: QueryClient } | null = null;

/** True while a call is on (read-aloud then leaves the orchestrator's answers to the call). */
export const callActive = () => (current ? current.phase !== "ended" : false);

/**
 * Calls `onReply` with the final message of every orchestrator turn that finishes from now
 * on; returns a stop.
 */
function watchOrchestrator(
  client: CodeDenClient,
  queryClient: QueryClient,
  onReply: (markdown: string) => void,
): () => void {
  const statuses = new Map<string, SessionStatus>();
  for (const s of queryClient.getQueryData<Snapshot>(snapshotKey)?.sessions ?? []) {
    statuses.set(s.id, s.status);
  }
  let stopped = false;
  const finished = (session: Session) => {
    void client
      .getSessionSnapshot(session.id, { turns: 3 })
      .then((snap) => {
        const state = transcriptFromSnapshot(snap);
        const turn = latestCompletedRootTurn(state);
        const text = turn ? finalAssistantText(state, turn) : null;
        if (text && !stopped) onReply(text);
      })
      .catch(() => undefined);
  };
  const stop = onLiveEvent((env) => {
    if (env.type !== "session.created" && env.type !== "session.updated") return;
    const session = env.payload.session;
    const prev = statuses.get(session.id);
    statuses.set(session.id, session.status);
    if (session.role === "orchestrator" && turnJustFinished(prev, session.status)) {
      finished(session);
    }
  });
  return () => {
    stopped = true;
    stop();
  };
}

/** Voice calls with the orchestrator (§11.3): one call at a time, kept across pages. */
export const useCallStore = create<CallStore>()((set) => ({
  state: null,
  level: null,
  start(first) {
    if (!deps || callActive()) return;
    const { client, queryClient } = deps;
    const settings = queryClient.getQueryData<Snapshot>(snapshotKey)?.settings;
    if (!settings) return;
    const choice = settings.voice.dictation.engine;
    const engine = choice === "browser" ? browserStt : createCloudStt(client, choice);
    if (!engine.supported) {
      set({
        state: {
          phase: "ended",
          heard: "",
          draft: "",
          reply: "",
          error: "Dictation isn't available here",
        },
      });
      return;
    }
    const call = new VoiceCall({
      engine,
      language: dictationLanguageFor(settings.voice.dictation, choice),
      audio: settings.voice.call.audio,
      send: async (text) => {
        await client.orchestration.send(
          "orchestrator",
          null,
          { text: `${CALL_HINT}\n\n${text}` },
          "queue",
        );
      },
      watchReplies: (onReply) => watchOrchestrator(client, queryClient, onReply),
      speak: async (markdown, signal) => {
        const now = queryClient.getQueryData<Snapshot>(snapshotKey)?.settings ?? settings;
        const words = speechExcerpt(stripForSpeech(markdown), READ_ALOUD_FULL_MAX_CHARS);
        if (!words) return;
        const onAbort = () => cancelSpeech();
        signal.addEventListener("abort", onAbort);
        try {
          await speak(client, now, words);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      },
      onState: (state) => set({ state }),
      onLevel: (level) => set({ level }),
    });
    current = call;
    call.start(first);
  },
  hangUp() {
    current?.hangUp();
  },
}));

/** Give calls the client and query cache (the app shell does this once). */
export function initCalls(client: CodeDenClient, queryClient: QueryClient): () => void {
  deps = { client, queryClient };
  return () => {
    current?.hangUp();
    current = null;
    deps = null;
  };
}
