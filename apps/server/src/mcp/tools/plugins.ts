import { z } from "zod";
import { defineTool, ToolError } from "../define";

/**
 * The plugin hub's tools (§12.4): the user's MCP servers are plugins, off until the agent needs
 * one. Shown only to agent sessions the hub applies to (`PluginHub.appliesTo`).
 */
const available: Parameters<typeof defineTool>[0]["isAvailable"] = (services, caller) => {
  if (!caller?.sessionId) return false;
  const found = services.sessionRepo.find(caller.sessionId);
  return found ? services.plugins.offersTo(found.session) : false;
};

export const listPlugins = defineTool({
  name: "list_plugins",
  description:
    "List the plugins (the user's MCP servers, such as an editor's or a browser's tools) you can switch on, and which are on. They are off until you need one, so they cost nothing meanwhile.",
  roles: ["agent"],
  scope: "session",
  alwaysLoad: true,
  isAvailable: available,
  input: z.object({}),
  handler: async (_input, { services, sessionId }) => {
    const plugins = services.plugins.list(sessionId);
    if (plugins.length === 0) return "No plugins are set up.";
    return plugins
      .map(
        (p) =>
          `- ${p.name}: ${p.on ? "on" : "off"}${p.startsProgram ? " (opens its program when switched on)" : ""}`,
      )
      .join("\n");
  },
});

export const usePlugin = defineTool({
  name: "use_plugin",
  description:
    "Switch a plugin on when your task needs its tools (for example unreal-mcp to work in the Unreal editor). CodeDen opens its program first when it isn't running, which can take a few minutes for an editor, then its tools become available to you as mcp__<plugin>__<tool>. Keep it on while you still need it.",
  roles: ["agent"],
  scope: "session",
  alwaysLoad: true,
  isAvailable: available,
  input: z.object({ name: z.string().min(1).max(200).describe("The plugin, from list_plugins") }),
  handler: async (input, { services, sessionId }) => {
    try {
      return await services.plugins.use(sessionId, input.name);
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error));
    }
  },
});

export const closePlugin = defineTool({
  name: "close_plugin",
  description:
    "Switch a plugin off when you no longer need it, so its tools stop costing context. Leave it on if you'll use it again soon. Plugins also go off when your session ends.",
  roles: ["agent"],
  scope: "session",
  isAvailable: available,
  input: z.object({ name: z.string().min(1).max(200) }),
  handler: async (input, { services, sessionId }) => {
    try {
      return await services.plugins.close(sessionId, input.name);
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error));
    }
  },
});

export const pluginTools = [listPlugins, usePlugin, closePlugin];
