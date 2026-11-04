/**
 * Where embeddings come from — `MEMORY_EMBEDDINGS`:
 *
 * - `ollama` (or `on`): a local Ollama, `OLLAMA_URL` (default
 *   http://127.0.0.1:11434), `EMBEDDING_MODEL` (default `embeddinggemma`).
 * - `<provider>/<model>`, e.g. `kenari/text-embedding-3-small`,
 *   `openrouter/openai/text-embedding-3-small`, `openai/…`, `mistral/…`,
 *   `google/…`: any model-catalog provider with an embedding API, through
 *   the same endpoint and key its chat models use (providers/
 *   embedding-endpoint.ts). Resolved at each call, so a catalog that loads
 *   late or refreshes is fine.
 * - `openai-compatible`: any OpenAI-shaped `/embeddings` endpoint —
 *   `EMBEDDING_URL` (its base, e.g. http://127.0.0.1:1234/v1 for LM
 *   Studio), `EMBEDDING_MODEL`, optional `EMBEDDING_API_KEY`.
 *
 * An endpoint outside the machine and the owner's own network is REMOTE:
 * it is never sent tool results (`EMBEDDING_INCLUDE_TOOLS=on` overrides).
 */
import type { Embedder } from "./vectors.ts";

const TIMEOUT_MS = 10_000;
/** Characters of one text sent to the model (its context is short anyway). */
const TEXT_CAP = 2_000;
const OLLAMA_URL = "http://127.0.0.1:11434";
const OLLAMA_MODEL = "embeddinggemma";

type Env = (name: string) => string | undefined;
type Endpoint = { readonly baseUrl: string; readonly apiKey: string | undefined };
export type EndpointOf = (providerId: string) => Endpoint | { readonly problem: string };

/**
 * Loopback, private ranges, the tailnet (100.64.0.0/10, *.ts.net) and .local
 * names are the owner's own; anything else is remote.
 */
export const isLocalUrl = (url: string): boolean => {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".ts.net")
  ) {
    return true;
  }
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return false;
  const [a = -1, b = -1] = octets;
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127)
  );
};

const post = async (url: string, body: unknown, apiKey: string | undefined): Promise<unknown> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey !== undefined ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    // The status only: an error body may echo the request, and never the key.
    throw new Error(`the embedding endpoint answered ${response.status}`);
  }
  return response.json();
};

const capped = (texts: readonly string[]): string[] => texts.map((text) => text.slice(0, TEXT_CAP));

const vectorsOf = (raw: unknown, count: number): Float32Array[] => {
  if (!Array.isArray(raw) || raw.length !== count)
    throw new Error("the embedding endpoint returned no vectors");
  return raw.map((vector) => Float32Array.from(vector as number[]));
};

/** An Ollama `/api/embed` client. */
export const ollamaEmbedder = (url: string, model: string): Embedder => ({
  model: `ollama:${model}`,
  remote: () => !isLocalUrl(url),
  embed: async (texts) => {
    if (texts.length === 0) return [];
    const body = (await post(
      `${url.replace(/\/$/, "")}/api/embed`,
      { model, input: capped(texts) },
      undefined,
    )) as {
      embeddings?: unknown;
    };
    return vectorsOf(body.embeddings, texts.length);
  },
});

/** An OpenAI-shaped `{base}/embeddings` client; the endpoint resolves at each call. */
export const openAIEmbedder = (
  label: string,
  model: string,
  endpoint: () => Endpoint | { readonly problem: string },
): Embedder => {
  const resolve = (): Endpoint => {
    const found = endpoint();
    if ("problem" in found) throw new Error(found.problem);
    return found;
  };
  return {
    model: `${label}:${model}`,
    remote: () => {
      const found = endpoint();
      return "problem" in found ? true : !isLocalUrl(found.baseUrl);
    },
    embed: async (texts) => {
      if (texts.length === 0) return [];
      const { baseUrl, apiKey } = resolve();
      const body = (await post(
        `${baseUrl.replace(/\/$/, "")}/embeddings`,
        { model, input: capped(texts), encoding_format: "float" },
        apiKey,
      )) as { data?: { index?: number; embedding?: unknown }[] };
      const data = [...(body.data ?? [])].sort((x, y) => (x.index ?? 0) - (y.index ?? 0));
      return vectorsOf(
        data.map((row) => row.embedding),
        texts.length,
      );
    },
  };
};

/**
 * The configured embedder, or undefined (the default: no meaning leg). A
 * value it cannot read turns the leg off with one warning, never the app.
 */
export const embedderFromEnv = (
  env: Env = (name) => process.env[name],
  endpointOf?: EndpointOf,
): Embedder | undefined => {
  const raw = env("MEMORY_EMBEDDINGS")?.trim() ?? "";
  const mode = raw.toLowerCase();
  if (mode === "" || mode === "off") return undefined;
  if (mode === "ollama" || mode === "on") {
    return ollamaEmbedder(
      env("OLLAMA_URL")?.trim() || OLLAMA_URL,
      env("EMBEDDING_MODEL")?.trim() || OLLAMA_MODEL,
    );
  }
  if (mode === "openai-compatible") {
    const url = env("EMBEDDING_URL")?.trim() ?? "";
    const model = env("EMBEDDING_MODEL")?.trim() ?? "";
    if (url === "" || model === "") {
      console.warn(
        "MEMORY_EMBEDDINGS=openai-compatible needs EMBEDDING_URL and EMBEDDING_MODEL; meaning search is off",
      );
      return undefined;
    }
    const apiKey = env("EMBEDDING_API_KEY")?.trim() || undefined;
    return openAIEmbedder("openai-compatible", model, () => ({ baseUrl: url, apiKey }));
  }
  const slash = raw.indexOf("/");
  if (slash > 0 && slash < raw.length - 1 && endpointOf !== undefined) {
    const provider = raw.slice(0, slash);
    const model = raw.slice(slash + 1);
    return openAIEmbedder(provider, model, () => endpointOf(provider));
  }
  console.warn(
    `MEMORY_EMBEDDINGS=${raw} is not ollama, openai-compatible or <provider>/<model>; meaning search is off`,
  );
  return undefined;
};

/** Whether tool results may be embedded: only by a local model, unless the owner says so. */
export const embedsTools = (embedder: Embedder, env: Env = (name) => process.env[name]): boolean =>
  !embedder.remote() || env("EMBEDDING_INCLUDE_TOOLS")?.trim().toLowerCase() === "on";

/** How the meaning leg is doing, for Settings › Server (no text, no key). */
export interface MeaningStatus {
  /** The embedding model as configured (`ollama:embeddinggemma`); null = off. */
  readonly model: string | null;
  /** Texts leave the owner's machine and network. */
  readonly remote: boolean;
  /** Tool results are embedded too (local models, or EMBEDDING_INCLUDE_TOOLS=on). */
  readonly tools: boolean;
  readonly lastOkAt: number | null;
  readonly lastError: string | null;
  readonly lastErrorAt: number | null;
}

/** Wrap an embedder so its last success and failure can be reported. */
export const trackedEmbedder = (
  embedder: Embedder,
): { readonly embedder: Embedder; readonly status: () => MeaningStatus } => {
  let lastOkAt: number | null = null;
  let lastError: string | null = null;
  let lastErrorAt: number | null = null;
  return {
    embedder: {
      ...embedder,
      embed: async (texts) => {
        try {
          const vectors = await embedder.embed(texts);
          lastOkAt = Date.now();
          return vectors;
        } catch (cause) {
          lastError = (cause instanceof Error ? cause.message : String(cause)).slice(0, 200);
          lastErrorAt = Date.now();
          throw cause;
        }
      },
    },
    status: () => ({
      model: embedder.model,
      remote: embedder.remote(),
      tools: embedsTools(embedder),
      lastOkAt,
      lastError,
      lastErrorAt,
    }),
  };
};

export const MEANING_OFF: MeaningStatus = {
  model: null,
  remote: false,
  tools: false,
  lastOkAt: null,
  lastError: null,
  lastErrorAt: null,
};
