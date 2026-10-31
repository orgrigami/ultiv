/**
 * From catalog entry to pi-ai provider. models.dev names the AI-SDK package
 * that speaks each provider's wire format; the mind maps that package onto
 * the pi-ai API implementing the same protocol, and fills in the base URL
 * for first-party packages that models.dev leaves implicit. Providers whose
 * package has no pi-ai counterpart here (Bedrock, Vertex, Azure, Cohere, …)
 * are skipped, not guessed at.
 *
 * Wire quirks (thinking format, `max_tokens` naming, cache control) are
 * pi-ai's: it detects them from the provider id and base URL, so a provider
 * keeps its models.dev id on purpose.
 */
import {
  createProvider,
  envApiKeyAuth,
  type Api,
  type ApiKeyAuth,
  type Model,
  type Provider,
  type ProviderStreams,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { CatalogModel, CatalogProvider } from "./catalog.ts";

type WireApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "mistral-conversations";

const STREAMS: Record<WireApi, () => ProviderStreams> = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
  "mistral-conversations": mistralConversationsApi,
};

/** AI-SDK package → pi-ai API, with the default endpoint when models.dev gives none. */
const PACKAGES: Readonly<Record<string, { readonly api: WireApi; readonly baseUrl?: string }>> = {
  "@ai-sdk/openai-compatible": { api: "openai-completions" },
  "@openrouter/ai-sdk-provider": {
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  "@ai-sdk/openai": { api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  "@ai-sdk/anthropic": { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
  "@ai-sdk/google": {
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
  "@ai-sdk/mistral": { api: "mistral-conversations", baseUrl: "https://api.mistral.ai" },
  "@ai-sdk/groq": { api: "openai-completions", baseUrl: "https://api.groq.com/openai/v1" },
  "@ai-sdk/xai": { api: "openai-responses", baseUrl: "https://api.x.ai/v1" },
  "@ai-sdk/cerebras": { api: "openai-completions", baseUrl: "https://api.cerebras.ai/v1" },
  "@ai-sdk/togetherai": { api: "openai-completions", baseUrl: "https://api.together.ai/v1" },
  "@ai-sdk/deepinfra": {
    api: "openai-completions",
    baseUrl: "https://api.deepinfra.com/v1/openai",
  },
  "@ai-sdk/perplexity": { api: "openai-completions", baseUrl: "https://api.perplexity.ai" },
};

export type EnvLookup = (name: string) => string | undefined;

/** Replace `${VAR}` placeholders; undefined when any is unset. */
export const expandUrl = (url: string, env: EnvLookup): string | undefined => {
  let missing = false;
  const expanded = url.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const value = env(name);
    if (value === undefined || value === "") missing = true;
    return value ?? "";
  });
  return missing ? undefined : expanded.replace(/\/+$/, "");
};

/** The Anthropic and Mistral SDKs append `/v1` themselves; AI-SDK URLs include it. */
const baseUrlFor = (api: WireApi, url: string): string =>
  api === "anthropic-messages" || api === "mistral-conversations" ? url.replace(/\/v1$/, "") : url;

/** An OpenAI-shaped route may pin chat completions or responses per model. */
const shapedApi = (api: WireApi, shape: string | undefined): WireApi => {
  if (api !== "openai-completions" && api !== "openai-responses") return api;
  if (shape === "completions") return "openai-completions";
  if (shape === "responses") return "openai-responses";
  return api;
};

/** Text-in, text-out, tool-calling and not retired: what an agent turn needs. */
export const conversational = (model: CatalogModel): boolean =>
  (model.type === undefined || model.type === "chat") &&
  model.status !== "deprecated" &&
  model.toolCall &&
  model.input.includes("text") &&
  model.output.includes("text");

const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * pi thinking levels from models.dev's reasoning controls. An effort list
 * maps level for level (`none` is how a provider says off); a bare toggle is
 * off/high; a reasoning model with no listed control always reasons at the
 * provider's default, so it offers no level at all. Budget-only models keep
 * pi-ai's own budget ladder (no map).
 */
export const thinkingLevelMapOf = (model: CatalogModel): ThinkingLevelMap | undefined => {
  if (!model.reasoning) return undefined;
  const effort = model.reasoningOptions.find((option) => option.type === "effort");
  const toggle = model.reasoningOptions.some((option) => option.type === "toggle");
  if (effort !== undefined && effort.type === "effort") {
    const map: ThinkingLevelMap = {};
    if (effort.values.includes("none")) map.off = "none";
    else if (!toggle) map.off = null;
    for (const level of EFFORT_LEVELS) map[level] = effort.values.includes(level) ? level : null;
    return map;
  }
  if (toggle) return { minimal: null, low: null, medium: null, high: "high" };
  if (model.reasoningOptions.length === 0) {
    return { off: null, minimal: null, low: null, medium: null, high: null };
  }
  return undefined;
};

/** One catalog model as a pi-ai chat model, or undefined when the mind cannot drive it. */
export const modelOf = (
  provider: CatalogProvider,
  model: CatalogModel,
  env: EnvLookup,
): Model<Api> | undefined => {
  if (!conversational(model)) return undefined;
  const wire = PACKAGES[model.route?.npm ?? provider.npm];
  if (wire === undefined) return undefined;
  const api = shapedApi(wire.api, model.route?.shape);
  const raw = model.route?.api ?? provider.api ?? wire.baseUrl;
  const expanded = raw !== undefined ? expandUrl(raw, env) : undefined;
  if (expanded === undefined) return undefined;
  const thinkingLevelMap = thinkingLevelMapOf(model);
  return {
    id: model.id,
    name: model.name,
    api,
    provider: provider.id,
    baseUrl: baseUrlFor(api, expanded),
    reasoning: model.reasoning,
    ...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
    input: model.input.includes("image") ? ["text", "image"] : ["text"],
    cost: model.cost,
    contextWindow: model.context,
    maxTokens: model.maxOutput,
  };
};

/** The env vars that carry a key (models.dev lists URL parts like regions too). */
export const keyVarsOf = (provider: CatalogProvider): readonly string[] => {
  const keys = provider.env.filter((name) => /KEY|TOKEN|SECRET/.test(name));
  return keys.length > 0 ? keys : provider.env;
};

/** A keyless local server (allowlisted explicitly) still needs auth semantics. */
const keylessAuth = (name: string): ApiKeyAuth => ({
  name: `${name} (no key)`,
  resolve: async () => ({ auth: { apiKey: "none" }, source: "keyless" }),
});

export interface WireOptions {
  readonly env: EnvLookup;
  /** Provider ids to consider (SPREISSEN_PROVIDERS); null = every provider with a key set. */
  readonly allow: ReadonlySet<string> | null;
}

/** Whether the owner configured this provider: a key is set, or it is allowlisted keyless. */
export const enabled = (provider: CatalogProvider, options: WireOptions): boolean => {
  if (options.allow !== null && !options.allow.has(provider.id)) return false;
  const keys = keyVarsOf(provider);
  if (keys.some((name) => (options.env(name) ?? "") !== "")) return true;
  return keys.length === 0 && options.allow !== null;
};

/** The pi-ai provider for one configured catalog provider, or undefined when none of its models fit. */
export const providerOf = (
  provider: CatalogProvider,
  options: WireOptions,
): Provider | undefined => {
  if (!enabled(provider, options)) return undefined;
  const models = Object.values(provider.models).flatMap((model) => {
    const wired = modelOf(provider, model, options.env);
    return wired !== undefined ? [wired] : [];
  });
  const first = models[0];
  if (first === undefined) return undefined;
  const apis = [...new Set(models.map((model) => model.api as WireApi))];
  const keys = keyVarsOf(provider);
  return createProvider<Api>({
    id: provider.id,
    name: provider.name,
    baseUrl: first.baseUrl,
    auth: {
      apiKey:
        keys.length > 0
          ? envApiKeyAuth(`${provider.name} API key`, [...keys])
          : keylessAuth(provider.name),
    },
    models,
    api: Object.fromEntries(apis.map((api) => [api, STREAMS[api]()])),
  });
};
