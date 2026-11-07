/**
 * The Now page's folds, pure: what is running across every bot, what
 * finished lately (failures already sit in Needs you, so only clean ends),
 * and which goals are in motion. The page reads the tasks the app already
 * holds; projects and files load on the page itself.
 */
import type { ProfileInfo, ProjectInfo, TaskInfo } from "@spriessen/contracts";

/** How far back "Recently finished" looks. */
export const FINISHED_WINDOW_MS = 24 * 60 * 60_000;
/** Rows per section, so the page stays a glance. */
export const NOW_LIMIT = 8;

export function runningWork<T extends TaskInfo>(tasks: readonly T[]): T[] {
  return tasks
    .filter((task) => task.status === "running")
    .toSorted((a, b) => b.createdAt - a.createdAt);
}

export function finishedRecently<T extends TaskInfo>(tasks: readonly T[], now: number): T[] {
  return tasks
    .filter(
      (task) =>
        (task.status === "done" || task.status === "cancelled") &&
        task.finishedAt !== null &&
        now - task.finishedAt <= FINISHED_WINDOW_MS,
    )
    .toSorted((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, NOW_LIMIT);
}

/** The bot a task runs as, by name ("" when the row predates the binding). */
export function botNameOf(
  task: Pick<TaskInfo, "bot">,
  profiles: readonly Pick<ProfileInfo, "id" | "name">[],
): string {
  const id = task.bot?.profileId;
  return id === undefined ? "" : (profiles.find((profile) => profile.id === id)?.name ?? "");
}

/** Active goals first, then paused; newest change first within each. */
export function goalsInMotion(projects: readonly ProjectInfo[]): ProjectInfo[] {
  const rank = (project: ProjectInfo): number => (project.status === "active" ? 0 : 1);
  return projects
    .filter((project) => project.status === "active" || project.status === "paused")
    .toSorted((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
    .slice(0, NOW_LIMIT);
}

/** "2 of 5 milestones" (or "No milestones yet"). */
export function milestoneText(project: Pick<ProjectInfo, "milestones">): string {
  const total = project.milestones.length;
  if (total === 0) return "No milestones yet";
  const done = project.milestones.filter((milestone) => milestone.done).length;
  return `${done} of ${total} milestones`;
}
