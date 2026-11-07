/**
 * The react tool on a real offline mind: it marks the owner's LATEST message
 * (machinery inputs such as task wakes are skipped), `ok`/`no`/`done` end the
 * turn without another model request while `looking` lets it go on, and
 * nothing is reacted to before the owner has said anything.
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { TranscriptEntry } from "@spriessen/contracts";
import { openMind } from "../entity.ts";
import type { AuditService } from "../audit/audit.ts";
import { isOwnerMessage, latestOwnerMessage } from "./reactions.ts";
import { reactTools } from "./tools.ts";

const OWNER = "owner";

type Result = {
  output: { text: string }[];
  isError?: boolean;
  details?: { target: number; reaction: string };
  control?: { terminate?: boolean };
};

const setup = async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { converse, profiles } = handle.mind;
  const bot = await profiles.create(OWNER, { name: "Acker", onboard: false });
  const session = await profiles.ensureMain(OWNER, bot.id);
  const key = await profiles.keyForSession(OWNER, session.id);
  const conversationId = String((await Effect.runPromise(converse.ensure(key))).id);
  const audit = { record: () => undefined } as unknown as AuditService;
  const [tool] = reactTools({ converse, profiles, audit });
  if (tool === undefined) throw new Error("missing react tool");
  const call = (reaction: string) =>
    tool.execute(
      { reaction } as never,
      { conversationId, callId: "k" } as never,
      {} as never,
    ) as unknown as Promise<Result>;
  /** Submit a user-role input; its transcript id is the newest entry's id × 100. */
  const say = async (text: string): Promise<number> => {
    const conversation = await Effect.runPromise(converse.ensure(key));
    await Effect.runPromise(converse.submit(conversation, text));
    const [newest] = await Effect.runPromise(converse.entriesOf(conversationId, 1));
    if (newest === undefined) throw new Error("no entry after submit");
    return newest.id * 100;
  };
  return { handle, call, say };
};

describe("react tool (offline, MemoryStorage)", () => {
  it("marks the owner's latest message and ends the turn on ok", async () => {
    const { handle, call, say } = await setup();
    await say("first");
    const latest = await say("ship it when ready");
    const done = await call("ok");
    expect(done.isError).toBeUndefined();
    expect(done.details).toEqual({ target: latest, reaction: "ok" });
    expect(done.control).toEqual({ terminate: true });
    await handle.close();
  });

  it("skips machinery inputs: a task wake is not the owner's message", async () => {
    const { handle, call, say } = await setup();
    const owner = await say("look into the invoices");
    await say("[task t1 finished] all invoices are paid");
    const done = await call("done");
    expect(done.details?.target).toBe(owner);
    await handle.close();
  });

  it("lets the turn go on for looking", async () => {
    const { handle, call, say } = await setup();
    await say("can you check the logs?");
    const looking = await call("looking");
    expect(looking.isError).toBeUndefined();
    expect(looking.control).toBeUndefined();
    await handle.close();
  });

  it("refuses when the owner has said nothing yet", async () => {
    const { handle, call } = await setup();
    const refused = await call("ok");
    expect(refused.isError).toBe(true);
    expect(refused.output[0]?.text).toContain("no owner message");
    await handle.close();
  });
});

describe("owner message rules", () => {
  const input = (id: number, text: string): TranscriptEntry => ({ id, kind: "input", at: 0, text });

  it("treats typed inputs as owner messages and bracketed machinery as not", () => {
    expect(isOwnerMessage(input(1, "hello"))).toBe(true);
    expect(isOwnerMessage(input(1, "[cron daily] run"))).toBe(false);
    expect(isOwnerMessage(input(1, "[webhook gh] {}"))).toBe(false);
    expect(isOwnerMessage(input(1, "[from parent] shorter"))).toBe(false);
    expect(isOwnerMessage({ id: 1, kind: "note", at: 0, text: "[reply from X] hi" })).toBe(false);
  });

  it("finds the newest owner message", () => {
    const steps = [input(100, "a"), input(200, "b"), input(300, "[sensor rss] new item")];
    expect(latestOwnerMessage(steps)).toBe(200);
    expect(latestOwnerMessage([])).toBeUndefined();
  });
});
