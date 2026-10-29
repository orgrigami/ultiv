/**
 * How the platform names a model: `provider/model` (split at the FIRST
 * slash — aggregator ids like `openrouter/anthropic/claude-x` keep theirs),
 * and what it shows of one: label, provider, and the efforts IT offers.
 */
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { CompactionSettings } from "@earendil-works/pi-durable";

/** Efforts the platform offers (pi's `minimal` has no contract slot; `off` is no reasoning). */
export type SessionEffort = "off" | "low" | "medium" | "high" | "xhigh" | "max";
const SESSION_EFFORTS: readonly string[] = ["off", "low", "medium", "high", "xhigh", "max"];

/** Refs stored before provider-qualified ids carried bare kenari model ids (2026-10-29). */
export const LEGACY_PROVIDER = "kenari";

export interface ModelRef {
  readonly provider: string;
  readonly modelId: string;
}

export const parseRef = (ref: string): ModelRef => {
  const slash = ref.indexOf("/");
  return slash <= 0
    ? { provider: LEGACY_PROVIDER, modelId: ref }
    : { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
};

export const formatRef = (ref: ModelRef): string => `${ref.provider}/${ref.modelId}`;

/** A stored ref in today's form (legacy bare ids gain their provider). */
export const normalizeRef = (ref: string): string => formatRef(parseRef(ref));

/** One selectable model of the mind, with the efforts IT offers. */
export interface ModelSpec {
  /** `provider/model` — what profiles, sessions and the API carry. */
  readonly ref: string;
  readonly provider: string;
  readonly providerName: string;
  readonly label: string;
  readonly contextWindow: number;
  readonly efforts: readonly SessionEffort[];
  /** The lowest effort it offers: off where it can, else its lightest reasoning. */
  readonly defaultEffort: SessionEffort;
}

export const specOf = (model: Model<Api>, providerName: string): ModelSpec => {
  const efforts = getSupportedThinkingLevels(model).filter((level) =>
    SESSION_EFFORTS.includes(level),
  ) as SessionEffort[];
  return {
    ref: formatRef({ provider: model.provider, modelId: model.id }),
    provider: model.provider,
    providerName,
    label: model.name,
    contextWindow: model.contextWindow,
    efforts,
    defaultEffort: efforts[0] ?? "off",
  };
};

/** Provider name, then label: the order every picker shows. */
export const bySpecOrder = (a: ModelSpec, b: ModelSpec): number =>
  a.providerName.localeCompare(b.providerName) || a.label.localeCompare(b.label);

/** An effort the model does not offer (e.g. carried over from another model) snaps to its default. */
export const snapEffort = <E extends string | null | undefined>(
  spec: ModelSpec | undefined,
  effort: E,
): E | SessionEffort =>
  effort !== undefined &&
  effort !== null &&
  spec !== undefined &&
  !(spec.efforts as readonly string[]).includes(effort)
    ? spec.defaultEffort
    : effort;

/**
 * Compaction at 75%: generation blocks to compact once a conversation
 * reaches 75% of its model's context window (`reserveTokens` is the other
 * 25%, kept free for the answer). Background compaction runs 32k tokens
 * early; a summary keeps the most recent eighth verbatim.
 */
export const compactionFor = (models: readonly Model<Api>[]): CompactionSettings => ({
  enabled: true,
  modelOverrides: Object.fromEntries(
    models.map((model) => [
      formatRef({ provider: model.provider, modelId: model.id }),
      {
        reserveTokens: Math.floor(model.contextWindow * 0.25),
        keepRecentTokens: Math.min(131_072, Math.floor(model.contextWindow * 0.125)),
        backgroundTokens: 32_000,
      },
    ]),
  ),
});
