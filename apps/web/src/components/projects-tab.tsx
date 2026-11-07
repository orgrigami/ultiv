/**
 * A bot's Projects tab (Crew › Projects): the goals it works toward over
 * days. Each card shows the goal, the milestones (tick or untick them
 * yourself), its latest log lines, and status actions: pause or resume,
 * mark done, drop, remove. Your changes are logged as yours, and the bot
 * sees them in its open-projects list on its next turn. Refreshes on the
 * `projects` live signal.
 */
import { useState } from "react";
import type { ProfileInfo, ProjectInfo, ProjectOwnerPatch } from "@spriessen/contracts";
import { CharacterEmpty } from "@/components/character-empty";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatWhen } from "@/lib/format";
import { notifyError } from "@/lib/notify";
import { useLiveLoad } from "@/lib/use-live-load";

const STATUS_LABEL: Record<ProjectInfo["status"], string> = {
  active: "Active",
  paused: "Paused",
  done: "Done",
  dropped: "Dropped",
};

function ProjectActions({
  project,
  change,
}: {
  project: ProjectInfo;
  change: (patch: ProjectOwnerPatch | "remove") => void;
}) {
  const open = project.status === "active" || project.status === "paused";
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {project.status === "active" && (
        <Button size="sm" variant="ghost" onClick={() => change({ status: "paused" })}>
          Pause
        </Button>
      )}
      {project.status !== "active" && (
        <Button size="sm" variant="ghost" onClick={() => change({ status: "active" })}>
          {open ? "Resume" : "Reopen"}
        </Button>
      )}
      {open && (
        <Button size="sm" variant="ghost" onClick={() => change({ status: "done" })}>
          Mark done
        </Button>
      )}
      {open && (
        <Button size="sm" variant="ghost" onClick={() => change({ status: "dropped" })}>
          Drop
        </Button>
      )}
      {!open && (
        <Button size="sm" variant="ghost" onClick={() => change("remove")}>
          Remove
        </Button>
      )}
    </div>
  );
}

function ProjectCard({ project }: { project: ProjectInfo }) {
  const [busy, setBusy] = useState(false);
  const done = project.milestones.filter((step) => step.done).length;
  const total = project.milestones.length;
  const change = (patch: ProjectOwnerPatch | "remove"): void => {
    setBusy(true);
    const request =
      patch === "remove" ? api.projectRemove(project.id) : api.projectUpdate(project.id, patch);
    request
      .catch((cause: unknown) => notifyError("Couldn't change the project", cause))
      .finally(() => setBusy(false));
  };
  return (
    <li aria-busy={busy} className="bg-card flex flex-col gap-2 rounded-2xl border px-3.5 py-3">
      <header className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium break-words">{project.title}</span>
        <Badge variant={project.status === "active" ? "secondary" : "outline"}>
          {STATUS_LABEL[project.status]}
        </Badge>
      </header>
      {project.goal !== "" && <p className="text-muted-foreground text-sm">{project.goal}</p>}
      {total > 0 && (
        <>
          <div className="bg-muted h-1 overflow-hidden rounded-full" aria-hidden>
            <div
              className="bg-ok h-full rounded-full"
              style={{ width: `${(done / total) * 100}%` }}
            />
          </div>
          <ul aria-label={`Milestones, ${done} of ${total} done`} className="flex flex-col gap-1">
            {project.milestones.map((step, index) => (
              <li key={`${index}-${step.text}`}>
                <label className="flex cursor-pointer items-start gap-2 text-sm">
                  <Checkbox
                    className="mt-0.5"
                    checked={step.done}
                    disabled={busy}
                    onCheckedChange={(checked) =>
                      change(checked === true ? { done: [index + 1] } : { undone: [index + 1] })
                    }
                  />
                  <span className={step.done ? "text-muted-foreground line-through" : undefined}>
                    {step.text}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {project.log.length > 0 && (
        <ul
          aria-label="Latest progress"
          className="text-muted-foreground flex flex-col gap-0.5 text-xs"
        >
          {project.log.slice(-3).map((line) => (
            <li key={`${line.at}-${line.text}`} className="break-words">
              {formatWhen(line.at)} · {line.by === "owner" ? "You" : "Bot"}: {line.text}
            </li>
          ))}
        </ul>
      )}
      <ProjectActions project={project} change={change} />
    </li>
  );
}

export function ProjectsTab({ bot }: { bot: ProfileInfo }) {
  const state = useLiveLoad<ProjectInfo[]>(
    `projects:${bot.id}`,
    () => api.projects(bot.id),
    ["projects"],
    "Projects may be out of date",
  );
  if (state.failed)
    return <ErrorState message="Couldn't load the projects." onRetry={state.retry} />;
  if (state.value === null) return <SkeletonRows label="Loading projects" />;
  if (state.value.length === 0)
    return (
      <CharacterEmpty bot={bot} title="No projects yet">
        Ask {bot.name} to take on something that takes days, like "plan the move by March". It keeps
        the goal and milestones here and works through them across chats.
      </CharacterEmpty>
    );
  return (
    <ul aria-label="Projects" className="flex flex-col gap-3">
      {state.value.map((project) => (
        <ProjectCard key={project.id} project={project} />
      ))}
    </ul>
  );
}
