import { expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Effect } from "effect";
import type { MailboxEntry, TaskInfo } from "@spreissen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { openMind } from "../entity.ts";
import { TasksDoc, tasksService } from "../tasks/tasks.ts";
import { MailboxDoc, mailboxService } from "./mailbox.ts";

// Collapse the wake-coalescing window (read when a service is built).
process.env.MAILBOX_WAKE_DEBOUNCE_MS = "20";

type Handle = Awaited<ReturnType<typeof openMind>>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A converse whose turns never finish: messages stay pending, as in a crash mid-turn. */
const stuck = (converse: ConverseService): ConverseService => ({
  ...converse,
  settle: () => Effect.never,
});

const mailboxOn = (handle: Handle, converse: ConverseService, deadlineMs?: number) =>
  mailboxService({
    converse,
    profiles: handle.mind.profiles,
    rooms: handle.mind.rooms,
    audit: handle.mind.audit,
    options: { retryDelayMs: 0, ...(deadlineMs !== undefined ? { deadlineMs } : {}) },
  });

/** Everything in a bot's main thread, as text. */
const mainText = async (handle: Handle, profileId: string): Promise<string> => {
  const { converse, profiles } = handle.mind;
  const main = await Effect.runPromise(
    converse.ensure(await profiles.keyOfRow(await profiles.ensureMain("harry", profileId))),
  );
  return JSON.stringify((await main.viewState(BACKGROUND_CONTEXT)).value?.entries ?? []);
};

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

const twoBots = async (handle: Handle) => ({
  a: await handle.mind.profiles.create("harry", { name: "CoS", onboard: false }),
  b: await handle.mind.profiles.create("harry", { name: "Researcher", onboard: false }),
});

const entryOf = async (handle: Handle, id: string): Promise<MailboxEntry | undefined> =>
  (await handle.mind.mailbox.list("harry")).find((entry) => entry.envelope.id === id);

it("a redelivered message reaches the recipient once (same request id)", async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { a, b } = await twoBots(handle);
  const first = mailboxOn(handle, stuck(handle.mind.converse));
  const sent = await first.send({
    owner: "harry",
    from: a.id,
    to: b.id,
    kind: "notify",
    body: "knock-once",
    origin: "human",
  });
  await sleep(100);
  const before = occurrences(await mainText(handle, b.id), "knock-once");
  expect(before).toBeGreaterThan(0);
  expect((await entryOf(handle, sent.envelope.id))?.submissionId).toBeDefined();

  // "Restart": a fresh service finds the message pending and delivers it again.
  const report = await mailboxOn(handle, stuck(handle.mind.converse)).recover();
  expect(report.redelivered).toBe(1);
  await sleep(100);
  expect(occurrences(await mainText(handle, b.id), "knock-once")).toBe(before);
  await handle.close();
});

it("boot recovery redelivers pending messages and quietly closes stale legacy ones", async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { a, b } = await twoBots(handle);
  const now = Date.now();
  const pending = (id: string, at: number, deadlineAt?: number): MailboxEntry => ({
    envelope: {
      id,
      chain: [a.id],
      from: a.id,
      to: b.id,
      kind: "notify",
      replyTo: null,
      topic: "",
      body: `body-${id}`,
      artifacts: [],
      at,
    },
    status: "pending",
    retries: 0,
    deliveredAt: null,
    settledAt: null,
    error: null,
    owner: "harry",
    origin: "human",
    originConversation: null,
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
  });
  await Effect.runPromise(
    handle.mind.converse.docs.commit(async (tx) => {
      const draft = await tx.doc(MailboxDoc);
      draft.items = [pending("fresh", now, now + 60_000), pending("legacy", now - 86_400_000)];
    }),
  );
  const report = await mailboxOn(handle, stuck(handle.mind.converse)).recover();
  expect(report).toEqual({ redelivered: 1, expired: 0, rewoken: 0 });
  await sleep(100);
  const bText = await mainText(handle, b.id);
  expect(bText).toContain("body-fresh");
  expect(bText).not.toContain("body-legacy");
  expect((await entryOf(handle, "legacy"))?.status).toBe("expired");
  expect(await mainText(handle, a.id)).not.toContain("[nack from");
  await handle.close();
});

it("a message past its deadline expires and NACKs the sender", async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { a, b } = await twoBots(handle);
  const mailbox = mailboxOn(handle, stuck(handle.mind.converse), 50);
  const heard: string[] = [];
  mailbox.onExpired((expired) => heard.push(`${expired.owner}:${expired.envelope.id}`));
  const sent = await mailbox.send({
    owner: "harry",
    from: a.id,
    to: b.id,
    kind: "request",
    body: "status?",
    origin: "human",
  });
  await sleep(300);
  const entry = await entryOf(handle, sent.envelope.id);
  expect(entry?.status).toBe("expired");
  expect(heard).toEqual([`harry:${sent.envelope.id}`]);
  expect(entry?.senderNotified).toBe(true);
  const aText = await mainText(handle, a.id);
  expect(aText).toContain(`[nack from Researcher • re: ${sent.envelope.id}] timed out`);
  await handle.close();
});

it("the owner can cancel a pending message; the sender is told", async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const { a, b } = await twoBots(handle);
  const mailbox = mailboxOn(handle, stuck(handle.mind.converse));
  const sent = await mailbox.send({
    owner: "harry",
    from: a.id,
    to: b.id,
    kind: "request",
    body: "never mind",
    origin: "human",
  });
  await sleep(50);
  expect((await mailbox.cancel("harry", sent.envelope.id)).status).toBe("cancelled");
  await sleep(100);
  expect((await entryOf(handle, sent.envelope.id))?.status).toBe("cancelled");
  expect(await mainText(handle, a.id)).toContain("[nack from Researcher");
  await expect(mailbox.cancel("someone-else", sent.envelope.id)).rejects.toBeDefined();
  await handle.close();
});

it("a task that finished before a crash still wakes its parent on boot", async () => {
  const first = await openMind({ storage: new MemoryStorage() });
  const { a } = await twoBots(first);
  const { converse, profiles } = first.mind;
  const parent = await Effect.runPromise(
    converse.ensure(await profiles.keyOfRow(await profiles.ensureMain("harry", a.id))),
  );
  const task: TaskInfo = {
    id: "t-crashed",
    sessionId: "s",
    owner: "harry",
    conversationId: String(parent.id),
    prompt: "dig",
    status: "done",
    result: "the answer is 42",
    error: null,
    createdAt: Date.now(),
    finishedAt: Date.now(),
    notified: false,
  };
  await Effect.runPromise(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(TasksDoc);
      draft.tasks = [task];
    }),
  );
  // What the entity runs on boot once the profiles index exists.
  await tasksService(converse).attach(async () => null);
  await sleep(150);
  const text = await mainText(first, a.id);
  expect(text).toContain("[task t-crashed finished]");
  expect(text).toContain("the answer is 42");
  const row = (await Effect.runPromise(first.mind.tasks.list())).find(
    (candidate) => candidate.id === "t-crashed",
  );
  expect(row?.notified).toBe(true);
  await first.close();
});
