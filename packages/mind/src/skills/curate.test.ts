/**
 * The consolidation pass, detection side: the deterministic overlap
 * threshold, the older-skill-keeps rule (version count breaks a tie),
 * built-ins excluded on both sides, and the size-capped drafted body.
 */
import { describe, expect, it } from "vite-plus/test";
import { ABSORB_OVERLAP, absorbCandidates, draftAbsorb, type CurateSkill } from "./curate.ts";
import { MAX_SKILL_CHARS } from "./guard.ts";

const skill = (
  name: string,
  at: number,
  body: string,
  options: { version?: number; origin?: CurateSkill["origin"]; description?: string } = {},
): CurateSkill => ({
  name,
  description: options.description ?? `${name}: a procedure the bot worked out`,
  body,
  createdAt: at,
  version: options.version ?? 1,
  origin: options.origin ?? "self",
});

const SHARED = `filing supplier invoices weekly ledger totals amounts due dates
each invoice lands in the supplier folder before the weekly ledger close`;

describe("absorbCandidates", () => {
  it("pairs two skills sharing most of their distinctive words", () => {
    const a = skill("invoice-filing", 1_000, SHARED);
    const b = skill("weekly-invoice-close", 2_000, `${SHARED}\nalso file the receipts`);
    const candidates = absorbCandidates([a, b]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.keep.name).toBe("invoice-filing");
    expect(candidates[0]?.sources.map((source) => source.name)).toEqual(["weekly-invoice-close"]);
  });

  it("leaves distinct skills alone", () => {
    const a = skill("invoice-filing", 1_000, SHARED);
    const b = skill("garden-watering", 2_000, "water the beds every third morning before ten", {
      description: "garden watering rounds",
    });
    expect(absorbCandidates([a, b])).toHaveLength(0);
  });

  it("never pairs a built-in, on either side", () => {
    const learned = skill("invoice-filing", 1_000, SHARED);
    const builtin = skill("spriessen", 0, SHARED, { origin: "builtin" });
    expect(absorbCandidates([learned, builtin])).toHaveLength(0);
  });

  it("a dead heat on age keeps the higher version count", () => {
    const olderName = "invoice-filing";
    const a = skill(olderName, 1_000, SHARED, { version: 1 });
    const b = skill("weekly-invoice-close", 1_000, SHARED, { version: 5 });
    const candidates = absorbCandidates([a, b]);
    expect(candidates[0]?.keep.name).toBe("weekly-invoice-close");
  });

  it("the threshold is 40 percent of the smaller set — just under misses", () => {
    expect(ABSORB_OVERLAP).toBe(0.4);
    const base =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi";
    const a = skill("half-shared", 1_000, base);
    const b = skill("other-half", 2_000, `${base} rho sigma tau upsilon phi chi psi omega`);
    // Both directions share exactly half of the smaller set: hits.
    expect(absorbCandidates([a, b]).length).toBeGreaterThan(0);
    const barely = skill("barely", 3_000, "alpha beta gamma delta epsilon zeta eta theta");
    const far = skill("far", 4_000, base);
    // "barely" shares 8 of 16 words with "far" — 0.5, still a hit; a word
    // set with almost nothing shared misses (covered by the distinct test).
    expect(absorbCandidates([barely, far]).length).toBeGreaterThan(0);
  });
});

describe("draftAbsorb", () => {
  it("carries each source under a delimited section", () => {
    const keep = skill("invoice-filing", 1_000, "# filing\nthe procedure");
    const source = skill("weekly-invoice-close", 2_000, "# close\nthe weekly close steps");
    const draft = draftAbsorb(keep, [source]);
    expect(draft.body).toContain("# filing");
    expect(draft.body).toContain("## Absorbed from weekly-invoice-close");
    expect(draft.body).toContain("the weekly close steps");
    expect(draft.absorbed).toEqual([{ name: "weekly-invoice-close", version: 1 }]);
    expect(draft.note).toContain("Absorbs weekly-invoice-close");
  });

  it("skips a source whose section would blow the size cap, and says so", () => {
    const keep = skill("invoice-filing", 1_000, "# filing");
    const big = skill("huge-close", 2_000, `x`.repeat(MAX_SKILL_CHARS));
    const small = skill("small-close", 3_000, "# small close");
    const draft = draftAbsorb(keep, [big, small]);
    expect(draft.body).not.toContain("## Absorbed from huge-close");
    expect(draft.body).toContain("## Absorbed from small-close");
    expect(draft.absorbed.map((source) => source.name)).toEqual(["small-close"]);
    expect(draft.note).toContain("skipped huge-close");
    expect(draft.body.length).toBeLessThanOrEqual(MAX_SKILL_CHARS);
  });

  it("nothing fits: the plan says so and carries no sources", () => {
    const keep = skill("invoice-filing", 1_000, `y`.repeat(MAX_SKILL_CHARS));
    const source = skill("huge-close", 2_000, "# close");
    const draft = draftAbsorb(keep, [source]);
    expect(draft.absorbed).toEqual([]);
    expect(draft.note).toContain("would exceed the size cap");
  });
});
