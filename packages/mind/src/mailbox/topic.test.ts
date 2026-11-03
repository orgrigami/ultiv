import { expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { openMind } from "../entity.ts";
import { mailboxService } from "./mailbox.ts";
import { OFF_TOPIC_BELOW, OFF_TOPIC_REASON, ON_TOPIC_MIN, type TopicJudge } from "./topic.ts";
import { readEntries, writeEntries } from "./store.ts";

process.env.MAILBOX_WAKE_DEBOUNCE_MS = "20";

/** A mailbox wired to a fake judge (the narrow dep, structural typing). */
const judgeMailbox = (handle: Awaited<ReturnType<typeof openMind>>, judge: TopicJudge) =>
  mailboxService({
    converse: handle.mind.converse,
    profiles: handle.mind.profiles,
    rooms: handle.mind.rooms,
    audit: handle.mind.audit,
    judge,
    options: { retryDelayMs: 0 },
  });

const bareMailbox = (handle: Awaited<ReturnType<typeof openMind>>) =>
  mailboxService({
    converse: handle.mind.converse,
    profiles: handle.mind.profiles,
    rooms: handle.mind.rooms,
    audit: handle.mind.audit,
    options: { retryDelayMs: 0 },
  });

/** A counting fake: returns `probability.value` and records every state it saw. */
const fakeJudge = (probability: { value: number }, seen: string[] = []): TopicJudge => ({
  available: true,
  yesNo: (state) => {
    seen.push(state);
    return Effect.succeed(probability.value);
  },
});

const settle = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "";
  } catch (cause) {
    const error = cause as { reason?: string };
    return error.reason ?? String(cause);
  }
};

interface Pair {
  readonly a: string;
  readonly b: string;
  readonly owner: string;
}

const pairOf = async (handle: Awaited<ReturnType<typeof openMind>>): Promise<Pair> => {
  const { profiles } = handle.mind;
  const a = await profiles.create("harry", { name: "One", onboard: false });
  const b = await profiles.create("harry", { name: "Two", onboard: false });
  return { owner: "harry", a: a.id, b: b.id };
};

const sendOf = (mailbox: ReturnType<typeof mailboxService>, pair: Pair) => (body: string) =>
  mailbox.send({
    owner: pair.owner,
    from: pair.a,
    to: pair.b,
    kind: "notify",
    body,
    topic: "pricing",
    origin: "human",
  });

it("the first exchange is free: no judge call under 3 messages; on-topic admits", async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const seen: string[] = [];
  const pair = await pairOf(handle);
  const send = sendOf(judgeMailbox(handle, fakeJudge({ value: 0.99 }, seen)), pair);
  // ON_TOPIC_MIN messages accumulate; none of them is ever classified.
  for (let index = 1; index <= ON_TOPIC_MIN; index += 1) {
    expect(await settle(send(`early message ${index}`))).toBe("");
  }
  expect(seen).toHaveLength(0);
  // The next send faces an established room: judged exactly once, admitted.
  expect(await settle(send("back to the pricing numbers"))).toBe("");
  expect(seen).toHaveLength(1);
  // The draft rides in the prompt with the room's recent transcript.
  expect(seen[0]).toContain("back to the pricing numbers");
  expect(seen[0]).toContain("early message 1");
  await handle.close();
});

it("an off-topic draft refuses with guidance to open a new room", async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const probability = { value: 0.99 };
  const pair = await pairOf(handle);
  const send = sendOf(judgeMailbox(handle, fakeJudge(probability)), pair);
  for (let index = 1; index <= ON_TOPIC_MIN; index += 1) await send(`pricing note ${index}`);
  // The judge turns confident: the room's subject must continue, not switch.
  probability.value = 0.0;
  expect(await settle(send("entirely different: please water the plants"))).toBe(OFF_TOPIC_REASON);
  // Nothing was admitted, and the refusal (only the refusal) is audited.
  const entries = await readEntries(handle.mind.converse);
  expect(entries).toHaveLength(ON_TOPIC_MIN);
  const refusals = handle.mind.audit
    .tail(50)
    .filter((event) => event.kind === "mailbox" && event.name === "off-topic");
  expect(refusals).toHaveLength(1);
  expect(refusals[0]?.ok).toBe(false);
  expect(refusals[0]?.error).toContain("off-topic for this room");
  // A low-confidence verdict is not a NO: the unsure band admits.
  probability.value = OFF_TOPIC_BELOW + 0.01;
  expect(await settle(send("a borderline pricing footnote"))).toBe("");
  await handle.close();
});

it("fail-open: judge outage, error or absence never loses mail", async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const pair = await pairOf(handle);
  // An unavailable judge (the unconfigured Decide faculty shape) admits.
  const down = judgeMailbox(handle, { available: false, yesNo: () => Effect.die("unused") });
  const downSend = sendOf(down, pair);
  for (let index = 1; index <= ON_TOPIC_MIN; index += 1) {
    expect(await settle(downSend(`seed ${index}`))).toBe("");
  }
  expect(await settle(downSend("whatever the judge says"))).toBe("");
  // An erroring judge admits too: the established room is judged, the
  // Effect fails, and the gate catches and admits.
  const erroring = judgeMailbox(handle, {
    available: true,
    yesNo: () => Effect.fail(new Error("judge down")),
  });
  expect(await settle(sendOf(erroring, pair)("still admitted"))).toBe("");
  // No judge at all (Jev unconfigured) admits.
  expect(await settle(sendOf(bareMailbox(handle), pair)("also admitted"))).toBe("");
  expect((await readEntries(handle.mind.converse)).length).toBeGreaterThan(ON_TOPIC_MIN);
  await handle.close();
});

it("a rollover send never calls the judge (a fresh room is on topic by construction)", async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const seen: string[] = [];
  const pair = await pairOf(handle);
  const send = sendOf(judgeMailbox(handle, fakeJudge({ value: 0.0 }, seen)), pair);
  for (let index = 1; index <= ON_TOPIC_MIN; index += 1) await send(`seed ${index}`);
  expect(seen).toHaveLength(0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  // The room goes quiet past ROOM_STALE_MS; the next send rolls over —
  // and is NOT classified, whatever the judge would have said.
  await writeEntries(handle.mind.converse, (items) =>
    items.map((entry) => ({
      ...entry,
      envelope: { ...entry.envelope, at: Date.now() - 25 * 3_600_000 },
    })),
  );
  const rolled = await send("the thread resumes here");
  expect(rolled.rolloverRoomId).toBeDefined();
  expect(seen).toHaveLength(0);
  const pricing = (await handle.mind.rooms.list(pair.owner)).filter((room) =>
    room.topic.startsWith("pricing"),
  );
  expect(pricing).toHaveLength(2);
  await handle.close();
});
