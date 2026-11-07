/**
 * The `project` tool and the `open_projects` prompt section. A bot starts a
 * project for a goal that takes days, then moves it along: ticks milestones,
 * logs progress, changes its status. Its open projects (at most a line each)
 * ride every request, so the goal survives compaction, restarts and new
 * chats. It touches only the bot's own projects, so it needs no approval;
 * a check-in on a date goes through `schedule_set`, which does.
 */
import type { PromptSection, ToolRegistration } from "@earendil-works/pi-durable";
import { PROJECT_TOOL, ProjectParamsSchema, type ProjectParams } from "@spriessen/contracts";
import { defineTool } from "@spriessen/ext";
import { withAudit, type AuditService } from "../audit/audit.ts";
import { textReply } from "../act/task-live.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import type { ProjectWork } from "@spriessen/contracts";
import { workText } from "./links.ts";
import { isOpen, projectLine, projectText, resolveProject } from "./rules.ts";
import type { ProjectsService } from "./service.ts";

/** The tasks and routines linked to a project (links.ts `projectWork`). */
export type WorkOf = (projectId: string) => Promise<ProjectWork>;

export const PROJECT_DESCRIPTION =
  "Track a goal you work on over days. `start` it with a title, the goal and its milestones; " +
  "then `update` it as you go (tick milestones by number, `add` new ones, a one-line `note` " +
  "for the log, a `status`: active, paused, done, dropped). Your open projects are listed in " +
  "your context every turn. Link the work you do for one: task_spawn and schedule_set take " +
  "its #handle as `project`, and `show` lists the linked tasks and routines.";

type Scope = { owner: string; profileId: string };

const act = async (
  projects: ProjectsService,
  scope: Scope,
  args: ProjectParams,
  workOf: WorkOf | undefined,
) => {
  const mine = await projects.list(scope.owner, scope.profileId);
  if (args.action === "list") {
    const shown = mine.filter((p) => p.status !== "dropped").slice(0, 10);
    return textReply(shown.length === 0 ? "no projects yet" : shown.map(projectLine).join("\n"));
  }
  if (args.action === "start") {
    const outcome = await projects.start(scope.owner, scope.profileId, args);
    if (!outcome.ok) return textReply(`not started: ${outcome.error}`, true);
    return {
      ...textReply(`started ${projectText(outcome.project)}`),
      details: { id: outcome.project.id, title: outcome.project.title },
    };
  }
  const found = resolveProject(mine, args.id);
  if (typeof found === "string") return textReply(found, true);
  if (args.action === "show") {
    const work = workOf === undefined ? [] : workText(await workOf(found.id));
    return textReply([projectText(found), ...work].join("\n"));
  }
  const outcome = await projects.change(scope.owner, found.id, args, "bot");
  if (outcome === undefined || !outcome.ok) {
    return textReply(
      `not changed: ${outcome?.ok === false ? outcome.error : "no such project"}`,
      true,
    );
  }
  return {
    ...textReply(projectText(outcome.project)),
    details: { id: outcome.project.id, title: outcome.project.title },
  };
};

const projectTool = (
  projects: ProjectsService,
  profiles: ProfilesService,
  workOf: WorkOf | undefined,
) =>
  defineTool({
    name: PROJECT_TOOL,
    description: PROJECT_DESCRIPTION,
    parameters: ProjectParamsSchema,
    execute: async (args, api) => {
      const scope = profiles.scopeOf(String(api.conversationId));
      if (scope === undefined) return textReply("this conversation belongs to no bot", true);
      return act(projects, scope, args, workOf);
    },
  });

export const projectTools = (
  projects: ProjectsService,
  profiles: ProfilesService,
  audit: AuditService | undefined,
  workOf?: WorkOf,
): ToolRegistration[] => {
  const tool = projectTool(projects, profiles, workOf) as unknown as ToolRegistration;
  const profileOf = (conversationId: string) => profiles.profileOf(conversationId)?.id ?? null;
  return [audit === undefined ? tool : withAudit(audit, tool, profileOf)];
};

/** The bot's open projects, a line each; nothing when it has none. */
export const openProjectsSection = (
  projects: ProjectsService,
  profiles: ProfilesService,
): PromptSection => ({
  key: "open_projects",
  render: async (input) => {
    const scope = profiles.scopeOf(String(input.conversationId));
    if (scope === undefined) return undefined;
    const open = (await projects.list(scope.owner, scope.profileId)).filter(isOpen);
    if (open.length === 0) return undefined;
    return [
      `Your open projects (move them along with the ${PROJECT_TOOL} tool, by #handle):`,
      ...open.map(projectLine),
    ].join("\n");
  },
});
