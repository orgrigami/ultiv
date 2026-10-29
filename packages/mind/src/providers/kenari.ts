/**
 * Kenari live model discovery. models.dev tracks kenari too, but its listing
 * lags the gateway: models appear on kenari.id days before models.dev carries
 * them and retired ones linger after the gateway dropped them. The gateway's
 * own `/v1/models` answers unauthenticated with everything it serves, so the
 * catalog revalidates the kenari provider against it: a live listing REPLACES
 * the kenari model set wholesale (it is the source of truth), keeping only the
 * USD cost of models.dev entries — kenari prices in IDR and the mind accounts
 * spend in USD per 1M. The overlay still applies after, so the owner's local
 * additions always win.
 */
import { parseModel, type Catalog, type CatalogModel } from "./catalog.ts";

export const KENARI_ID = "kenari";

/** One live listing, already parsed: model id → catalog model. */
export type KenariListing = Readonly<Record<string, CatalogModel>>;

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const num = (value: unknown): number => (typeof value === "number" && value >= 0 ? value : 0);

/** Non-chat endpoints → a models.dev-style `type` label (chat needs none). */
const TYPE_OF: Readonly<Record<string, string>> = {
  images: "image",
  audio_speech: "audio",
  audio_transcription: "audio",
  music: "audio",
  videos: "video",
  embed: "embedding",
};

/**
 * One kenari `/v1/models` entry as a models.dev-shaped model, so `parseModel`
 * stays the single parser. Kenari's differences: kind comes from `endpoints`
 * (no `type` field), `reasoning_options` is a flat string list, `sunset_at`
 * marks retirement, and pricing is IDR — costs are left to models.dev.
 */
export const kenariModelOf = (raw: unknown): CatalogModel | undefined => {
  if (!isRecord(raw)) return undefined;
  const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : undefined;
  if (id === undefined) return undefined;
  const endpoints = strings(raw.endpoints);
  const chat = endpoints.includes("chat") || endpoints.length === 0;
  const efforts = strings(raw.reasoning_options).length
    ? strings(raw.reasoning_options)
    : strings(raw.supported_reasoning_levels);
  const toggle = raw.reasoning_toggle === true;
  const reasoning = raw.reasoning === true || efforts.length > 0 || toggle;
  const modalities = isRecord(raw.modalities) ? raw.modalities : {};
  const maxOutput = num(raw.max_output_tokens);
  return parseModel(id, {
    id,
    name: typeof raw.name === "string" && raw.name !== "" ? raw.name : undefined,
    ...(chat ? {} : { type: TYPE_OF[endpoints[0] ?? ""] ?? "other" }),
    ...(raw.sunset_at !== undefined && raw.sunset_at !== null ? { status: "deprecated" } : {}),
    reasoning,
    ...(efforts.length > 0
      ? { reasoning_options: [{ type: "effort", values: [...efforts] }] }
      : toggle
        ? { reasoning_options: [{ type: "toggle" }] }
        : {}),
    tool_call: raw.tool_call === true,
    modalities,
    limit: { context: num(raw.context_length), ...(maxOutput > 0 ? { output: maxOutput } : {}) },
  });
};

/** A whole listing body (`{ data: [...] }`); unparseable entries are dropped. */
export const parseKenariListing = (body: unknown): KenariListing => {
  const models: Record<string, CatalogModel> = {};
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  for (const entry of data) {
    const model = kenariModelOf(entry);
    if (model !== undefined) models[model.id] = model;
  }
  return models;
};

/**
 * Lay a live listing over the catalog's kenari provider. No listing, an empty
 * one (never wipe the catalog on a bad answer), or a catalog without kenari
 * leaves everything untouched.
 */
export const applyKenari = (base: Catalog, listing: KenariListing | undefined): Catalog => {
  const current = base[KENARI_ID];
  if (listing === undefined || current === undefined) return base;
  const ids = Object.keys(listing);
  if (ids.length === 0) return base;
  const models: Record<string, CatalogModel> = {};
  for (const [id, model] of Object.entries(listing)) {
    const cost = current.models[id]?.cost;
    models[id] = cost !== undefined ? { ...model, cost } : model;
  }
  return { ...base, [KENARI_ID]: { ...current, models } };
};
