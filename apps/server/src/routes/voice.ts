import {
  CHATTERBOX_VOICE_MAX_BYTES,
  ChatterboxInstallRequest,
  ChatterboxSpeakRequest,
  type ChatterboxStatus,
  ChatterboxVoiceName,
  LocalSttModelParams,
  type LocalSttStatus,
  SttQuery,
  TtsRequest,
  type VoiceListResponse,
} from "@codeden/contracts";
import { Hono } from "hono";
import type { AppServices } from "../services/container";
import { badRequest, ServiceError } from "../services/errors";
import { MAX_AUDIO_BYTES } from "../services/voice/voice-service";
import { jsonBody, queryOf } from "./validate";

/** File extension by media type, so the providers can tell the container format. */
const AUDIO_EXTENSIONS: Array<[RegExp, string]> = [
  [/webm/, ".webm"],
  [/ogg/, ".ogg"],
  [/wav/, ".wav"],
  [/mp4|m4a|aac/, ".m4a"],
  [/mpeg|mp3/, ".mp3"],
];

function modelId(raw: string) {
  const parsed = LocalSttModelParams.safeParse({ id: raw });
  if (!parsed.success) throw badRequest(`Unknown Whisper model: ${raw}`, "unknown_model");
  return parsed.data.id;
}

/**
 * `/api/voice/*` (§11.3): the ElevenLabs voice picker, local Whisper's status, downloads and
 * deletes, and Chatterbox's install, voices and speech.
 */
export function voiceRoutes(s: AppServices) {
  return new Hono()
    .get("/voices", async (c) => {
      const body: VoiceListResponse = { voices: await s.voice.voices() };
      return c.json(body);
    })
    .get("/local", (c) => c.json<LocalSttStatus>(s.localStt.status()))
    .post("/local/models/:id/download", (c) =>
      c.json<LocalSttStatus>(s.localStt.download(modelId(c.req.param("id")))),
    )
    .delete("/local/models/:id", async (c) =>
      c.json<LocalSttStatus>(await s.localStt.remove(modelId(c.req.param("id")))),
    )
    .get("/chatterbox", async (c) => c.json<ChatterboxStatus>(await s.chatterbox.status()))
    .post("/chatterbox/install", jsonBody(ChatterboxInstallRequest), async (c) =>
      c.json<ChatterboxStatus>(await s.chatterbox.install(c.req.valid("json"))),
    )
    .post("/chatterbox/speak", jsonBody(ChatterboxSpeakRequest), async (c) => {
      const audio = await s.chatterbox.speak(c.req.valid("json"));
      return new Response(audio, {
        status: 200,
        headers: {
          "content-type": "audio/wav",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    })
    .post("/chatterbox/voices", async (c) => {
      const declared = Number(c.req.header("content-length") ?? 0);
      if (declared > CHATTERBOX_VOICE_MAX_BYTES + 64 * 1024) {
        throw new ServiceError(413, "voice_too_large", "The voice file is larger than 20 MB");
      }
      const form = await c.req.formData();
      const file = form.get("file");
      const name = ChatterboxVoiceName.safeParse(form.get("name"));
      if (!(file instanceof File)) throw badRequest("Expected a `file` field with the voice clip");
      if (!name.success) throw badRequest("Give the voice a name of up to 100 characters");
      if (file.size > CHATTERBOX_VOICE_MAX_BYTES) {
        throw new ServiceError(413, "voice_too_large", "The voice file is larger than 20 MB");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      return c.json<ChatterboxStatus>(await s.chatterbox.addVoice(name.data, bytes, file.name));
    })
    .delete("/chatterbox/voices/:id", async (c) =>
      c.json<ChatterboxStatus>(await s.chatterbox.removeVoice(c.req.param("id"))),
    );
}

/**
 * `POST /api/tts` (streamed MP3) and `POST /api/stt` (transcription with a cloud engine or
 * local Whisper).
 */
export function speechRoutes(s: AppServices) {
  return new Hono()
    .post("/tts", jsonBody(TtsRequest), async (c) => {
      const upstream = await s.voice.speak(c.req.valid("json"), c.req.raw.signal);
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "audio/mpeg",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    })
    .post("/stt", queryOf(SttQuery), async (c) => {
      const declared = Number(c.req.header("content-length") ?? 0);
      if (declared > MAX_AUDIO_BYTES) {
        throw new ServiceError(413, "audio_too_large", "Audio is larger than 25 MB");
      }
      const type = c.req.header("content-type") ?? "application/octet-stream";
      let bytes: Uint8Array;
      let mediaType = type.split(";")[0]?.trim() || "application/octet-stream";
      let fileName = "speech";
      if (type.startsWith("multipart/form-data")) {
        const form = await c.req.formData();
        const file = form.get("file");
        if (!(file instanceof Blob)) {
          throw new ServiceError(400, "empty_audio", "Expected a `file` field with the audio");
        }
        bytes = new Uint8Array(await file.arrayBuffer());
        mediaType = file.type || mediaType;
        if (file instanceof File && file.name) fileName = file.name;
      } else {
        bytes = new Uint8Array(await c.req.arrayBuffer());
      }
      const ext = AUDIO_EXTENSIONS.find(([re]) => re.test(mediaType))?.[1] ?? "";
      if (!/\.[a-z0-9]+$/i.test(fileName)) fileName += ext;
      const { engine, language } = c.req.valid("query");
      return c.json(
        await s.voice.transcribe(
          { bytes, mediaType, fileName },
          { engine, language, signal: c.req.raw.signal },
        ),
      );
    });
}
