/**
 * The facts index in the search sidecar: bilingual concept matches, typo
 * and code matches through trigrams, incremental sync (only changed facts
 * rewritten, purged ones gone), store scoping, and recall through it.
 */
import { describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { MemoryFact } from "@spriessen/contracts";
import { newFact } from "../memory/model.ts";
import { openMind } from "../entity.ts";
import { openSearchDb } from "./db.ts";
import { factSearch } from "./facts.ts";
import { gramsQuery, termsQuery } from "./fts.ts";

let n = 0;
const fact = (text: string, extra: Partial<MemoryFact> = {}): MemoryFact => ({
  ...newFact({
    id: `fact-${(n += 1)}`,
    scope: "profile",
    profile: "p1",
    text,
    kind: "fact",
    tags: [],
    entities: [],
    triple: null,
    importance: 3,
    confidence: 0.8,
    trust: "self",
    source: { via: "tool", writer: "p1", origin: "owner", conversation: null, episode: null },
    validFrom: null,
    supersedes: [],
    at: Date.now(),
  }),
  ...extra,
});

const index = () => factSearch(openSearchDb(":memory:"));
const none = () => [];

describe("fts queries", () => {
  it("quote every token, so user text is never FTS5 syntax", () => {
    expect(termsQuery('cat" OR 1=1 --')).not.toContain('" OR 1=1');
    expect(termsQuery("the and of")).toBeNull();
    expect(gramsQuery("ab")).toBeNull();
    expect(gramsQuery("Mochi")).toContain('"moc"');
  });
});

describe("fact search", () => {
  it("finds across languages through synonym concepts", () => {
    const search = index();
    const cat = fact("Harry punya kucing bernama Mochi");
    search.sync("s1", [cat, fact("Harry drinks green tea")], none);
    expect(search.lexical(["s1"], "does harry have a cat", 5)[0]).toBe(cat.id);
    expect(search.lexical(["s1"], "kitten cat", 5)).toEqual([cat.id]);
  });

  it("finds a typo and a code through trigrams", () => {
    const search = index();
    const city = fact("Harry lives in Yogyakarta");
    const order = fact("The invoice number is PO-2024-117 from Tokopedia");
    search.sync("s1", [city, order], none);
    expect(search.lexical(["s1"], "jogjakarta", 5)).toEqual([]);
    expect(search.fuzzy(["s1"], "yogjakarta", 5)[0]).toBe(city.id);
    expect(search.fuzzy(["s1"], "2024-117", 5)[0]).toBe(order.id);
  });

  it("stays scoped to the stores asked for", () => {
    const search = index();
    search.sync("mine", [fact("Harry likes durian")], none);
    search.sync("sibling", [fact("Sari likes durian")], none);
    expect(search.lexical(["mine"], "durian", 5)).toHaveLength(1);
    expect(search.lexical(["mine", "sibling"], "durian", 5)).toHaveLength(2);
  });

  it("rewrites only what changed, and forgets what left the store", () => {
    const search = index();
    const tea = fact("Harry drinks green tea");
    const coffee = fact("Harry drinks coffee");
    search.sync("s1", [tea, coffee], none);
    search.sync("s1", [{ ...tea, text: "Harry drinks oolong tea", hash: "changed" }], none);
    expect(search.lexical(["s1"], "oolong", 5)).toEqual([tea.id]);
    expect(search.lexical(["s1"], "green", 5)).toEqual([]);
    expect(search.lexical(["s1"], "coffee", 5)).toEqual([]);
    search.drop("s1");
    expect(search.lexical(["s1"], "oolong", 5)).toEqual([]);
  });

  it("indexes entity names and tags", () => {
    const search = index();
    const vet = fact("Appointment on Friday", { entities: ["e-mochi"], tags: ["vet"] });
    search.sync("s1", [vet], (id) => (id === "e-mochi" ? ["Mochi", "si oren"] : []));
    expect(search.lexical(["s1"], "mochi", 5)).toEqual([vet.id]);
    expect(search.lexical(["s1"], "vet", 5)).toEqual([vet.id]);
  });
});

describe("recall through the sidecar", () => {
  it("recalls a fact typed with a slip", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const bot = await handle.mind.profiles.create("harry", { name: "Ink", onboard: false });
    await handle.mind.memory.writeV2({
      owner: "harry",
      profileId: bot.id,
      scope: "profile",
      writer: bot.id,
      text: "Harry's dentist is Dr. Wiradinata in Kemang",
    });
    const recalled = await handle.mind.memory.recallV2("harry", bot.id, { query: "wiradinatta" });
    expect(recalled.facts.map((found) => found.text)).toEqual([
      "Harry's dentist is Dr. Wiradinata in Kemang",
    ]);
    await handle.close();
  });
});
