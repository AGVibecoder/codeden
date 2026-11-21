import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { CHATTERBOX_DEFAULT_VOICE, type ChatterboxVoice } from "@codeden/contracts";
import { z } from "zod";
import { atomicWrite } from "../../agent-config/files";
import { badRequest, notFound } from "../../errors";

/** Sound files Chatterbox reads without extra tools. */
export const VOICE_EXTENSIONS = [".wav", ".mp3", ".flac", ".ogg"];

const StoredVoice = z.object({ id: z.string(), name: z.string(), file: z.string() });
const StoreFile = z.object({ voices: z.array(StoredVoice) });
type StoredVoice = z.infer<typeof StoredVoice>;

/**
 * Chatterbox's voices (§11.3): the built-in Annie clip shipped with CodeDen, and clips the user
 * added, kept in `<home>/deps/chatterbox/voices` with a `voices.json` naming them.
 */
export class ChatterboxVoices {
  constructor(
    private readonly dir: string,
    /** The built-in voice's clip, or null when CodeDen's Chatterbox files aren't found. */
    private readonly builtIn: string | null,
  ) {}

  private get index(): string {
    return join(this.dir, "voices.json");
  }

  private read(): StoredVoice[] {
    if (!existsSync(this.index)) return [];
    try {
      return StoreFile.parse(JSON.parse(readFileSync(this.index, "utf8"))).voices;
    } catch {
      return [];
    }
  }

  private write(voices: StoredVoice[]): void {
    mkdirSync(this.dir, { recursive: true });
    atomicWrite(this.index, `${JSON.stringify({ voices }, null, 2)}\n`);
  }

  list(): ChatterboxVoice[] {
    const own = this.read()
      .filter((v) => existsSync(join(this.dir, v.file)))
      .map((v) => ({ id: v.id, name: v.name, builtIn: false }));
    return [
      ...(this.builtIn ? [{ id: CHATTERBOX_DEFAULT_VOICE, name: "Annie", builtIn: true }] : []),
      ...own,
    ];
  }

  /** The clip of a voice; the built-in one for an unknown or missing voice. */
  path(id: string | undefined | null): string | null {
    const found =
      id && id !== CHATTERBOX_DEFAULT_VOICE ? this.read().find((v) => v.id === id) : null;
    if (found && existsSync(join(this.dir, found.file))) return join(this.dir, found.file);
    return this.builtIn;
  }

  /** Store a new clip; returns its id and path (the caller checks its length). */
  add(name: string, bytes: Uint8Array, fileName: string): { id: string; path: string } {
    const ext = extname(fileName).toLowerCase();
    if (!VOICE_EXTENSIONS.includes(ext)) {
      throw badRequest(
        `Use a ${VOICE_EXTENSIONS.join(", ")} file for a voice`,
        "unsupported_voice_file",
      );
    }
    if (bytes.byteLength === 0) throw badRequest("The voice file is empty", "empty_voice_file");
    mkdirSync(this.dir, { recursive: true });
    const id = randomUUID();
    const file = `${id}${ext}`;
    writeFileSync(join(this.dir, file), bytes);
    this.write([...this.read(), { id, name, file }]);
    return { id, path: join(this.dir, file) };
  }

  remove(id: string): void {
    const voices = this.read();
    const found = voices.find((v) => v.id === id);
    if (!found) throw notFound("That voice doesn't exist", "voice_not_found");
    this.write(voices.filter((v) => v.id !== id));
    rmSync(join(this.dir, found.file), { force: true });
  }
}
