import type { GithubUpdatesLevel, Project } from "@codeden/contracts";
import { ChevronDown, GitPullRequest } from "lucide-react";
import { Segmented, SettingsSection } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProjectActions } from "@/lib/project-actions";
import { cn } from "@/lib/utils";

/** The levels in menu order, with what each lets reach the PM's chat (`Project.githubUpdates`). */
export const GITHUB_UPDATES_LEVELS: Array<{
  value: GithubUpdatesLevel;
  label: string;
  help: string;
}> = [
  {
    value: "off",
    label: "Off",
    help: "Nothing reaches the PM. GitHub activity stays on the project page, where the orchestrator can look it up.",
  },
  {
    value: "digest",
    label: "Digest",
    help: "Nothing live. The PM gets a short summary in its next turn.",
  },
  {
    value: "important",
    label: "Important",
    help: "Only news about our own work: failed checks, change requests, merges and merge conflicts on PRs CodeDen opened.",
  },
  {
    value: "all",
    label: "All",
    help: "Everything, including other people's issues and PRs, batched to at most one wake every 15 minutes.",
  },
];

export const githubUpdatesLabel = (level: GithubUpdatesLevel) =>
  GITHUB_UPDATES_LEVELS.find((l) => l.value === level)?.label ?? level;

/** One step quieter, for "Mute these" on a batch of GitHub updates; null when nothing is live. */
export function quieterLevel(level: GithubUpdatesLevel): GithubUpdatesLevel | null {
  if (level === "all") return "important";
  if (level === "important") return "digest";
  return null;
}

/** "GitHub: Important ▾" in the PM chat header: which GitHub activity reaches this chat. */
export function GithubUpdatesChip({
  project,
  className,
}: {
  project: Project;
  className?: string;
}) {
  const { setGithubUpdates } = useProjectActions();
  const level = project.githubUpdates;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          className={cn("h-6 gap-1 px-2 text-2xs font-normal text-muted-foreground", className)}
          aria-label={`GitHub updates: ${githubUpdatesLabel(level)}`}
          data-testid="github-updates-chip"
        >
          <GitPullRequest className="size-3" />
          GitHub: {githubUpdatesLabel(level)}
          <ChevronDown className="size-3 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel className="text-2xs">
          What GitHub activity reaches this chat
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={level}
          onValueChange={(v) => void setGithubUpdates(project, v as GithubUpdatesLevel)}
        >
          {GITHUB_UPDATES_LEVELS.map((l) => (
            <DropdownMenuRadioItem key={l.value} value={l.value} className="items-start py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px]">
                  {l.label}
                  {l.value === "important" && (
                    <span className="ml-1.5 text-2xs text-muted-foreground">default</span>
                  )}
                </span>
                <span className="block text-2xs text-muted-foreground">{l.help}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Project page > Settings: which GitHub activity wakes the PM and reaches its chat. */
export function ProjectGithubUpdates({ project }: { project: Project }) {
  const { setGithubUpdates } = useProjectActions();
  const level = project.githubUpdates;
  return (
    <SettingsSection
      title="GitHub updates"
      description="Which GitHub activity on this repository wakes the project manager and shows up in its chat. Everything stays on the GitHub tab either way."
    >
      <div className="space-y-3 px-4 py-3.5">
        <Segmented<GithubUpdatesLevel>
          value={level}
          onChange={(next) => {
            if (next !== level) void setGithubUpdates(project, next);
          }}
          options={GITHUB_UPDATES_LEVELS.map(({ value, label }) => ({ value, label }))}
        />
        <p className="text-2xs text-muted-foreground">
          {GITHUB_UPDATES_LEVELS.find((l) => l.value === level)?.help}
        </p>
      </div>
    </SettingsSection>
  );
}
