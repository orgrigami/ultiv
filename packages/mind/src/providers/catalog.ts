/**
 * The models.dev catalog: the shape of `https://models.dev/api.json` (the
 * subset the mind reads), a tolerant parser, and the local overlay merge.
 *
 * models.dev is a community catalog keyed by provider id. Each provider names
 * the env vars holding its key, the AI-SDK package that speaks its wire
 * format (`npm`), and an OpenAI-compatible base URL (`api`) when it has one.
 * Each model carries limits, USD-per-1M costs, modalities and the reasoning
 * controls it accepts. Entries that do not parse are dropped, never thrown:
 * one malformed model must not take the whole catalog down.
 */

/** One reasoning control a model accepts. */
export type ReasoningOption =
  | { readonly type: "effort"; readonly values: readonly string[] }
  | { readonly type: "toggle" }
  | { readonly type: "budget_tokens" };

/** Per-model wire override (aggregators route some models to another API). */
export interface ModelRoute {
  readonly npm?: string;
  readonly api?: string;
  /** `completions` or `responses` for OpenAI-shaped APIs. */
  readonly shape?: string;
}

export interface CatalogModel {
  readonly id: string;
  readonly name: string;
  /** Absent means chat; image/embedding/speech/... models are not conversational. */
  readonly type?: string;
  readonly status?: string;
  readonly reasoning: boolean;
  readonly reasoningOptions: readonly ReasoningOption[];
  readonly toolCall: boolean;
  readonly input: readonly string[];
  readonly output: readonly string[];
  readonly context: number;
  readonly maxOutput: number;
  /** USD per 1M tokens. */
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  readonly route?: ModelRoute;
}

export interface CatalogProvider {
  readonly id: string;
  readonly name: string;
  /** Env vars models.dev lists for the provider: keys first, then URL parts. */
  readonly env: readonly string[];
  readonly npm: string;
  readonly api?: string;
  readonly models: Readonly<Record<string, CatalogModel>>;
}

export type Catalog = Readonly<Record<string, CatalogProvider>>;

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const num = (value: unknown): number => (typeof value === "number" && value >= 0 ? value : 0);
const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const reasoningOptionsOf = (value: unknown): readonly ReasoningOption[] =>
  (Array.isArray(value) ? value : []).flatMap((option): ReasoningOption[] => {
    if (!isRecord(option)) return [];
    if (option.type === "effort") return [{ type: "effort", values: strings(option.values) }];
    if (option.type === "toggle") return [{ type: "toggle" }];
    if (option.type === "budget_tokens") return [{ type: "budget_tokens" }];
    return [];
  });

const routeOf = (value: unknown): ModelRoute | undefined => {
  if (!isRecord(value)) return undefined;
  const npm = str(value.npm);
  const api = str(value.api);
  const shape = str(value.shape);
  if (npm === undefined && api === undefined && shape === undefined) return undefined;
  return {
    ...(npm !== undefined ? { npm } : {}),
    ...(api !== undefined ? { api } : {}),
    ...(shape !== undefined ? { shape } : {}),
  };
};

/** One model entry, or undefined when it lacks an id or a context window. */
export const parseModel = (key: string, raw: unknown): CatalogModel | undefined => {
  if (!isRecord(raw)) return undefined;
  const id = str(raw.id) ?? key;
  const limit = isRecord(raw.limit) ? raw.limit : {};
  const context = num(limit.context);
  if (context === 0) return undefined;
  const cost = isRecord(raw.cost) ? raw.cost : {};
  const modalities = isRecord(raw.modalities) ? raw.modalities : {};
  const type = str(raw.type);
  const status = str(raw.status);
  const route = routeOf(raw.provider);
  return {
    id,
    name: str(raw.name) ?? id,
    ...(type !== undefined ? { type } : {}),
    ...(status !== undefined ? { status } : {}),
    reasoning: raw.reasoning === true,
    reasoningOptions: reasoningOptionsOf(raw.reasoning_options),
    toolCall: raw.tool_call === true,
    input: modalities.input !== undefined ? strings(modalities.input) : ["text"],
    output: modalities.output !== undefined ? strings(modalities.output) : ["text"],
    context,
    maxOutput: num(limit.output) || Math.min(context, 8_192),
    cost: {
      input: num(cost.input),
      output: num(cost.output),
      cacheRead: num(cost.cache_read),
      cacheWrite: num(cost.cache_write),
    },
    ...(route !== undefined ? { route } : {}),
  };
};

const parseProvider = (key: string, raw: unknown): CatalogProvider | undefined => {
  if (!isRecord(raw)) return undefined;
  const npm = str(raw.npm);
  if (npm === undefined) return undefined;
  const id = str(raw.id) ?? key;
  const api = str(raw.api);
  const models: Record<string, CatalogModel> = {};
  for (const [modelKey, entry] of Object.entries(isRecord(raw.models) ? raw.models : {})) {
    const model = parseModel(modelKey, entry);
    if (model !== undefined) models[model.id] = model;
  }
  return {
    id,
    name: str(raw.name) ?? id,
    env: strings(raw.env),
    npm,
    ...(api !== undefined ? { api } : {}),
    models,
  };
};

/** The whole catalog; anything that does not parse is skipped. */
export const parseCatalog = (raw: unknown): Catalog => {
  const catalog: Record<string, CatalogProvider> = {};
  if (!isRecord(raw)) return catalog;
  for (const [key, entry] of Object.entries(raw)) {
    const provider = parseProvider(key, entry);
    if (provider !== undefined) catalog[provider.id] = provider;
  }
  return catalog;
};

/**
 * Lay the owner's overlay (same format as models.dev) over the catalog:
 * provider fields given replace, models merge by id (an overlay model is a
 * whole entry). A provider only in the overlay needs `npm` like any other.
 */
export const mergeOverlay = (base: Catalog, overlay: unknown): Catalog => {
  if (!isRecord(overlay)) return base;
  const merged: Record<string, CatalogProvider> = { ...base };
  for (const [key, raw] of Object.entries(overlay)) {
    if (!isRecord(raw)) continue;
    const current = base[key];
    const npm = str(raw.npm) ?? current?.npm;
    const own = npm !== undefined ? parseProvider(key, { ...raw, npm }) : undefined;
    if (own === undefined) continue;
    const api = str(raw.api) ?? current?.api;
    merged[key] = {
      id: current?.id ?? own.id,
      name: str(raw.name) ?? current?.name ?? own.name,
      env: raw.env !== undefined ? own.env : (current?.env ?? []),
      npm: own.npm,
      ...(api !== undefined ? { api } : {}),
      models: { ...current?.models, ...own.models },
    };
  }
  return merged;
};
