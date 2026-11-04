/**
 * The batch engine: all-or-nothing skill edits. A failing op anywhere
 * (validation, gate, or an injected write failure) leaves the store
 * byte-identical — index, versions and files; a good batch applies every
 * op with its own batch-reasoned version; remove is a store-level op;
 * built-ins, duplicates, state mismatches and oversized batches refuse.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { AuditEvent } from "@spriessen/contracts";
import { aboutSkills } from "@spriessen/about";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { applyOps, MAX_SKILL_OPS, SkillBatchRefused } from "./batch.ts";
import { parseSkillDoc } from "./frontmatter.ts";
import { batchAllowanceRefusal, turnContext } from "./learn.ts";
import * as store from "./store.ts";

let root: string | undefined;
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  vi.restoreAllMocks();
});

const OWNER = "owner-a";
const PROFILE = "bot-x";

const builtins = aboutSkills().map((skill) => {
  const doc = parseSkillDoc(skill.markdown);
  if (doc === undefined) throw new Error(`built-in "${skill.name}" has no frontmatter`);
  return {
    name: doc.name,
    description: doc.description,
    markdown: skill.markdown,
    files: skill.files,
  };
});

const fresh = (): string => {
  root = mkdtempSync(join(tmpdir(), "spriessen-skills-batch-"));
  return root;
};

const doc = (name: string, description: string, text: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${text}`;

const seed = async (name: string, text: string): Promise<void> => {
  await store.writeSkill(
    root ?? "",
    OWNER,
    PROFILE,
    { name, body: doc(name, `${name} does things`, text), origin: "self" },
    builtins,
  );
};

/** Everything on disk under the profile scope, as one comparable string. */
const dump = (dir: string): string => {
  if (!existsSync(dir)) return "";
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? [dump(path)] : [`${path}: ${readFileSync(path, "utf8")}`];
    })
    .sort()
    .join("\n");
};

const state = (): string => dump(join(root ?? "", OWNER, PROFILE));

describe("applyOps", () => {
  it("applies a good batch fully; each touched skill's newest version carries the batch reason", async () => {
    fresh();
    await seed("alpha", "# v1");
    const outcomes = await applyOps(
      root ?? "",
      OWNER,
      PROFILE,
      [
        { op: "create", name: "beta", body: doc("beta", "Beta", "# fresh") },
        {
          op: "update",
          name: "alpha",
          body: doc("alpha", "Alpha", "# v2"),
          files: [{ path: "references/notes.md", content: "notes" }],
        },
        { op: "create", name: "gamma", body: doc("gamma", "Gamma", "# gamma") },
      ],
      { builtins, by: "bot", turn: "c1#call-1" },
    );
    expect(outcomes).toEqual([
      { op: "create", name: "beta", version: 1 },
      { op: "update", name: "alpha", version: 2 },
      { op: "create", name: "gamma", version: 1 },
    ]);
    const listed = store.listSkills(root ?? "", OWNER, PROFILE, builtins).map((meta) => meta.name);
    expect(listed).toContain("alpha");
    expect(listed).toContain("beta");
    expect(listed).toContain("gamma");
    const alpha = store.skillVersions(root ?? "", OWNER, PROFILE, "alpha").at(-1);
    expect(alpha?.reason).toContain("batch");
    expect(alpha?.reason).toContain("update");
    expect(alpha?.turn).toBe("c1#call-1");
    expect(store.readSkill(root ?? "", OWNER, PROFILE, "alpha", builtins)?.meta.files).toEqual([
      "references/notes.md",
    ]);
  });

  it("a failing op mid-batch (bad body in op 3 of 5) leaves versions, index and files untouched", async () => {
    fresh();
    await seed("one", "# one");
    await seed("two", "# two");
    const before = state();
    const bad = `---\nname: three\ndescription: Three\n---\n\ncarrying AKIAIOSFODNN7EXAMPLE around`;
    let refused: SkillBatchRefused | undefined;
    try {
      await applyOps(
        root ?? "",
        OWNER,
        PROFILE,
        [
          { op: "create", name: "three", body: doc("three", "Three", "# three") },
          { op: "update", name: "one", body: doc("one", "One", "# one-edited") },
          { op: "create", name: "four", body: bad },
          { op: "update", name: "two", body: doc("two", "Two", "# two-edited") },
          { op: "create", name: "five", body: doc("five", "Five", "# five") },
        ],
        { builtins },
      );
    } catch (cause) {
      refused = cause instanceof SkillBatchRefused ? cause : undefined;
    }
    expect(refused).toBeInstanceOf(SkillBatchRefused);
    expect(refused?._tag).toBe("spriessen/SkillBatchRefused");
    expect(refused?.op).toBe(2);
    expect(refused?.reason).toContain("four");
    expect(state()).toBe(before);
  });

  it("an injected write failure mid-apply restores every snapshot", async () => {
    fresh();
    await seed("keeper", "# v1");
    const before = state();
    const original = store.writeSkill;
    let calls = 0;
    vi.spyOn(store, "writeSkill").mockImplementation((...args: Parameters<typeof original>) => {
      calls += 1;
      if (calls === 2) throw new Error("injected write failure");
      return original(...args);
    });
    let message = "";
    try {
      await applyOps(
        root ?? "",
        OWNER,
        PROFILE,
        [
          { op: "create", name: "newborn", body: doc("newborn", "Newborn", "# newborn") },
          { op: "update", name: "keeper", body: doc("keeper", "Keeper", "# v2") },
        ],
        { builtins },
      );
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).toContain("injected write failure");
    expect(state()).toBe(before);
    const versions = store.skillVersions(root ?? "", OWNER, PROFILE, "keeper");
    expect(versions.map((version) => version.n)).toEqual([1]);
  });

  it("remove is valid in the store API: the skill goes, its history stays", async () => {
    fresh();
    await seed("doomed", "# doomed");
    const outcomes = await applyOps(
      root ?? "",
      OWNER,
      PROFILE,
      [{ op: "remove", name: "doomed" }],
      { builtins },
    );
    expect(outcomes).toEqual([{ op: "remove", name: "doomed", removed: true }]);
    expect(
      store.listSkills(root ?? "", OWNER, PROFILE, builtins).some((meta) => meta.name === "doomed"),
    ).toBe(false);
    expect(store.skillVersions(root ?? "", OWNER, PROFILE, "doomed").length).toBeGreaterThan(0);
  });

  it("refuses built-in targets, duplicates, state mismatches and oversized batches", async () => {
    fresh();
    await seed("alpha", "# alpha");
    const run = async (ops: Parameters<typeof applyOps>[3]): Promise<string> => {
      try {
        await applyOps(root ?? "", OWNER, PROFILE, ops, { builtins });
        return "applied";
      } catch (cause) {
        return cause instanceof SkillBatchRefused
          ? `op ${String(cause.op)}: ${cause.reason}`
          : String(cause);
      }
    };
    const builtin = await run([
      { op: "create", name: "spriessen", body: doc("spriessen", "B", "x") },
    ]);
    expect(builtin).toContain("built-in");
    expect(
      await run([{ op: "update", name: "missing-skill", body: doc("x", "X", "y") }]),
    ).toContain("no skill named");
    expect(await run([{ op: "remove", name: "missing-skill" }])).toContain("no skill named");
    expect(
      await run([{ op: "update", name: "alpha", body: doc("alpha", "A", "# again") }]),
    ).not.toContain("no skill");
    const duplicate = await run([
      { op: "create", name: "beta", body: doc("beta", "B", "# b") },
      { op: "update", name: "beta", body: doc("beta", "B", "# b2") },
    ]);
    expect(duplicate).toContain("twice in this batch");
    const oversized = await run(
      Array.from({ length: MAX_SKILL_OPS + 1 }, (_, at) => ({
        op: "create" as const,
        name: `overflow-${at}`,
        body: doc(`overflow-${at}`, "O", "# o"),
      })),
    );
    expect(oversized).toContain("at most");
    expect(state()).toBe(state());
  });

  it("a gate refusal at any op aborts the batch before anything is written", async () => {
    fresh();
    await seed("alpha", "# alpha");
    const before = state();
    let refused: SkillBatchRefused | undefined;
    try {
      await applyOps(
        root ?? "",
        OWNER,
        PROFILE,
        [
          { op: "create", name: "beta", body: doc("beta", "B", "# b") },
          { op: "create", name: "gamma", body: doc("gamma", "G", "# g") },
        ],
        {
          builtins,
          gate: async (input, index) =>
            index === 1 ? "refused: the gate says no to this one" : undefined,
        },
      );
    } catch (cause) {
      refused = cause instanceof SkillBatchRefused ? cause : undefined;
    }
    expect(refused?._tag).toBe("spriessen/SkillBatchRefused");
    expect(refused?.op).toBe(1);
    expect(refused?.reason).toContain("the gate says no");
    expect(state()).toBe(before);
  });
});

describe("the per-turn batch cap", () => {
  const event = (name: string, saves?: number): AuditEvent => ({
    at: 6_000,
    kind: "tool_call",
    conversationId: "c1",
    profile: "bot-1",
    callId: null,
    name,
    durationMs: null,
    ok: true,
    error: null,
    ...(saves !== undefined ? { saves } : {}),
  });

  it("counts ops, not calls: a skill_edit event weighs its saved ops", async () => {
    const converse = {
      entriesOf: () =>
        Effect.succeed([
          { id: 1, kind: "model", model: [{ role: "user", content: "go", timestamp: 5_000 }] },
        ]),
    };
    const turn = await turnContext(
      {
        converse: converse as never,
        audit: { ofConversation: () => [event("skill_edit", 2)] } as never,
      },
      "c1",
    );
    expect(turn.learned).toBe(2);
    expect(batchAllowanceRefusal(turn.learned, 2)).toContain("only 1");
    expect(batchAllowanceRefusal(turn.learned, 1)).toBeUndefined();
  });

  it("a fresh turn allows a full batch and refuses one op past the cap", () => {
    expect(batchAllowanceRefusal(0, 3)).toBeUndefined();
    expect(batchAllowanceRefusal(0, 4)).toContain("4 ops");
  });
});
