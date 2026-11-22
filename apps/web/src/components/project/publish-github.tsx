import type { Project, PublishGithubPlan } from "@codeden/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CloudUpload, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Segmented } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useClient } from "@/lib/api";

const TEMPLATE_NAME: Record<NonNullable<PublishGithubPlan["template"]>, string> = {
  unreal: "Unreal",
  unity: "Unity",
  node: "Node.js",
  python: "Python",
};

function megabytes(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** What publishing will do, in plain steps. */
function Steps({ plan }: { plan: PublishGithubPlan }) {
  const steps: string[] = [];
  if (!plan.isGitRepo) steps.push("Create a git repository in the project folder.");
  if (plan.addsGitignore && plan.template) {
    steps.push(
      plan.template === "unreal"
        ? "Add a .gitignore for Unreal that leaves out Binaries, Intermediate, Saved and DerivedDataCache."
        : `Add a .gitignore for ${TEMPLATE_NAME[plan.template]}.`,
    );
  }
  if (plan.lfsPatterns.length) {
    steps.push(`Store large files with Git LFS: ${plan.lfsPatterns.join(", ")}.`);
  }
  if (!plan.hasCommits && plan.files !== null && plan.bytes !== null) {
    steps.push(
      `Make a first commit of about ${plan.files.toLocaleString()} files (${megabytes(plan.bytes)}).`,
    );
  }
  steps.push("Create the repository on GitHub and push to it.");
  steps.push("Turn this into a GitHub project in CodeDen.");
  return (
    <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
      {steps.map((s) => (
        <li key={s}>{s}</li>
      ))}
    </ol>
  );
}

/**
 * "Publish to GitHub" on a local project's home page (§9): a dialog that shows what will
 * happen (a git repository, a `.gitignore`, Git LFS, a first commit), then creates the
 * repository, pushes, and turns the project into a GitHub project.
 */
export function PublishGithubButton({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <CloudUpload /> Publish to GitHub
      </Button>
      {open && <PublishGithubDialog project={project} onClose={() => setOpen(false)} />}
    </>
  );
}

function PublishGithubDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const client = useClient();
  const plan = useQuery({
    queryKey: ["publish-github-plan", project.id],
    queryFn: () => client.publishGithubPlan(project.id),
    retry: false,
  });
  const [owner, setOwner] = useState("");
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  useEffect(() => {
    if (!plan.data) return;
    setOwner((o) => o || plan.data.owners[0] || "");
    setName((n) => n || plan.data.suggestedName);
  }, [plan.data]);

  const publish = useMutation({
    mutationFn: () =>
      client.publishGithub(project.id, { owner, name, private: visibility === "private" }),
    onSuccess: (r) => {
      toast.success(`Published to ${owner}/${name}`, {
        action: { label: "Open", onClick: () => window.open(r.url, "_blank") },
      });
      onClose();
    },
    onError: (e: Error) => toast.error("Couldn't publish", { description: e.message }),
  });

  const data = plan.data;
  const validName = /^[A-Za-z0-9._-]+$/.test(name);
  const blocked = data?.blocked ?? (data?.tooLarge.length ? "Some files are too large." : null);
  const ready = Boolean(data && !blocked && owner && validName && !publish.isPending);

  return (
    <Dialog open onOpenChange={(o) => !o && !publish.isPending && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish {project.name} to GitHub</DialogTitle>
          <DialogDescription>
            Creates a GitHub repository for this folder and pushes it. Then GitHub features (issues,
            pull requests, the software factory) work for this project.
          </DialogDescription>
        </DialogHeader>
        {plan.isLoading && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Looking at the folder…
          </p>
        )}
        {plan.error && <p className="text-xs text-status-failed">{plan.error.message}</p>}
        {data && (
          <div className="space-y-4">
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs">
              <span className="text-muted-foreground">Owner</span>
              <Select value={owner} onValueChange={setOwner} disabled={!data.owners.length}>
                <SelectTrigger className="h-8 text-xs" aria-label="Owner">
                  <SelectValue placeholder="Not connected" />
                </SelectTrigger>
                <SelectContent position="popper">
                  {data.owners.map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-muted-foreground">Name</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-8 text-xs"
                aria-label="Repository name"
              />
              <span className="text-muted-foreground">Visibility</span>
              <Segmented
                value={visibility}
                onChange={setVisibility}
                options={[
                  { value: "private", label: "Private" },
                  { value: "public", label: "Public" },
                ]}
              />
            </div>
            {!validName && name && (
              <p className="text-xs text-status-failed">
                Use letters, digits, ".", "-" and "_" only.
              </p>
            )}
            <div className="space-y-1.5">
              <p className="text-xs font-medium">What happens</p>
              <Steps plan={data} />
            </div>
            {data.tooLarge.length > 0 && (
              <p className="flex gap-2 text-xs text-status-failed">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                GitHub refuses files over 100 MB: {data.tooLarge.slice(0, 5).join(", ")}
                {data.tooLarge.length > 5 ? "…" : ""}. Delete them or add them to .gitignore.
              </p>
            )}
            {data.blocked && (
              <p className="flex gap-2 text-xs text-status-failed">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {data.blocked}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={publish.isPending}>
            Cancel
          </Button>
          <Button onClick={() => publish.mutate()} disabled={!ready}>
            {publish.isPending ? (
              <>
                <Loader2 className="animate-spin" /> Publishing… (a big project takes a while)
              </>
            ) : (
              <>
                <CloudUpload /> Publish
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
