/**
 * Evals wiring for the entity: the replay guard's hook joins the registry
 * BEFORE cut turns resume (a resumed replay stays blocked), the service is
 * built over the mind's parts, and runs a restart cut are marked failed.
 */
import type { Registry } from "@earendil-works/pi-durable";
import type { ConverseService } from "../converse/converse.ts";
import type { DecideService } from "../decide/decide.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import type { ModelCatalogService } from "../providers/models.ts";
import { catalogKnows } from "../tasks/background.ts";
import { evalsService, type EvalsService } from "./evals.ts";
import { replayGuard, replayGuardExtension } from "./guard.ts";

export const wireEvals = async (
  registry: Registry,
  parts: {
    readonly converse: ConverseService;
    readonly profiles: ProfilesService;
    readonly decide: DecideService;
    readonly models: Pick<ModelCatalogService, "list" | "find">;
  },
): Promise<EvalsService> => {
  const guard = replayGuard(parts.converse);
  registry.install(replayGuardExtension(guard));
  const evals = evalsService({
    converse: parts.converse,
    profiles: parts.profiles,
    guard,
    decide: parts.decide,
    knownModel: catalogKnows(parts.models),
  });
  await evals.recover().catch((cause: unknown) => console.error("eval recover failed:", cause));
  return evals;
};
