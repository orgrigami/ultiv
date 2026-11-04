/**
 * Where a catalog provider serves embeddings. Every provider the mind can
 * drive that has an embedding API speaks the OpenAI shape for it
 * (`POST {base}/embeddings`, `{ model, input }` → `data[].embedding`):
 * OpenAI-compatible gateways (kenari, OpenRouter, Together, DeepInfra, a
 * local server listed in SPRIESSEN_PROVIDERS…), OpenAI itself, Mistral
 * (`/v1/embeddings`), and Google through its OpenAI-compatible endpoint
 * (`/v1beta/openai/embeddings`). Anthropic has no embedding API.
 *
 * The base URL and the key come from the same catalog entry and env vars
 * the provider's chat models use: nothing new to configure but the model.
 */
import type { CatalogProvider } from "./catalog.ts";
import { expandUrl, keyVarsOf, packageOf, type EnvLookup } from "./wire.ts";

export interface EmbeddingEndpoint {
  readonly provider: string;
  /** The base the embeddings path is appended to (`{base}/embeddings`). */
  readonly baseUrl: string;
  /** The provider's key; undefined for a keyless local server. */
  readonly apiKey: string | undefined;
}

/** The endpoint, or a sentence saying why this provider cannot embed (yet). */
export const embeddingEndpointOf = (
  provider: CatalogProvider,
  env: EnvLookup,
  allow: ReadonlySet<string> | null,
): EmbeddingEndpoint | { readonly problem: string } => {
  const wire = packageOf(provider.npm);
  if (wire === undefined) {
    return { problem: `${provider.name} speaks a wire format the app does not drive` };
  }
  if (wire.api === "anthropic-messages") {
    return { problem: `${provider.name} has no embedding API; pick another provider` };
  }
  const raw = provider.api ?? wire.baseUrl;
  const expanded = raw !== undefined ? expandUrl(raw, env) : undefined;
  if (expanded === undefined) {
    return { problem: `${provider.name}'s address is not configured (${provider.env.join(", ")})` };
  }
  const keys = keyVarsOf(provider);
  const apiKey = keys.map((name) => env(name) ?? "").find((value) => value !== "");
  const keyless = keys.length === 0 && allow !== null && allow.has(provider.id);
  if (apiKey === undefined && !keyless) {
    return { problem: `${provider.name} has no key set (${keys.join(" or ")})` };
  }
  const baseUrl =
    wire.api === "google-generative-ai"
      ? `${expanded.replace(/\/openai$/, "")}/openai`
      : wire.api === "mistral-conversations"
        ? `${expanded.replace(/\/v1$/, "")}/v1`
        : expanded;
  return { provider: provider.id, baseUrl, apiKey };
};
