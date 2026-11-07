/**
 * The entity's late faculties, wired after every other registry install and
 * before cut turns resume: projects, evals (and the dry-run guard they share
 * with routine trials), trials, and the model lanes hook that puts the
 * owner's chats ahead of background work at the gate (providers/lanes.ts),
 * and the boot report of background shell jobs a restart cut off.
 */
import type { Registry } from "@earendil-works/pi-durable";
import { recoverBashJobs } from "./act/bash-jobs.ts";
import type { AuditService } from "./audit/audit.ts";
import type { ConverseService } from "./converse/converse.ts";
import type { DecideService } from "./decide/decide.ts";
import type { EvalsService } from "./evals/evals.ts";
import { wireEvals } from "./evals/wire.ts";
import type { ProfilesService } from "./profiles/profiles.ts";
import type { ProjectsService } from "./projects/service.ts";
import { wireProjects } from "./projects/wire.ts";
import { lanesExtension } from "./providers/lanes.ts";
import type { ModelCatalogService } from "./providers/models.ts";
import { trialsService, type TrialsService } from "./routines/trial.ts";
import { catalogKnows } from "./tasks/background.ts";

export const wireLateFaculties = async (
  registry: Registry,
  parts: {
    readonly converse: ConverseService;
    readonly profiles: ProfilesService;
    readonly decide: DecideService;
    readonly models: ModelCatalogService;
    readonly audit: AuditService;
  },
): Promise<{
  readonly projects: ProjectsService;
  readonly evals: EvalsService;
  readonly trials: TrialsService;
}> => {
  const { converse, profiles, decide, models, audit } = parts;
  const projects = wireProjects(registry, { converse, profiles, audit });
  const { evals, guard } = await wireEvals(registry, { converse, profiles, decide, models });
  const trials = trialsService({ converse, profiles, guard, knownModel: catalogKnows(models) });
  // Tasks and test replays are background work: they always leave the owner a slot.
  registry.install(
    lanesExtension(models.lanes, async (conversationId) =>
      profiles.scopeOf(conversationId)?.kind === "task" || (await evals.isReplay(conversationId))
        ? "background"
        : "owner",
    ),
  );
  // Background shell jobs a restart cut off: each conversation hears it was lost.
  await recoverBashJobs(converse).catch((cause: unknown) =>
    console.error("bash job recovery failed:", cause),
  );
  return { projects, evals, trials };
};
