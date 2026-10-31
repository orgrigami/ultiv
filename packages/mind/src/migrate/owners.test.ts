/**
 * The owner-label migration over an offline mind: rows and tasks relabel
 * (agent sentinel rows never move), session-map aliases keep durable
 * conversations reachable under the new keys, memory family content copies
 * to the new keys while the old keys stay put (rollback), and a second run
 * moves nothing.
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { MemoryFact } from "@spriessen/contracts";
import { openMind, migrateOwners, newFact } from "@spriessen/mind";
import { FactsDoc, ownerKey, profileKey } from "../memory/model.ts";
import { TasksDoc } from "../tasks/store.ts";
import { AGENT_OWNER } from "../act/task-tools.ts";

const scratch = join(tmpdir(), "spriessen-migrate-owners-");

const runE = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

/** A minimal valid fact for the family-copy checks. */
const makeFact = (id: string): MemoryFact =>
  newFact({
    id,
    scope: "profile",
    profile: "p",
    text: `note ${id}`,
    kind: "note",
    tags: [],
    entities: [],
    triple: null,
    importance: 2,
    confidence: 1,
    trust: "owner",
    source: { via: "rest", writer: null, origin: "owner", conversation: null, episode: null },
    validFrom: null,
    supersedes: [],
    at: 1,
  });

const seedFact = async (
  converse: Parameters<typeof migrateOwners>[0],
  key: string,
  id: string,
): Promise<void> => {
  await runE(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(FactsDoc, key, { facts: [], migratedAt: null });
      draft.facts = [...draft.facts, makeFact(id)];
    }),
  );
};

const factsAt = async (
  converse: Parameters<typeof migrateOwners>[0],
  key: string,
): Promise<readonly MemoryFact[]> =>
  (await runE(converse.docs.snapshotKeyed(FactsDoc, key)))?.facts ?? [];

describe("migrateOwners", () => {
  it("moves rows, aliases conversation keys, copies memory, and is repeatable", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const mind = handle.mind;
    const converse = mind.converse;

    // Old world: data under two labels.
    const botG = await mind.profiles.create("guest", { name: "Solo" });
    const mainG = await mind.profiles.ensureMain("guest", botG.id);
    const chatG = await mind.profiles.createSession("guest", botG.id, "first chat");
    const botS = await mind.profiles.create("smoker", { name: "Smoked" });
    const mainS = await mind.profiles.ensureMain("smoker", botS.id);

    // A task row under the agent sentinel must not move.
    await runE(
      converse.docs.commit(async (tx) => {
        const draft = await tx.doc(TasksDoc);
        draft.tasks = [
          ...draft.tasks,
          {
            id: "t-agent",
            sessionId: "",
            owner: AGENT_OWNER,
            conversationId: null,
            prompt: "p",
            status: "done",
            result: null,
            error: null,
            createdAt: 1,
            finishedAt: 2,
            bot: { owner: AGENT_OWNER, profileId: botG.id },
          },
        ];
      }),
    );

    // Memory under old keys.
    await seedFact(converse, profileKey("guest", botG.id), "f1");
    await seedFact(converse, ownerKey("guest"), "f2");

    // Conversation ids before migration: the alias targets.
    const cidBefore = await runE(converse.conversationIdOf(`` + `guest:${botG.id}:${chatG.id}`));
    const cidMainBefore = await runE(converse.conversationIdOf(`guest:${botG.id}:${mainG.id}`));
    expect(cidBefore).toBeDefined();
    expect(cidMainBefore).toBeDefined();

    const report = await migrateOwners(converse, { to: "owner" });
    expect(report.movedFrom).toContain("guest");
    expect(report.movedFrom).toContain("smoker");
    expect(report.profiles).toBe(2);
    expect(report.mainBots).toBe(2);
    expect(report.conversationKeys).toBeGreaterThanOrEqual(2);
    expect(report.tasks).toBe(0);

    // Rows relabeled.
    expect((await mind.profiles.rowOf(chatG.id))?.owner).toBe("owner");
    expect((await mind.profiles.rowOf(mainG.id))?.owner).toBe("owner");
    expect((await mind.profiles.rowOf(mainS.id))?.owner).toBe("owner");

    // New keys resolve to the SAME conversations (transcripts preserved).
    expect(await runE(converse.conversationIdOf(`owner:${botG.id}:${chatG.id}`))).toBe(cidBefore);
    expect(await runE(converse.conversationIdOf(`owner:${botG.id}:${mainG.id}`))).toBe(
      cidMainBefore,
    );

    // Another label never resolves another's chat (the scoped default key).
    expect(await mind.profiles.keyForSession("intruder", chatG.id)).toBe(
      `intruder:default:${chatG.id}`,
    );

    // Memory under the new keys; the old keys keep their content (rollback).
    expect((await factsAt(converse, profileKey("owner", botG.id))).map((f) => f.id)).toEqual([
      "f1",
    ]);
    expect((await factsAt(converse, ownerKey("owner"))).map((f) => f.id)).toEqual(["f2"]);
    expect((await factsAt(converse, profileKey("guest", botG.id))).map((f) => f.id)).toEqual([
      "f1",
    ]);

    // The agent task row keeps its sentinel.
    const tasksAfter = await runE(converse.docs.snapshot(TasksDoc));
    expect(tasksAfter?.tasks.find((task) => task.id === "t-agent")?.owner).toBe(AGENT_OWNER);

    // Repeatable: a second run moves nothing.
    const second = await migrateOwners(converse, { to: "owner" });
    expect(second.sessions).toBe(0);
    expect(second.profiles).toBe(0);
    expect(second.conversationKeys).toBe(0);
    expect(second.memoryStores).toBe(0);

    // touchSession cross-owner: an intruder touch does not move the row
    // (after the repeatability check, since the touch registers a ghost row
    // under the intruder label that a further migration would claim).
    await mind.profiles.touchSession("intruder", chatG.id, { at: 999 });
    const row = await mind.profiles.rowOf(chatG.id);
    expect(row?.owner).toBe("owner");
    expect(row?.lastMessageAt).not.toBe(999);

    await handle.close();
  });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
