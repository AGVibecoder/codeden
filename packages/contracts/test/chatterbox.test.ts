import { describe, expect, it } from "vitest";
import {
  ChatterboxInstallRequest,
  ChatterboxSpeakRequest,
  ChatterboxStatus,
  chatterboxModelFor,
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

  it("defaults read-aloud to English and keeps settings without the new fields valid", () => {
    const ra = Settings.parse({ voice: { readAloud: { engine: "browser" } } }).voice.readAloud;
    expect(ra.language).toBe("en");
    expect(
      Settings.parse({ voice: { readAloud: { engine: "chatterbox", language: "nl" } } }).voice
        .readAloud,
    ).toMatchObject({ engine: "chatterbox", language: "nl" });
  });
});
