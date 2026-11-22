import type { Project } from "@codeden/contracts";
import { ArrowDown, ArrowUp, Pin, PinOff, Trash2 } from "lucide-react";
import { useProjectActions } from "@/lib/project-actions";
import type { RowMenuEntry } from "./row-menu";

/** Where a project sits in its group (pinned or not), for Move up / Move down. */
export interface GroupPosition {
  index: number;
  count: number;
}

/**
 * A project row's menu (right-click and ⋯): pin or unpin, keyboard-friendly moves within its
 * group, and Remove project, which opens the confirmation (`onRemove`).
 */
export function useProjectMenu(
  project: Project,
  position: GroupPosition,
  onRemove: () => void,
): RowMenuEntry[] {
  const actions = useProjectActions();
  return [
    {
      label: project.pinned ? "Unpin" : "Pin",
      icon: project.pinned ? <PinOff /> : <Pin />,
      onSelect: () => void actions.setPinned(project, !project.pinned),
    },
    "separator",
    {
      label: "Move up",
      icon: <ArrowUp />,
      disabled: position.index === 0,
      onSelect: () => void actions.moveTo(project.id, position.index - 1),
    },
    {
      label: "Move down",
      icon: <ArrowDown />,
      disabled: position.index >= position.count - 1,
      onSelect: () => void actions.moveTo(project.id, position.index + 1),
    },
    "separator",
    {
      label: "Remove project",
      hint: "Deletes its folder too",
      icon: <Trash2 />,
      variant: "destructive",
      onSelect: onRemove,
    },
  ];
}
