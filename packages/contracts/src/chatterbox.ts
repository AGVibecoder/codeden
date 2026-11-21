import { z } from "zod";

/**
 * Chatterbox, a local read-aloud engine (§11.3): installed on demand into the CodeDen home
 * (its own Python, PyTorch for the graphics card, Chatterbox and a model), then run by the
 * server. English uses Chatterbox Turbo; every other language Chatterbox Multilingual. Voices
 * are short speech clips Chatterbox copies: Annie is built in, users add their own.
 */

/** The languages Chatterbox speaks (ISO 639-1). English uses Turbo, the rest Multilingual. */
export const CHATTERBOX_LANGUAGES = {
  ar: "Arabic",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  es: "Spanish",
  fi: "Finnish",
  fr: "French",
  he: "Hebrew",
  hi: "Hindi",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  ms: "Malay",
  nl: "Dutch",
  no: "Norwegian",
  pl: "Polish",
  pt: "Portuguese",
  ru: "Russian",
  sv: "Swedish",
  sw: "Swahili",
  tr: "Turkish",
  zh: "Chinese",
} as const;

export const ChatterboxLanguage = z.enum(
  Object.keys(CHATTERBOX_LANGUAGES) as [keyof typeof CHATTERBOX_LANGUAGES],
);
export type ChatterboxLanguage = z.infer<typeof ChatterboxLanguage>;

/** `turbo`: English only and fast. `multilingual`: 23 languages. */
export const ChatterboxModel = z.enum(["turbo", "multilingual"]);
export type ChatterboxModel = z.infer<typeof ChatterboxModel>;

/** The model a language is spoken with. */
export function chatterboxModelFor(language: ChatterboxLanguage): ChatterboxModel {
  return language === "en" ? "turbo" : "multilingual";
}

/** The graphics card family the install picks PyTorch for. */
export const ChatterboxGpu = z.enum(["nvidia", "amd"]);
export type ChatterboxGpu = z.infer<typeof ChatterboxGpu>;

/** The built-in voice. */
export const CHATTERBOX_DEFAULT_VOICE = "annie";
/** Shortest and longest voice clip, in seconds (Chatterbox needs more than 5). */
export const CHATTERBOX_VOICE_MIN_SECONDS = 6;
export const CHATTERBOX_VOICE_MAX_SECONDS = 60;
/** Largest voice file accepted, in bytes. */
export const CHATTERBOX_VOICE_MAX_BYTES = 20 * 1024 * 1024;
/** Longest text spoken in one request. */
export const CHATTERBOX_MAX_TEXT = 6_000;

/**
 * Where a part stands: `missing`, `installing` (with `step` on the status), `installed`, or
 * `failed` (the last attempt's `error`; installing again retries).
 */
export const ChatterboxPartState = z.enum(["missing", "installing", "installed", "failed"]);
export type ChatterboxPartState = z.infer<typeof ChatterboxPartState>;

/** One voice: the built-in one or a clip the user added. */
export const ChatterboxVoice = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  builtIn: z.boolean(),
});
export type ChatterboxVoice = z.infer<typeof ChatterboxVoice>;

/** `GET /api/voice/chatterbox`: the engine on this machine. */
export const ChatterboxStatus = z.object({
  /** False where the install can't run (`unsupportedReason` says why). */
  supported: z.boolean(),
  unsupportedReason: z.string().nullable(),
  /** The card found, or null when none is supported. */
  gpu: ChatterboxGpu.nullable(),
  /** The card's name as the system reports it. */
  gpuName: z.string().nullable(),
  /** Python, PyTorch and Chatterbox. */
  runtime: ChatterboxPartState,
  models: z.object({ turbo: ChatterboxPartState, multilingual: ChatterboxPartState }),
  /** What an install is doing right now, e.g. `Installing PyTorch for AMD (about 3 GB)`. */
  step: z.string().nullable(),
  /** The last line the install printed, to show it is moving. */
  detail: z.string().nullable(),
  error: z.string().nullable(),
  voices: z.array(ChatterboxVoice),
  /** The folder everything is installed in. */
  location: z.string(),
});
export type ChatterboxStatus = z.infer<typeof ChatterboxStatus>;

/**
 * `POST /api/voice/chatterbox/install`: install the runtime when missing, then `model`.
 * Returns right away with the new status; the UI polls while anything is installing.
 */
export const ChatterboxInstallRequest = z.object({ model: ChatterboxModel });
export type ChatterboxInstallRequest = z.infer<typeof ChatterboxInstallRequest>;

/**
 * `POST /api/voice/chatterbox/speak`: `audio/wav` of `text` in `voice` (the built-in one when
 * omitted), with the model `language` needs.
 */
export const ChatterboxSpeakRequest = z.object({
  text: z.string().min(1).max(CHATTERBOX_MAX_TEXT),
  language: ChatterboxLanguage,
  voice: z.string().min(1).max(100).optional(),
});
export type ChatterboxSpeakRequest = z.infer<typeof ChatterboxSpeakRequest>;

/**
 * `POST /api/voice/chatterbox/voices` (multipart: `name` and `file`, a speech clip of
 * `CHATTERBOX_VOICE_MIN_SECONDS` to `CHATTERBOX_VOICE_MAX_SECONDS`) adds a voice;
 * `DELETE /api/voice/chatterbox/voices/:id` removes one. Both return the new status.
 */
export const ChatterboxVoiceName = z.string().trim().min(1).max(100);
