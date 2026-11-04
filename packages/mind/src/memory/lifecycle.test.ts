/**
 * Memory v3 lifecycle, offline: facts carry model-visible #handles that every
 * tool resolves; change keeps the old version as the past, correct hides the
 * wrong one for good, end retires a fact now or drops it after its day,
 * confirm firms an inference up; and the write decision never holds the
 * global commit lock while it asks a model.
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage, defineDoc } from "@earendil-works/pi-durable";
import { openMind } from "../entity.ts";
import { writeFactV2 } from "./consolidate.ts";
import { handleOf, resolveFactRef } from "./handles.ts";
import { parseWhen } from "./dates.ts";

const OWNER = "harry";
const DAY = 86_400_000;

const setup = async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const bot = await handle.mind.profiles.create(OWNER, { name: "Keeper", onboard: false });
  const { memory } = handle.mind;
  const write = (text: string, extra: Record<string, unknown> = {}) =>
    memory.writeV2({
      owner: OWNER,
      profileId: bot.id,
      scope: "profile",
      writer: bot.id,
      text,
      ...extra,
    });
  const facts = () => memory.readFacts(OWNER, bot.id);
  return { handle, bot, memory, write, facts };
};

describe("fact handles", () => {
  it("recall lines lead with a handle every tool resolves", async () => {
    const { handle, bot, memory, write } = await setup();
    const written = await write("Harry's cat is called Mochi");
    const recalled = await memory.recallV2(OWNER, bot.id, { query: "cat" });
    expect(recalled.lines[0]).toMatch(new RegExp(`^${handleOf(written.id)} Harry's cat`));
    expect(resolveFactRef(handleOf(written.id), [{ id: written.id }])).toBe(written.id);
    // forget and history take the handle, not only the full id.
    const chain = await memory.history(OWNER, bot.id, handleOf(written.id));
    expect(chain[0]?.id).toBe(written.id);
    await memory.forget(OWNER, bot.id, handleOf(written.id), "wrong cat", null);
    expect((await memory.recallV2(OWNER, bot.id, { query: "cat" })).facts).toHaveLength(0);
    await handle.close();
  });

  it("an unknown handle is refused with words the model can act on", async () => {
    const { handle, write } = await setup();
    await write("Harry drinks tea");
    await expect(write("Harry drinks coffee", { replaces: "#ffffffff" })).rejects.toMatchObject({
      what: expect.stringContaining("#ffffffff"),
    });
    await handle.close();
  });
});

describe("change, correct, end, confirm", () => {
  it("change keeps the old version as the past", async () => {
    const { handle, bot, memory, write, facts } = await setup();
    const first = await write("Harry lives in Jakarta");
    const second = await write("Harry lives in Bandung now", { replaces: handleOf(first.id) });
    const all = await facts();
    const old = all.find((fact) => fact.id === first.id);
    expect(old?.status).toBe("superseded");
    expect(old?.retired).toBe("changed");
    const now = await memory.recallV2(OWNER, bot.id, { query: "where does harry live" });
    expect(now.facts.map((fact) => fact.id)).toEqual([second.id]);
    const past = await memory.recallV2(OWNER, bot.id, {
      query: "harry lives",
      includeHistory: true,
    });
    expect(past.facts.map((fact) => fact.id)).toContain(first.id);
    await handle.close();
  });

  it("correct hides the wrong version even from history", async () => {
    const { handle, bot, memory, write, facts } = await setup();
    const from = Date.now() - 30 * DAY;
    const wrong = await write("Harry's birthday is on 3 May", { validFrom: from });
    const right = await write("Harry's birthday is on 5 March", {
      replaces: handleOf(wrong.id),
      correction: true,
    });
    const all = await facts();
    expect(all.find((fact) => fact.id === wrong.id)?.retired).toBe("corrected");
    // The right version held all along.
    expect(all.find((fact) => fact.id === right.id)?.validFrom).toBe(from);
    const past = await memory.recallV2(OWNER, bot.id, { query: "birthday", includeHistory: true });
    expect(past.facts.map((fact) => fact.id)).toEqual([right.id]);
    const chain = await memory.history(OWNER, bot.id, right.id);
    expect(chain.map((entry) => entry.change)).toEqual(["corrected", "superseded"]);
    await handle.close();
  });

  it("end retires a fact now, or drops it from recall after its day", async () => {
    const { handle, bot, memory, write, facts } = await setup();
    const leave = await write("Harry is on leave");
    const ended = await memory.end(OWNER, bot.id, handleOf(leave.id), Date.now() + 2 * DAY, null);
    expect(ended.retired).toBe(false);
    const soon = await memory.recallV2(OWNER, bot.id, { query: "leave" });
    expect(soon.lines[0]).toContain("until");
    // Read three days later, the fact is past.
    const later = (await facts()).map((fact) => ({ ...fact }));
    const { recall } = await import("./recall.ts");
    expect(recall({ facts: later, query: "leave", now: Date.now() + 3 * DAY }).facts).toHaveLength(
      0,
    );
    const office = await write("Harry works from the Kemang office");
    await memory.end(OWNER, bot.id, handleOf(office.id), undefined, null);
    const gone = (await facts()).find((fact) => fact.id === office.id);
    expect(gone?.status).toBe("superseded");
    expect(gone?.retired).toBe("ended");
    await expect(
      memory.end(OWNER, bot.id, handleOf(office.id), undefined, null),
    ).rejects.toMatchObject({
      reason: expect.stringContaining("no longer current"),
    });
    await handle.close();
  });

  it("confirm firms an inference up", async () => {
    const { handle, bot, memory, write, facts } = await setup();
    const guess = await write("Harry probably prefers mornings for calls", { basis: "inferred" });
    expect((await memory.recallV2(OWNER, bot.id, { query: "calls" })).lines[0]).toContain(
      "inferred, unconfirmed",
    );
    await memory.confirm(OWNER, bot.id, handleOf(guess.id), null);
    const fact = (await facts()).find((candidate) => candidate.id === guess.id);
    expect(fact?.basis).toBe("confirmed");
    expect(fact?.confirmations).toBe(1);
    expect((await memory.recallV2(OWNER, bot.id, { query: "calls" })).lines[0]).not.toContain(
      "inferred",
    );
    await handle.close();
  });
});

describe("dates as models write them", () => {
  it("reads a calendar day in WIB, ISO times and today", () => {
    expect(parseWhen("2026-11-10")).toBe(Date.UTC(2026, 10, 10) - 7 * 3_600_000);
    expect(parseWhen("2026-11-10T12:00:00Z")).toBe(Date.UTC(2026, 10, 10, 12));
    expect(parseWhen(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(() => parseWhen("2026-02-30")).toThrow();
    expect(() => parseWhen("next tuesday-ish")).toThrow();
  });
});

describe("the write decision and the commit lock", () => {
  it("asks the model outside the lock: other writes go on meanwhile", async () => {
    const { handle, bot } = await setup();
    const converse = handle.mind.converse;
    await writeFactV2(
      { converse },
      {
        owner: OWNER,
        profileId: bot.id,
        scope: "profile",
        writer: bot.id,
        text: "Harry likes green tea every morning",
      },
    );
    let asked = 0;
    const slowJev = {
      available: true,
      pick: () =>
        Effect.promise(async () => {
          asked += 1;
          await new Promise((resolve) => setTimeout(resolve, 600));
          return "keep both as separate facts";
        }),
    };
    const ambiguous = writeFactV2(
      { converse, decide: slowJev as never },
      {
        owner: OWNER,
        profileId: bot.id,
        scope: "profile",
        writer: bot.id,
        text: "Harry likes green tea every evening",
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const Other = defineDoc<{ n: number }>({
      kind: "test.other",
      version: 1,
      scope: "session",
      initial: () => ({ n: 0 }),
      checkpointWhen: () => true,
    });
    const started = Date.now();
    await Effect.runPromise(
      converse.docs.commit(async (tx) => {
        const doc = await tx.doc(Other);
        doc.n += 1;
      }),
    );
    expect(Date.now() - started).toBeLessThan(300);
    await ambiguous;
    expect(asked).toBe(1);
    await handle.close();
  });
});

describe("functional predicates", () => {
  it("fold synonyms and compare names case-blind, so a move supersedes", async () => {
    const { decideWrite } = await import("./decide.ts");
    const { normalizeTriple } = await import("./predicates.ts");
    expect(normalizeTriple({ s: " Harry ", p: "Resides In", o: "Jakarta" })).toEqual({
      s: "Harry",
      p: "lives_in",
      o: "Jakarta",
    });
    expect(normalizeTriple({ s: "Harry", p: "tinggal di", o: "Bandung" })?.p).toBe("lives_in");
    const old = {
      id: "f-old",
      text: "Harry lives in Jakarta",
      hash: "x",
      entities: [],
      triple: { s: "Harry", p: "lives_in", o: "Jakarta" },
    } as never;
    const decision = await decideWrite(
      {},
      {
        text: "harry moved to Bandung last month",
        tags: [],
        entityIds: [],
        triple: { s: "harry", p: "moved_to", o: "Bandung" },
        current: [old],
      },
    );
    expect(decision).toMatchObject({ op: "supersede", targetId: "f-old" });
  });
});
