/**
 * Contradictions without a model: a changed functional relation is a
 * definite conflict; similar claims about the same entity are a likely
 * one; a claim that only adds detail, an exact duplicate, different topics
 * about the same subject and facts about different subjects are none.
 */
import { describe, expect, it } from "vite-plus/test";
import type { MemoryEntity, MemoryFact } from "@spriessen/contracts";
import { newFact } from "./model.ts";
import { detectConflicts } from "./conflicts.ts";

let n = 0;
const fact = (text: string, extra: Partial<MemoryFact> = {}): MemoryFact => ({
  ...newFact({
    id: `f${(n += 1)}`,
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
    validFrom: n * 1000,
    supersedes: [],
    at: n * 1000,
  }),
  ...extra,
});
const entity = (id: string, name: string): MemoryEntity => ({
  id,
  name,
  type: "person",
  aliases: [],
  summary: "",
  createdAt: 0,
  mergedInto: null,
});
const harry = entity("e-harry", "Harry");

describe("contradiction detector", () => {
  it("flags a functional relation with another value, older first", () => {
    const jakarta = fact("Harry lives in Jakarta", {
      triple: { s: "Harry", p: "lives_in", o: "Jakarta" },
    });
    const bandung = fact("harry now resides in Bandung", {
      triple: { s: "harry", p: "resides in", o: "Bandung" },
    });
    const [found] = detectConflicts([bandung, jakarta], [harry]);
    expect(found?.older.id).toBe(jakarta.id);
    expect(found?.newer.id).toBe(bandung.id);
    expect(found?.score).toBe(1);
  });

  it("flags similar claims about one entity, not detail or another topic", () => {
    const tea = fact("Harry prefers green tea in the morning", { entities: ["e-harry"] });
    const coffee = fact("Harry prefers black coffee in the morning", { entities: ["e-harry"] });
    const detail = fact("Harry prefers green tea in the morning with honey", {
      entities: ["e-harry"],
    });
    const topic = fact("Harry plays chess on Sundays", { entities: ["e-harry"] });
    const found = detectConflicts([tea, coffee, detail, topic], [harry]);
    const pairs = found.map((c) => [c.older.id, c.newer.id].join("-"));
    expect(pairs).toContain(`${tea.id}-${coffee.id}`);
    expect(pairs).not.toContain(`${tea.id}-${detail.id}`);
    expect(found.some((c) => c.newer.id === topic.id || c.older.id === topic.id)).toBe(false);
  });

  it("leaves different subjects, duplicates and retired facts alone", () => {
    const sari = entity("e-sari", "Sari");
    const a = fact("Harry prefers green tea in the morning", { entities: ["e-harry"] });
    const b = fact("Sari prefers black coffee in the morning", { entities: ["e-sari"] });
    const dup = fact("Harry prefers green tea in the morning", { entities: ["e-harry"] });
    const old = fact("Harry prefers black coffee in the morning", {
      entities: ["e-harry"],
      status: "superseded",
      retired: "changed",
    });
    expect(detectConflicts([a, b, dup, old], [harry, sari])).toEqual([]);
  });
});
