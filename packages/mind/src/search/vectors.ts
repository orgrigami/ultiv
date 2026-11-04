/**
 * The optional meaning leg: embeddings from a LOCAL model (Ollama), stored
 * as float32 blobs beside the FTS rows and searched by an exact cosine scan
 * (no vector extension; a bot's memory and chats are small enough). Off by
 * default — words, synonyms and trigrams already cover most recall. With
 * `MEMORY_EMBEDDINGS=ollama`, `OLLAMA_URL` (default http://127.0.0.1:11434)
 * and `EMBEDDING_MODEL` (default `embeddinggemma`, multilingual) facts and
 * messages are embedded lazily, a batch per search, and a vague question
 * ("that idea we had about the garden") finds what it means. Nothing ever
 * leaves the machine unless OLLAMA_URL points elsewhere. Any failure (no
 * server, no model, a timeout) drops the leg for that search: search
 * degrades to words, it never breaks.
 */

export interface Embedder {
  /** Stored with each vector: a new model re-embeds instead of mixing spaces. */
  readonly model: string;
  readonly embed: (texts: readonly string[]) => Promise<Float32Array[]>;
}

const DEFAULT_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "embeddinggemma";
const TIMEOUT_MS = 10_000;
/** Characters of one text sent to the model (its context is short anyway). */
const TEXT_CAP = 2_000;
/** A neighbour below this cosine is not a match, whatever its rank. */
export const MIN_SIMILARITY = 0.3;
/** Rows embedded per search call; the rest wait for the next one. */
export const FILL_PER_CALL = 64;
const BATCH = 32;

/** An Ollama `/api/embed` client. */
export const ollamaEmbedder = (url: string, model: string): Embedder => ({
  model: `ollama:${model}`,
  embed: async (texts) => {
    if (texts.length === 0) return [];
    const response = await fetch(`${url.replace(/\/$/, "")}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: texts.map((text) => text.slice(0, TEXT_CAP)) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`embedding model answered ${response.status}`);
    const body = (await response.json()) as { embeddings?: unknown };
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) {
      throw new Error("embedding model returned no vectors");
    }
    return body.embeddings.map((vector) => Float32Array.from(vector as number[]));
  },
});

/** The configured embedder, or undefined (the default: no meaning leg). */
export const embedderFromEnv = (): Embedder | undefined => {
  const mode = process.env.MEMORY_EMBEDDINGS?.trim().toLowerCase();
  if (mode !== "ollama" && mode !== "on") return undefined;
  const url = process.env.OLLAMA_URL?.trim() || DEFAULT_URL;
  const model = process.env.EMBEDDING_MODEL?.trim() || DEFAULT_MODEL;
  return ollamaEmbedder(url, model);
};

export const toBlob = (vector: Float32Array): Uint8Array =>
  new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);

export const fromBlob = (blob: Uint8Array): Float32Array =>
  new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));

export const cosine = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};

/** Embed rows that have no vector yet, in batches, and store each. */
export const fillMissing = async (
  embedder: Embedder,
  rows: readonly { readonly rowid: number; readonly text: string }[],
  put: (rowid: number, vector: Float32Array) => void,
): Promise<void> => {
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const vectors = await embedder.embed(batch.map((row) => row.text));
    batch.forEach((row, index) => {
      const vector = vectors[index];
      if (vector !== undefined) put(row.rowid, vector);
    });
  }
};

/** The nearest rows to a query vector, best first, above MIN_SIMILARITY. */
export const nearest = (
  query: Float32Array,
  rows: readonly { readonly rowid: number; readonly vec: Uint8Array }[],
  limit: number,
): { readonly rowid: number; readonly score: number }[] =>
  rows
    .map((row) => ({ rowid: row.rowid, score: cosine(query, fromBlob(row.vec)) }))
    .filter((row) => row.score >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
