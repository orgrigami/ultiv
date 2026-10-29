/**
 * Every environment key the mind knows, in one place. Keys are optional: the
 * faculties they enable report themselves through `mind.describe()`, so the
 * stack boots offline and degrades loudly instead of crashing. Provider API
 * keys are the exception: their names come from the models.dev catalog
 * (`ANTHROPIC_API_KEY`, `KENARI_API_KEY`, …), see `providers/wire.ts`.
 */
import { Config } from "effect";

/** Single grep-able fallbacks (ULTIV_MODEL is the source of truth for the default model). */
export const DEFAULT_MODEL_FALLBACK = "kenari/deepseek-v4-1-flash";
export const JEV_FALLBACK_MODEL = "jev-latest";
export const MODELS_DEV_DEFAULT_URL = "https://models.dev/api.json";
export const HARNESS_DB_DEFAULT = "var/harness.sqlite";

/** The default model as `provider/model`. */
export const defaultModel = Config.option(Config.String("ULTIV_MODEL"));
/** Comma list of provider ids to use; unset = every provider whose key is set. */
export const modelProviders = Config.option(Config.String("ULTIV_PROVIDERS"));
/** Where the catalog comes from; `off` never touches the network (offline runs, smoke). */
export const modelsDevUrl = Config.String("MODELS_DEV_URL").pipe(
  Config.withDefault(MODELS_DEV_DEFAULT_URL),
);
export const modelsDevCache = Config.String("MODELS_DEV_CACHE").pipe(
  Config.withDefault("var/models-dev.json"),
);
export const modelsDevTtlHours = Config.Number("MODELS_DEV_TTL_HOURS").pipe(Config.withDefault(24));
/** The owner's additions in models.dev format: extra models, extra providers, endpoint overrides. */
export const modelsOverlay = Config.String("MODELS_OVERLAY").pipe(
  Config.withDefault("var/models.local.json"),
);
export const modelMaxConcurrency = Config.Number("MODEL_MAX_CONCURRENCY").pipe(
  Config.withDefault(4),
);
export const typesafeApiKey = Config.option(Config.String("TYPESAFE_API_KEY"));
export const typesafeModel = Config.String("TYPESAFE_MODEL").pipe(
  Config.withDefault(JEV_FALLBACK_MODEL),
);
export const harnessDb = Config.String("HARNESS_DB").pipe(Config.withDefault(HARNESS_DB_DEFAULT));
