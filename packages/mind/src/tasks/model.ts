/**
 * Which model background work runs on. A task (and a routine that runs as a
 * task) resolves, in order: the model the spawn asked for, the bot's
 * `policies.backgroundModel`, the workspace's `SPRIESSEN_BACKGROUND_MODEL`
 * (+ `SPRIESSEN_BACKGROUND_EFFORT`), else nothing, which keeps the bot's own
 * chat model. Every ref must be in the live catalog: an unknown one is a
 * refusal for a spawn argument and is skipped (with a log line) for the
 * stored defaults, so a model dropped from the catalog never breaks a task.
 */
import type { ProfileInfo, ProfileModel } from "@spriessen/contracts";
import { readEnv } from "@spriessen/core";

export type TaskModel = { readonly id: string; readonly effort: string };

export type ModelChoice =
  | { readonly ok: true; readonly model: TaskModel | undefined }
  | { readonly ok: false; readonly reason: string };

const blank = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value.trim();

/** The workspace background default from the environment, if set. */
export const envBackgroundModel = (env: NodeJS.ProcessEnv = process.env): TaskModel | undefined => {
  const id = blank(readEnv("BACKGROUND_MODEL", env));
  return id === undefined
    ? undefined
    : { id, effort: blank(readEnv("BACKGROUND_EFFORT", env)) ?? "" };
};

const known = (
  model: ProfileModel | TaskModel | null | undefined,
  knownModel: (ref: string) => boolean,
  where: string,
): TaskModel | undefined => {
  if (model === null || model === undefined) return undefined;
  if (knownModel(model.id)) return { id: model.id, effort: model.effort };
  console.warn(`${where}: model ${model.id} is not in the catalog; using the next default`);
  return undefined;
};

/** The model a background task of this bot runs on. */
export const backgroundModelFor = (
  profile: ProfileInfo | undefined,
  requested: { readonly model?: string; readonly effort?: string },
  knownModel: (ref: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
): ModelChoice => {
  const asked = blank(requested.model);
  if (asked !== undefined) {
    if (!knownModel(asked)) {
      return {
        ok: false,
        reason: `unknown model "${asked}": use a provider/model id from the catalog, or omit it`,
      };
    }
    return { ok: true, model: { id: asked, effort: blank(requested.effort) ?? "" } };
  }
  const stored = known(profile?.policies.backgroundModel, knownModel, "background model");
  const fallback =
    stored ?? known(envBackgroundModel(env), knownModel, "SPRIESSEN_BACKGROUND_MODEL");
  if (fallback === undefined) return { ok: true, model: undefined };
  const effort = blank(requested.effort) ?? fallback.effort;
  return { ok: true, model: { id: fallback.id, effort } };
};
