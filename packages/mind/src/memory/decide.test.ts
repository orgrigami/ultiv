import { describe, expect, it } from "vite-plus/test";
import type { MemoryFact } from "@spreissen/contracts";
import { decideWrite } from "./decide.ts";
import { newFact } from "./model.ts";

const current = (overrides: Partial<MemoryFact> & Pick<MemoryFact, "id" | "text">): MemoryFact => ({
  ...newFact({
    id: overrides.id,
    scope: "profile",
    profile: "bot",
    text: overrides.text,
    kind: "note",
    tags: overrides.tags ?? [],
    entities: overrides.entities ?? [],
    triple: overrides.triple ?? null,
    importance: 3,
    confidence: 0.7,
    trust: "self",
    source: { via: "tool", writer: "bot", origin: "owner", conversation: null, episode: null },
    validFrom: 1_700_000_000_000,
    supersedes: [],
    at: 1_700_000_000_000,
  }),
});

const base = {
  tags: [],
  entityIds: [],
  triple: null,
  replaces: null,
} as const;

describe("decideWrite (rules first)", () => {
  const store = [
    current({ id: "a", text: "harry works at acme corp in jakarta" }),
    current({
      id: "b",
      text: "harry lives in bandung",
      triple: { s: "harry", p: "lives_in", o: "bandung" },
    }),
  ];

  it("rule 1: exact text (same hash) is a noop", async () => {
    const d = await decideWrite(
      {},
      { ...base, text: "Harry works at Acme Corp in Jakarta!", current: store },
    );
    expect(d.op).toBe("noop");
    expect(d.targetId).toBe("a");
  });

  it("rule 2: a near-identical restatement is a noop", async () => {
    const d = await decideWrite(
      {},
      {
        ...base,
        text: "harry works at acme corp in jakarta",
        current: store,
      },
    );
    expect(d.op).toBe("noop");
  });

  it("rule 3: a functional predicate with a new object supersedes", async () => {
    const d = await decideWrite(
      {},
      {
        ...base,
        text: "harry moved to surabaya last month",
        triple: { s: "harry", p: "lives_in", o: "surabaya" },
        current: store,
      },
    );
    expect(d.op).toBe("supersede");
    expect(d.targetId).toBe("b");
  });

  it("rule 4: an explicit replaces refines when similar, supersedes otherwise", async () => {
    const refine = await decideWrite(
      {},
      {
        ...base,
        text: "harry works at acme corp in jakarta since 2019",
        replaces: "a",
        current: store,
      },
    );
    expect(refine.op).toBe("refine");
    const supersede = await decideWrite(
      {},
      {
        ...base,
        text: "harry's sister studies in denpasar",
        replaces: "a",
        current: store,
      },
    );
    expect(supersede.op).toBe("supersede");
  });

  it("rule 5: nothing similar adds", async () => {
    const d = await decideWrite(
      {},
      {
        ...base,
        text: "the office printer is broken again",
        current: store,
      },
    );
    expect(d.op).toBe("add");
  });
});
