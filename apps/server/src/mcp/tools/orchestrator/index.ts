import type { AnyServerTool } from "../../define";
import { continueSession, listCutOffSessions } from "./cut-off";
import { askPm, getOverview, listInbox, messagePm } from "./messaging";
import { createProject, listProjects, updateProject } from "./projects";

/** Orchestrator tools (§8.3). */
export const orchestratorTools: AnyServerTool[] = [
  getOverview,
  listProjects,
  createProject,
  updateProject,
  messagePm,
  askPm,
  listInbox,
  listCutOffSessions,
  continueSession,
];
