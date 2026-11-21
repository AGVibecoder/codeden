import { existsSync, readFileSync } from "node:fs";
import { type McpServerEntry, McpStartCommand } from "@codeden/contracts";
import { z } from "zod";
import { ServiceError } from "../errors";
import { atomicWrite } from "./files";

const StoreFile = z.object({ commands: z.record(z.string(), McpStartCommand) });

/** What names a server here: its provider, scope, project (`local`, `project`) and name. */
export type McpStartKey = Pick<McpServerEntry, "provider" | "scope" | "name"> & {
  projectId?: string | null;
};

const keyOf = (k: McpStartKey) =>
  [k.provider, k.scope, k.scope === "user" ? "" : (k.projectId ?? ""), k.name].join("|");

/**
 * Start commands of `http` and `sse` MCP servers (§12.4). A start command is a path on this
 * machine, and running one from a file a repository shares would run whatever that file says,
 * so they live in CodeDen's data folder, never in a native config file.
 * One JSON file (`{ "commands": { "<provider>|<scope>|<project>|<name>": McpStartCommand } }`),
 * written atomically.
 */
export class McpStartCommands {
  constructor(readonly file: string) {}

  /** The server's start command; an unreadable file has none (writes still refuse). */
  get(key: McpStartKey): McpStartCommand | undefined {
    try {
      return this.read()[keyOf(key)];
    } catch {
      return undefined;
    }
  }

  /** Set (`command`) or remove (`null`) the server's start command. */
  set(key: McpStartKey, command: McpStartCommand | null): void {
    const commands = this.read();
    const id = keyOf(key);
    if (!command && !(id in commands)) return;
    if (command) commands[id] = command;
    else delete commands[id];
    atomicWrite(this.file, `${JSON.stringify({ commands }, null, 2)}\n`);
  }

  private read(): Record<string, McpStartCommand> {
    if (!existsSync(this.file)) return {};
    try {
      return StoreFile.parse(JSON.parse(readFileSync(this.file, "utf8"))).commands;
    } catch {
      throw new ServiceError(422, "start_commands_unreadable", `${this.file} could not be read`);
    }
  }
}
