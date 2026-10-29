/**
 * The mind's model catalog: every provider models.dev knows whose key is
 * set, with the models it lists. The catalog boots from its disk cache and
 * revalidates against models.dev in the background (daily by default);
 * only a first boot with no cache waits on the network. The kenari provider
 * additionally revalidates against the gateway's own listing (see
 * `kenari.ts`), which runs ahead of models.dev. Providers re-register
 * after each refresh, so new models appear without a restart. The whole
 * catalog is served behind the concurrency gate: one process-wide bound on
 * simultaneous model requests.
 */
import { Effect, Context, Layer, Option } from "effect";
import { ConfigError } from "effect/Config";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Models, MutableModels } from "@earendil-works/pi-ai";
import type { CompactionSettings } from "@earendil-works/pi-durable";
import {
  DEFAULT_MODEL_FALLBACK,
  KENARI_MODELS_DEFAULT_URL,
  MODELS_DEV_DEFAULT_URL,
  defaultModel,
  kenariModelsCache,
  kenariModelsTtlHours,
  kenariModelsUrl,
  modelMaxConcurrency,
  modelProviders,
  modelsDevCache,
  modelsDevTtlHours,
  modelsDevUrl,
  modelsOverlay,
} from "../config.ts";
import { mergeOverlay, parseCatalog, type Catalog } from "./catalog.ts";
import {
  fetchCatalog,
  readCache,
  readJsonFile,
  writeCache,
  type CachedCatalog,
  type Fetcher,
} from "./catalog-cache.ts";
import { applyKenari, parseKenariListing } from "./kenari.ts";
import { gateModels } from "./gate.ts";
import { bySpecOrder, compactionFor, normalizeRef, specOf, type ModelSpec } from "./refs.ts";
import { providerOf, type EnvLookup, type WireOptions } from "./wire.ts";

export interface CatalogStatus {
  /** Where the installed catalog came from this run. */
  readonly source: "network" | "cache" | "none";
  readonly fetchedAt: number | null;
  readonly providers: readonly string[];
  readonly models: number;
  /** The last refresh or overlay failure, cleared by the next success. */
  readonly error: string | null;
  /** The kenari live listing (models.dev lags the gateway). */
  readonly kenari: {
    readonly source: "network" | "cache" | "none";
    readonly fetchedAt: number | null;
    readonly models: number;
  };
}

export interface ModelCatalogService {
  /** The pi-ai collection every faculty calls through (gated). */
  readonly models: Models;
  /** Selectable models of the configured providers, in picker order. */
  readonly list: () => readonly ModelSpec[];
  /** One model by ref (legacy bare ids resolve too). */
  readonly find: (ref: string) => ModelSpec | undefined;
  /** The model new conversations start on: ULTIV_MODEL, else a sane available one. */
  readonly defaultRef: () => string;
  /** Revalidate against models.dev now (`force`) or when the cache is stale. */
  readonly refresh: (force?: boolean) => Promise<CatalogStatus>;
  readonly status: () => CatalogStatus;
  /** Per-model compaction thresholds for the live catalog. */
  readonly compaction: () => CompactionSettings;
}

export class ModelCatalog extends Context.Service<ModelCatalog, ModelCatalogService>()(
  "ultiv/mind/ModelCatalog",
) {}

export class MindModels extends Context.Service<MindModels, Models>()("ultiv/mind/Models") {}

export interface CatalogOptions {
  /** models.dev URL; null = never fetch. */
  readonly url: string | null;
  readonly cachePath: string;
  readonly overlayPath: string;
  readonly ttlMs: number;
  /** Kenari's own listing; null = never fetch (MODELS_DEV_URL=off covers it). */
  readonly kenariUrl: string | null;
  readonly kenariCachePath: string;
  readonly kenariTtlMs: number;
  readonly env: EnvLookup;
  readonly allow: ReadonlySet<string> | null;
  /** ULTIV_MODEL, when set. */
  readonly preferred: string | null;
  readonly concurrency: number;
  readonly fetcher?: Fetcher;
  readonly now?: () => number;
  /** Background revalidation cadence; 0 disables the timer (tests). */
  readonly checkEveryMs?: number;
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

interface Installed {
  readonly specs: readonly ModelSpec[];
  readonly byRef: ReadonlyMap<string, ModelSpec>;
  readonly compaction: CompactionSettings;
}

/** Register every configured provider; synchronous, so no request sees half a catalog. */
const installInto = (raw: MutableModels, catalog: Catalog, wire: WireOptions): Installed => {
  raw.clearProviders();
  const names = new Map<string, string>();
  for (const provider of Object.values(catalog)) {
    const wired = providerOf(provider, wire);
    if (wired === undefined) continue;
    raw.setProvider(wired);
    names.set(wired.id, wired.name);
  }
  const all = raw.getModels();
  const specs = all
    .map((model) => specOf(model, names.get(model.provider) ?? model.provider))
    .sort(bySpecOrder);
  return {
    specs,
    byRef: new Map(specs.map((spec) => [spec.ref, spec])),
    compaction: compactionFor(all),
  };
};

/** ULTIV_MODEL; else the fallback when listed (or nothing is); else the first listed model. */
const defaultRefOf = (installed: Installed, preferred: string | null): string => {
  if (preferred !== null) return normalizeRef(preferred);
  const { specs, byRef } = installed;
  if (specs.length === 0 || byRef.has(DEFAULT_MODEL_FALLBACK)) return DEFAULT_MODEL_FALLBACK;
  return specs[0]?.ref ?? DEFAULT_MODEL_FALLBACK;
};

/** A live catalog. Never rejects: failures land in `status().error`. */
export const createCatalog = async (
  options: CatalogOptions,
): Promise<ModelCatalogService & { readonly close: () => void }> => {
  const now = options.now ?? Date.now;
  const raw = createModels();
  const models = gateModels(raw, options.concurrency);
  let entry: CachedCatalog | undefined = await readCache(options.cachePath);
  let source: CatalogStatus["source"] = entry !== undefined ? "cache" : "none";
  let error: string | null = null;
  let kenariEntry: CachedCatalog | undefined = await readCache(options.kenariCachePath);
  let kenariSource: CatalogStatus["kenari"]["source"] =
    kenariEntry !== undefined ? "cache" : "none";
  let kenariError: string | null = null;
  let kenariListed = 0;
  let installed: Installed = { specs: [], byRef: new Map(), compaction: compactionFor([]) };

  const install = async (): Promise<void> => {
    let overlay: unknown;
    try {
      overlay = await readJsonFile(options.overlayPath);
    } catch (cause) {
      error = `overlay ${options.overlayPath}: ${messageOf(cause)}`;
    }
    const listing = kenariEntry !== undefined ? parseKenariListing(kenariEntry.body) : undefined;
    kenariListed = listing !== undefined ? Object.keys(listing).length : 0;
    const catalog = mergeOverlay(applyKenari(parseCatalog(entry?.body), listing), overlay);
    installed = installInto(raw, catalog, { env: options.env, allow: options.allow });
  };

  const status = (): CatalogStatus => ({
    source,
    fetchedAt: entry?.fetchedAt ?? null,
    providers: [...new Set(installed.specs.map((spec) => spec.provider))],
    models: installed.specs.length,
    error: error ?? kenariError,
    kenari: {
      source: kenariSource,
      fetchedAt: kenariEntry?.fetchedAt ?? null,
      models: kenariListed,
    },
  });

  let inflight: Promise<CatalogStatus> | null = null;
  const refresh = (force = false): Promise<CatalogStatus> => {
    const devStale =
      options.url !== null &&
      (force || entry === undefined || now() - entry.fetchedAt >= options.ttlMs);
    const kenariStale =
      options.kenariUrl !== null &&
      (force || kenariEntry === undefined || now() - kenariEntry.fetchedAt >= options.kenariTtlMs);
    if (!devStale && !kenariStale) return Promise.resolve(status());
    const fetcher = options.fetcher ?? fetch;
    inflight ??= (async () => {
      if (devStale) {
        try {
          entry = await fetchCatalog(options.url as string, entry, {
            fetcher,
            timeoutMs: 20_000,
            now: now(),
          });
          source = "network";
          error = null;
          await writeCache(options.cachePath, entry);
        } catch (cause) {
          error = `models.dev refresh: ${messageOf(cause)}`;
        }
      }
      if (kenariStale) {
        try {
          kenariEntry = await fetchCatalog(options.kenariUrl as string, kenariEntry, {
            fetcher,
            timeoutMs: 20_000,
            now: now(),
            label: "kenari",
          });
          kenariSource = "network";
          kenariError = null;
          await writeCache(options.kenariCachePath, kenariEntry);
        } catch (cause) {
          kenariError = `kenari models refresh: ${messageOf(cause)}`;
        }
      }
      await install();
      return status();
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  await install();
  // First boot has nothing to serve until the catalog lands; later boots
  // serve the cache and revalidate behind it.
  if (entry === undefined) await refresh();
  else void refresh();
  const every = options.checkEveryMs ?? 3_600_000;
  const timer = every > 0 ? setInterval(() => void refresh(), every) : undefined;
  timer?.unref();

  return {
    models,
    list: () => installed.specs,
    find: (ref) => installed.byRef.get(normalizeRef(ref)),
    defaultRef: () => defaultRefOf(installed, options.preferred),
    refresh,
    status,
    compaction: () => installed.compaction,
    close: () => clearInterval(timer),
  };
};

/** ULTIV_PROVIDERS as a set; unset or blank means every configured provider. */
const allowlistOf = (raw: Option.Option<string>): ReadonlySet<string> | null => {
  if (Option.isNone(raw)) return null;
  const ids = raw.value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  return ids.length > 0 ? new Set(ids) : null;
};

/** KENARI_MODELS_URL: unset/blank = the gateway's own listing, `off` = never. */
const kenariUrlOf = (devUrl: string | null, raw: Option.Option<string>): string | null => {
  // MODELS_DEV_URL=off means the catalog stays offline entirely.
  if (devUrl === null) return null;
  if (Option.isNone(raw)) return KENARI_MODELS_DEFAULT_URL;
  const value = raw.value.trim();
  return value === "" ? KENARI_MODELS_DEFAULT_URL : value === "off" ? null : value;
};

const catalogOptions: Effect.Effect<CatalogOptions, ConfigError> = Effect.gen(function* () {
  const url = yield* modelsDevUrl;
  const preferred = yield* defaultModel;
  const resolved = url.trim() === "off" ? null : url.trim() || MODELS_DEV_DEFAULT_URL;
  return {
    url: resolved,
    cachePath: yield* modelsDevCache,
    overlayPath: yield* modelsOverlay,
    ttlMs: (yield* modelsDevTtlHours) * 3_600_000,
    kenariUrl: kenariUrlOf(resolved, yield* kenariModelsUrl),
    kenariCachePath: yield* kenariModelsCache,
    kenariTtlMs: (yield* kenariModelsTtlHours) * 3_600_000,
    env: (name) => process.env[name],
    allow: allowlistOf(yield* modelProviders),
    preferred:
      Option.isSome(preferred) && preferred.value.trim() !== "" ? preferred.value.trim() : null,
    concurrency: yield* modelMaxConcurrency,
  };
});

export const catalogLayer: Layer.Layer<ModelCatalog, ConfigError> = Layer.effect(
  ModelCatalog,
  Effect.gen(function* () {
    const options = yield* catalogOptions;
    return yield* Effect.acquireRelease(
      Effect.promise(() => createCatalog(options)),
      (catalog) => Effect.sync(catalog.close),
    );
  }),
);

/** The gated pi-ai collection, alongside the catalog that owns it. */
export const modelsLayer: Layer.Layer<MindModels | ModelCatalog, ConfigError> = Layer.effect(
  MindModels,
  Effect.gen(function* () {
    return (yield* ModelCatalog).models;
  }),
).pipe(Layer.provideMerge(catalogLayer));
