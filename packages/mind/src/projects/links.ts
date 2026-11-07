/**
 * Links from work to a project: a task or routine carries `projectId`, set
 * by the bot through task_spawn's or schedule_set's `project` (#handle). A
 * link only reaches the bot's OWN open projects. The project's work is
 * folded back from the task and routine rows, never stored on the project,
 * so removing a task or a routine needs no cleanup.
 */
import type { CronJobInfo, ProjectInfo, ProjectWork, TaskInfo } from "@spriessen/contracts";
import { PROJECT_WORK_TASKS } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { isOpen, resolveProject } from "./rules.ts";
import { projectsService } from "./service.ts";

export type ProjectScope = { readonly owner: string; readonly profileId: string };

/** A bot's open project by #handle, or why not (a sentence the model can act on). */
export type ProjectRef = (
  scope: ProjectScope,
  ref: string,
) => Promise<{ readonly id: string; readonly title: string } | string>;

/** Pure: the handle → project lookup a link uses (open projects only). */
export const linkTarget = (
  projects: readonly ProjectInfo[],
  ref: string,
): { readonly id: string; readonly title: string } | string => {
  const found = resolveProject(projects.filter(isOpen), ref);
  if (typeof found === "string")
    return `${found} among your open projects (see the project tool's list)`;
  return { id: found.id, title: found.title };
};

/** The resolver over the projects doc (read only: linking never writes the project). */
export const projectRefOf = (converse: ConverseService): ProjectRef => {
  const projects = projectsService(converse);
  return async (scope, ref) => linkTarget(await projects.list(scope.owner, scope.profileId), ref);
};

const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The tasks and routines linked to one project, newest tasks first. */
export const projectWork = (
  projectId: string,
  tasks: readonly TaskInfo[],
  jobs: readonly CronJobInfo[],
): ProjectWork => ({
  tasks: tasks
    .filter((task) => task.projectId === projectId)
    .toSorted((a, b) => b.createdAt - a.createdAt)
    .slice(0, PROJECT_WORK_TASKS)
    .map((task) => ({
      id: task.id,
      title: task.title ?? clip(task.prompt, 40),
      status: task.status,
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
    })),
  routines: jobs
    .filter((job) => job.projectId === projectId)
    .map((job) => ({
      id: job.id,
      schedule: job.schedule,
      once: job.once ?? null,
      prompt: clip(job.prompt, 120),
      enabled: job.enabled,
      trial: job.trial === true,
    })),
});

/** The work lines under a project's `show`, as the model reads them. */
export const workText = (work: ProjectWork): string[] => {
  const lines: string[] = [];
  for (const task of work.tasks)
    lines.push(`task ${task.id.slice(0, 8)} [${task.status}] ${task.title}`);
  for (const job of work.routines) {
    const when =
      job.once !== null ? `once ${new Date(job.once).toISOString()}` : `cron "${job.schedule}"`;
    const state = !job.enabled ? " (off)" : job.trial ? " (trial)" : "";
    lines.push(`routine ${job.id.slice(0, 8)} ${when}${state}: ${job.prompt}`);
  }
  return lines.length === 0 ? ["no linked tasks or routines yet"] : ["Linked work:", ...lines];
};
