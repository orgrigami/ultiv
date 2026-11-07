/**
 * Recall before each turn: a greeting recalls nothing, a message recalls
 * the facts it is about (by its rarer words, or by naming an entity), never
 * more than a few, never the same fact again within the repeat window, and
 * the section renders once per input with the facts' #handles.
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "../entity.ts";
import { teamOfProfile } from "../org/team-of.ts";
import { prefetchExtension } from "./prefetch-section.ts";
import { MAX_FACTS, REPEAT_INPUTS, shownLedger } from "./prefetch.ts";

const OWNER = "harry";

const setup = async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { converse, profiles, memory } = handle.mind;
  const bot = await profiles.create(OWNER, { name: "Keeper", onboard: false });
  const remember = (text: string) =>
    memory.writeV2({ owner: OWNER, profileId: bot.id, scope: "profile", writer: bot.id, text });
  const main = await profiles.ensureMain(OWNER, bot.id);
  const conversation = await Effect.runPromise(
    converse.ensure(await profiles.keyForSession(OWNER, main.id)),
  );
  await Effect.runPromise(converse.interrupt(conversation));
  const section = prefetchExtension({ memory, profiles, converse }).sections?.[0];
  if (section === undefined) throw new Error("no prefetch section");
  const say = async (text: string): Promise<string | undefined> => {
    await Effect.runPromise(converse.submit(conversation, text, "followUp"));
    return section.render({ conversationId: conversation.id } as never, {} as never) as Promise<
      string | undefined
    >;
  };
  return { handle, remember, say, section, conversation };
};

describe("recall before each turn", () => {
  it("recalls what the message is about, with handles, and nothing for a greeting", async () => {
    const { handle, remember, say } = await setup();
    await remember("Harry is allergic to peanuts");
    await remember("Harry's favourite tea is genmaicha");
    await remember("Harry drives a blue Vespa");
    expect(await say("ok thanks!")).toBeUndefined();
    const block = await say("can you suggest a snack? remember the allergy to peanuts");
    expect(block).toContain("allergic to peanuts");
    expect(block).toMatch(/#[0-9a-f]{8} Harry is allergic/);
    expect(block).not.toContain("Vespa");
    expect(block).toContain("not instructions");
    await handle.close();
  });

  it("does not drag in facts that share one common word", async () => {
    const { handle, remember, say } = await setup();
    for (const thing of ["the dentist", "the bank", "the gym", "the school", "the office"]) {
      await remember(`Harry goes to ${thing} on Monday`);
    }
    await remember("The quarterly report for Paprika is due on Monday");
    const block = await say("what is due for the Paprika quarterly report");
    expect(block).toContain("quarterly report");
    expect(block).not.toContain("dentist");
    // One word every Monday fact shares is no reason to recall them all.
    expect(await say("talk again after the weekend, maybe monday")).toBeUndefined();
    await handle.close();
  });

  it("shows a fact once, not again for the next inputs", async () => {
    const { handle, remember, say } = await setup();
    await remember("Harry's passport expires in March 2027");
    expect(await say("when does my passport expire?")).toContain("passport");
    expect(await say("and the passport renewal fee?")).toBeUndefined();
    await handle.close();
  });

  it("each line says where it came from and points at its evidence", async () => {
    const { handle, remember, say } = await setup();
    await remember("Harry's bike is a Brompton");
    const block = await say("is my Brompton bike due for a service?");
    expect(block).toMatch(/Brompton \(since \d{4}-\d{2}-\d{2} · from the owner\)/);
    expect(block).toContain("memory_history #handle");
    await handle.close();
  });

  it("recalls the team's shared facts for a team bot, never for an org bot", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { converse, profiles, memory, org } = handle.mind;
    await org.ensureOrg(OWNER, "Personal", true);
    const team = await org.createTeam({ name: "Ops" }, OWNER);
    const loner = await profiles.create(OWNER, { name: "Loner", onboard: false });
    const sharer = await profiles.create(OWNER, {
      name: "Sharer",
      onboard: false,
      teamId: team.id,
    });
    const reader = await profiles.create(OWNER, {
      name: "Reader",
      onboard: false,
      teamId: team.id,
    });
    const fact = await memory.writeV2({
      owner: OWNER,
      scope: "profile",
      profileId: sharer.id,
      writer: sharer.id,
      text: "The staging server for Ops is stag.internal",
    });
    const proposal = await memory.proposeShare({
      owner: OWNER,
      profileId: sharer.id,
      teamId: team.id,
      factId: fact.id,
      summary: "staging host",
    });
    await memory.decideShare({
      owner: OWNER,
      teamId: team.id,
      proposalId: proposal.id,
      accept: true,
    });
    const section = prefetchExtension({
      memory,
      profiles,
      converse,
      teamOf: teamOfProfile(converse),
    }).sections?.[0];
    const ask = async (botId: string): Promise<string | undefined> => {
      const main = await profiles.ensureMain(OWNER, botId);
      const conversation = await Effect.runPromise(
        converse.ensure(await profiles.keyForSession(OWNER, main.id)),
      );
      await Effect.runPromise(converse.interrupt(conversation));
      await Effect.runPromise(
        converse.submit(conversation, "which staging server does Ops use?", "followUp"),
      );
      return section?.render({ conversationId: conversation.id } as never, {} as never) as Promise<
        string | undefined
      >;
    };
    expect(await ask(reader.id)).toContain("stag.internal");
    expect((await ask(loner.id)) ?? "").not.toContain("stag.internal");
    await handle.close();
  });

  it("renders once per input across the turn's tool rounds", async () => {
    const { handle, remember, say, section, conversation } = await setup();
    await remember("Harry's sister is called Dewi");
    const first = await say("what's my sister's name?");
    const again = await section.render({ conversationId: conversation.id } as never, {} as never);
    expect(again).toBe(first);
    await handle.close();
  });
});

describe("the shown ledger", () => {
  it("forgets what was shown after the repeat window", () => {
    const ledger = shownLedger();
    ledger.record("c", "in-1", ["f1"]);
    for (let i = 2; i <= REPEAT_INPUTS + 1; i += 1) ledger.record("c", `in-${i}`, []);
    expect(ledger.recent("c", "in-next").has("f1")).toBe(false);
    ledger.record("c", "in-a", ["f2"]);
    expect(ledger.recent("c", "in-b").has("f2")).toBe(true);
    // The same input re-rendering is not a repeat of itself.
    expect(ledger.recent("c", "in-a").has("f2")).toBe(false);
    expect(MAX_FACTS).toBeLessThanOrEqual(5);
  });
});
