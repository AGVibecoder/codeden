import { describe, expect, it } from "vitest";
import {
  ChatterboxInstallRequest,
  ChatterboxSpeakRequest,
  ChatterboxStatus,
  chatterboxModelFor,
  dictationLanguageFor,
  dictationLanguages,
  isoLanguage,
  Settings,
} from "../src";

describe("chatterbox contracts", () => {
  it("speaks English with Turbo and every other language with Multilingual", () => {
    expect(chatterboxModelFor("en")).toBe("turbo");
    expect(chatterboxModelFor("nl")).toBe("multilingual");
    expect(chatterboxModelFor("zh")).toBe("multilingual");
  });

  it("round-trips a status, an install and a speak request", () => {
    const status = {
      supported: true,
      unsupportedReason: null,
      gpu: "amd",
      gpuName: "AMD Radeon RX 7900 XTX",
      runtime: "installed",
      models: { turbo: "installed", multilingual: "installing" },
      step: "Downloading Chatterbox Multilingual (about 3 GB)",
      detail: "Fetching 6 files",
      error: null,
      voices: [{ id: "annie", name: "Annie", builtIn: true }],
      location: "C:/Users/me/.codeden/deps/chatterbox",
    };
    expect(ChatterboxStatus.parse(status)).toEqual(status);
    expect(ChatterboxInstallRequest.parse({ model: "turbo" })).toEqual({ model: "turbo" });
    expect(ChatterboxSpeakRequest.parse({ text: "Hoi", language: "nl" })).toEqual({
      text: "Hoi",
      language: "nl",
    });
    expect(ChatterboxSpeakRequest.safeParse({ text: "Hi", language: "xx" }).success).toBe(false);
  });

  it("reads dictation languages, falling back to the older single language", () => {
    expect(dictationLanguages({ languages: ["nl-NL", "en-US"], language: "de-DE" })).toEqual([
      "nl-NL",
      "en-US",
    ]);
    expect(dictationLanguages({ languages: [], language: "de-DE" })).toEqual(["de-DE"]);
    expect(dictationLanguages({ languages: [], language: null })).toEqual([]);
    const two = { languages: ["nl-NL", "en-US"] };
    expect(dictationLanguageFor(two, "browser")).toBe("nl-NL");
    expect(dictationLanguageFor(two, "local")).toBeNull();
    expect(dictationLanguageFor({ languages: ["fr-FR"] }, "openai")).toBe("fr-FR");
    expect(isoLanguage("pt-BR")).toBe("pt");
    expect(Settings.parse({}).voice.dictation.languages).toEqual([]);
  });

  it("defaults the call's wake word to off with Hey Annie", () => {
    expect(Settings.parse({}).voice.call.wakeWord).toEqual({ enabled: false, phrase: "Hey Annie" });
    expect(Settings.parse({}).voice.call.audio).toBe("speakers");
    expect(
      Settings.parse({ voice: { call: { wakeWord: { enabled: true, phrase: "Hey Den" } } } }).voice
        .call.wakeWord,
    ).toEqual({ enabled: true, phrase: "Hey Den" });
  });

  it("defaults read-aloud to English and keeps settings without the new fields valid", () => {
    const ra = Settings.parse({ voice: { readAloud: { engine: "browser" } } }).voice.readAloud;
    expect(ra.language).toBe("en");
    expect(
      Settings.parse({ voice: { readAloud: { engine: "chatterbox", language: "nl" } } }).voice
        .readAloud,
    ).toMatchObject({ engine: "chatterbox", language: "nl" });
  });
});
