/**
 * The meaning leg, with a deterministic stand-in for the embedding model:
 * a question that shares no word with the fact still finds it, vectors are
 * filled lazily and dropped with the text they belong to, a model that
 * fails leaves search on words, and nothing is configured by default.
 */
import { describe, expect, it } from "vite-plus/test";
import type { MemoryFact } from "@spriessen/contracts";
import { newFact } from "../memory/model.ts";
import { openSearchDb } from "./db.ts";
import { factSearch } from "./facts.ts";
import { messageSearch } from "./messages.ts";
import { cosine, embedderFromEnv, type Embedder } from "./vectors.ts";

/** Three "topics": gardening, money, everything else. */
const TOPICS: readonly (readonly string[])[] = [
  ["garden", "plants", "seedlings", "tomatoes", "kebun", "flowers"],
  ["budget", "invoice", "money", "expenses", "bill"],
];
let calls = 0;
const fake: Embedder = {
  model: "fake:topics",
  embed: async (texts) => {
    calls += 1;
    return texts.map((text) => {
      const lower = text.toLowerCase();
      const vector = TOPICS.map((words) => (words.some((word) => lower.includes(word)) ? 1 : 0));
      return Float32Array.from([...vector, vector.every((v) => v === 0) ? 1 : 0]);
    });
  },
};
const broken: Embedder = {
  model: "broken",
  embed: async () => {
    throw new Error("no server");
  },
};

let n = 0;
const fact = (text: string): MemoryFact =>
  newFact({
    id: `v${(n += 1)}`,
    scope: "profile",
    profile: "p",
    text,
    kind: "fact",
    tags: [],
    entities: [],
    triple: null,
    importance: 3,
    confidence: 0.8,
    trust: "self",
    source: { via: "tool", writer: "p", origin: "owner", conversation: null, episode: null },
    validFrom: null,
    supersedes: [],
    at: 1,
  });

describe("the meaning leg", () => {
  it("finds a fact that shares no word with the question", async () => {
    const search = factSearch(openSearchDb(":memory:"), fake);
    const seeds = fact("Harry started tomato seedlings on the balcony");
    search.sync("s", [seeds, fact("Harry pays the internet bill monthly")], () => []);
    expect(search.lexical(["s"], "how is my kebun doing", 5)).toEqual([]);
    expect(await search.semantic?.(["s"], "how is my kebun doing", 5)).toEqual([seeds.id]);
  });

  it("embeds lazily once, and drops a vector when its text changes", async () => {
    const search = factSearch(openSearchDb(":memory:"), fake);
    const plan = fact("Plant flowers in the front garden");
    search.sync("s", [plan], () => []);
    calls = 0;
    await search.semantic?.(["s"], "garden", 5);
    await search.semantic?.(["s"], "garden", 5);
    // One fill + two queries: the stored vector is reused.
    expect(calls).toBe(3);
    search.sync("s", [{ ...plan, text: "Pay the electricity bill", hash: "x" }], () => []);
    expect(await search.semantic?.(["s"], "money owed", 5)).toEqual([plan.id]);
  });

  it("leaves message search on words when the model fails", async () => {
    const messages = messageSearch(openSearchDb(":memory:"), broken);
    const entry = (id: number, text: string) =>
      ({
        id,
        conversationId: 1,
        kind: "pi.user",
        model: [{ role: "user", content: text, timestamp: 9 }],
      }) as never;
    await messages.sync(
      { owner: "o", profile: "p" },
      [{ conversation: "c1", session: "s1" }],
      async (_c, after) => (after === 0 ? [entry(1, "the garden plan is ready")] : []),
    );
    const hits = await messages.search({
      owner: "o",
      profile: "p",
      query: "garden plan",
      limit: 5,
    });
    expect(hits).toHaveLength(1);
  });

  it("finds a message by meaning, for its own bot only", async () => {
    const messages = messageSearch(openSearchDb(":memory:"), fake);
    const entry = (id: number, text: string) =>
      ({
        id,
        conversationId: 1,
        kind: "pi.user",
        model: [{ role: "user", content: text, timestamp: 9 }],
      }) as never;
    await messages.sync(
      { owner: "o", profile: "p" },
      [{ conversation: "c1", session: "s1" }],
      async (_c, after) =>
        after === 0 ? [entry(1, "the seedlings need more sun"), entry(2, "send the invoice")] : [],
    );
    await messages.sync(
      { owner: "o", profile: "other" },
      [{ conversation: "c2", session: "s2" }],
      async (_c, after) => (after === 0 ? [entry(1, "my tomatoes are ripe")] : []),
    );
    const hits = await messages.search({ owner: "o", profile: "p", query: "kebun", limit: 5 });
    expect(hits.map((hit) => hit.snippet)).toEqual(["the seedlings need more sun"]);
  });

  it("is off unless configured, and compares vectors by angle", () => {
    const before = process.env.MEMORY_EMBEDDINGS;
    delete process.env.MEMORY_EMBEDDINGS;
    expect(embedderFromEnv()).toBeUndefined();
    process.env.MEMORY_EMBEDDINGS = "ollama";
    expect(embedderFromEnv()?.model).toBe("ollama:embeddinggemma");
    if (before === undefined) delete process.env.MEMORY_EMBEDDINGS;
    else process.env.MEMORY_EMBEDDINGS = before;
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([2, 0]))).toBeCloseTo(1);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBe(0);
  });
});
