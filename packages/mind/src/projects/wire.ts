/** Projects wiring for the entity: the service, its tool and its prompt section. */
import { defineExtension, type Registry } from "@earendil-works/pi-durable";
import type { AuditService } from "../audit/audit.ts";
import type { ConverseService } from "../converse/converse.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { Effect } from "effect";
import { readCronJobs } from "../schedules/schedules.ts";
import { readTasks } from "../tasks/store.ts";
import { projectWork } from "./links.ts";
import { projectsService, type ProjectsService } from "./service.ts";
import { openProjectsSection, projectTools } from "./tools.ts";

export const wireProjects = (
  registry: Registry,
  parts: {
    readonly converse: ConverseService;
    readonly profiles: ProfilesService;
    readonly audit?: AuditService | undefined;
  },
): ProjectsService => {
  const projects = projectsService(parts.converse);
  const workOf = async (projectId: string) =>
    projectWork(
      projectId,
      await Effect.runPromise(readTasks(parts.converse)),
      await readCronJobs(parts.converse),
    );
  registry.install(
    defineExtension({
      name: "ultius.mind.projects",
      tools: projectTools(projects, parts.profiles, parts.audit, workOf),
      sections: [openProjectsSection(projects, parts.profiles)],
    }),
  );
  return projects;
};
