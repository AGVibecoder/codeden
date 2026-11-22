import type { Project } from "@codeden/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useClient } from "@/lib/api";

/**
 * Confirm removing a project (§9): its sessions stop and are archived, it leaves the sidebar,
 * and its folder is deleted from disk, permanently. The dialog names the folder.
 */
export function RemoveProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = useClient();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (l) => l.pathname });
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      const res = await client.removeProject(project.id, { deleteFolder: true });
      onOpenChange(false);
      if (pathname.startsWith(`/projects/${project.id}`)) void navigate({ to: "/" });
      toast.success(`Removed ${project.name}`, { description: `Deleted ${res.path}` });
    } catch (error) {
      toast.error(`Couldn't remove ${project.name}`, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {project.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its sessions stop and the project leaves CodeDen. The folder below and everything in it
            is deleted from disk permanently. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <code className="block break-all rounded-md bg-muted px-2 py-1.5 text-xs">
          {project.path}
        </code>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={(event) => {
              // Stay open until the server answers, so a refusal shows here.
              event.preventDefault();
              void remove();
            }}
          >
            {busy ? "Removing…" : "Remove and delete folder"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
