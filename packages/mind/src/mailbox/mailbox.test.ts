import { expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { openMind } from "../entity.ts";
import { mailboxService, shouldSignalReply } from "./mailbox.ts";
import type { MailboxEntry } from "@spreissen/contracts";

// Wake coalescing has a real-world window; tests assert synchronously after
// sends, so collapse it to near-zero here (the knob is read at service build).
process.env.MAILBOX_WAKE_DEBOUNCE_MS = "20";

import { messageTools } from "./tools.ts";
import { taskConversationKey } from "../tasks/tasks.ts";

/** A mailbox with zero retry delay, for dead-letter tests. */
const fastMailbox = (handle: Awaited<ReturnType<typeof openMind>>) =>
  mailboxService({
    converse: handle.mind.converse,
    profiles: handle.mind.profiles,
    rooms: handle.mind.rooms,
    audit: handle.mind.audit,
    options: { retryDelayMs: 0 },
  });

const settle = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "";
  } catch (cause) {
    const error = cause as { reason?: string; what?: string };
    return error.reason ?? error.what ?? String(cause);
  }
};

it("refuses unknown targets, self-messaging and archived profiles", async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const mailbox = fastMailbox(handle);
  const { profiles } = handle.mind;
  const a = await profiles.create("harry", { name: "CoS" });
  const b = await profiles.create("harry", { name: "Researcher" });

  expect(
    await settle(
      mailbox.send({
        owner: "harry",
        from: a.id,
        to: "nope",
        kind: "request",
        body: "x",
        origin: "human",
      }),
    ),
  ).toContain("profile nope");
  expect(
    await settle(
      mailbox.send({
        owner: "harry",
        from: a.id,
        to: a.id,
        kind: "request",
        body: "x",
        origin: "human",
      }),
    ),
  ).toContain("yourself");

  await profiles.setArchived("harry", b.id, true);
  expect(
    await settle(
      mailbox.send({
        owner: "harry",
        from: a.id,
        to: b.id,
        kind: "request",
        body: "x",
        origin: "human",
      }),
    ),
  ).toContain("archived");
  await profiles.setArchived("harry", b.id, false);
  await handle.close();
});

it("open by default: tool sends reach any sibling; canInitiate restricts or locks", async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const mailbox = fastMailbox(handle);
  const { profiles } = handle.mind;
  const cos = await profiles.create("harry", { name: "CoS" });
  const researcher = await profiles.create("harry", { name: "Researcher" });

  // Default policy is ["*"]: an owner-instructed relay ("tell Researcher…")
  // rides the model's own tool call and must go through.
  const open = await mailbox.send({
    owner: "harry",
    from: cos.id,
    to: researcher.id,
    kind: "notify",
    body: "hello",
    origin: "tool",
  });
  expect(open.status).toBe("pending");

  // An explicit empty list locks the profile out of the mailbox…
  await profiles.update("harry", cos.id, {
    policies: { ...cos.policies, canInitiate: [] },
  });
  expect(
    await settle(
      mailbox.send({
        owner: "harry",
        from: cos.id,
        to: researcher.id,
        kind: "notify",
        body: "x",
        origin: "tool",
      }),
    ),
  ).toContain("not allowed to initiate");
  // …while human-instructed (REST) sends still pass.
  const human = await mailbox.send({
    owner: "harry",
    from: cos.id,
    to: researcher.id,
    kind: "notify",
    body: "y",
    origin: "human",
  });
  expect(human.status).toBe("pending");

  // An explicit list admits exactly its members.
  await profiles.update("harry", cos.id, {
    policies: { ...cos.policies, canInitiate: [researcher.id] },
  });
  const listed = await mailbox.send({
    owner: "harry",
    from: cos.id,
    to: researcher.id,
    kind: "notify",
    body: "z",
    origin: "tool",
  });
  expect(listed.status).toBe("pending");
  await handle.close();
});

it("caps ad-hoc room exchanges at 3 per bot per topic (tool sends only)", async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const mailbox = fastMailbox(handle);
  const { profiles } = handle.mind;
  const a = await profiles.create("harry", { name: "One" });
  const b = await profiles.create("harry", { name: "Two" });

  const send = (topic: string, origin: "tool" | "human" = "tool") =>
    settle(
      mailbox.send({
        owner: "harry",
        from: a.id,
        to: b.id,
        kind: "notify",
        body: "x",
        topic,
        origin,
      }),
    );

  // Three tool sends to the sibling are fine, across topics…
  expect(await send("pricing")).toBe("");
  expect(await send("pricing")).toBe("");
  expect(await send("onboarding")).toBe("");
  // …the fourth is refused regardless of topic (per-pair cap)…
  expect(await send("pricing")).toContain("exchange cap reached");
  // …and deliberate (human/REST) sends are exempt.
  expect(await send("pricing", "human")).toBe("");
  await handle.close();
});

it("exchange cap resets when the owner re-briefs the sending thread", async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const mailbox = fastMailbox(handle);
  const { converse, profiles } = handle.mind;
  const a = await profiles.create("harry", { name: "One", onboard: false });
  const b = await profiles.create("harry", { name: "Two", onboard: false });
  const main = await profiles.ensureMain("harry", a.id);
  const mainChat = await Effect.runPromise(converse.ensure(await profiles.keyOfRow(main)));

  // Owner briefs: an ordinary (unbracketed) input opens the exchange window.
  await Effect.runPromise(converse.submit(mainChat, "please ping Two"));
  const send = () =>
    settle(
      mailbox.send({
        owner: "harry",
        from: a.id,
        to: b.id,
        kind: "notify",
        body: "x",
        origin: "tool",
        originConversation: String(mainChat.id),
      }),
    );
  expect(await send()).toBe("");
  expect(await send()).toBe("");
  expect(await send()).toBe("");
  // Budget exhausted inside this exchange…
  expect(await send()).toContain("exchange cap reached");
  // …and the wake signals are bracketed machinery, so they do NOT reset it.
  await Effect.runPromise(converse.submit(mainChat, "[reply from Two • re: x]\n\ndone"));
  expect(await send()).toContain("exchange cap reached");
  // A fresh owner instruction resets the budget.
  await Effect.runPromise(converse.submit(mainChat, "new task: ping Two again"));
  expect(await send()).toBe("");
  await handle.close();
});

it("task conversations inherit the spawner's bot scope and can message", async () => {
  const handle = await openMind({ storage: new MemoryStorage() });
  const mailbox = fastMailbox(handle);
  const { converse, profiles, tasks } = handle.mind;
  const a = await profiles.create("harry", { name: "One", onboard: false });
  const b = await profiles.create("harry", { name: "Two", onboard: false });
  const main = await profiles.ensureMain("harry", a.id);
  const mainChat = await Effect.runPromise(converse.ensure(await profiles.keyOfRow(main)));

  // Spawn as the tool does: the task is bound to the spawner's bot up front.
  const task = await Effect.runPromise(
    tasks.spawn({
      sessionId: "",
      owner: "agent",
      conversationId: String(mainChat.id),
      prompt: "send a message on behalf of One",
    }),
  );
  expect(task.bot).toEqual({ owner: "harry", profileId: a.id });
  const taskChat = await Effect.runPromise(converse.ensure(taskConversationKey(task.id)));
  expect(profiles.scopeOf(String(taskChat.id))?.profileId).toBe(a.id);
  expect(profiles.scopeOf(String(taskChat.id))?.kind).toBe("task");
  // Task conversations stay out of session lists.
  expect((await profiles.listSessions("harry")).every((row) => row.kind !== "task")).toBe(true);

  // The message tool works FROM the task conversation — the task runs as One.
  const tools = messageTools(mailbox, profiles, handle.mind.rooms);
  const message = tools.find((tool) => tool.name === "message");
  const result = await message!.execute(
    { to: b.id, kind: "notify", body: "from the task" },
    { conversationId: taskChat.id } as never,
    undefined as never,
  );
  const text = JSON.stringify(result);
  expect(text).toContain("admitted");
  expect(text).not.toContain("belongs to no bot");
  await handle.close();
});

it("signals a finished request only when no reply came through the tunnel", () => {
  const envelope = {
    id: "req-1",
    chain: ["a"],
    from: "a",
    to: "b",
    kind: "request" as const,
    replyTo: null,
    body: "x",
    artifacts: [],
    at: 100,
  };
  const entry = (from: string, to: string, at: number): MailboxEntry =>
    ({
      envelope: {
        id: `${from}-${to}-${at}`,
        chain: [from],
        from,
        to,
        kind: "notify",
        replyTo: null,
        body: "x",
        artifacts: [],
        at,
      },
      status: "replied",
      retries: 0,
      deliveredAt: at,
      settledAt: at,
      error: null,
    }) as MailboxEntry;
  // No reply at all → signal (the sender still needs to learn the turn ended).
  expect(shouldSignalReply(envelope, [entry("a", "b", 90)])).toBe(true);
  // A reply from the recipient after our send → the reply itself woke the
  // sender; a signal would double every turn.
  expect(shouldSignalReply(envelope, [entry("a", "b", 90), entry("b", "a", 140)])).toBe(false);
  // An OLD reply predating our request is not an answer to it → signal.
  expect(shouldSignalReply(envelope, [entry("b", "a", 40)])).toBe(true);
  // Traffic to other peers is irrelevant → signal.
  expect(shouldSignalReply(envelope, [entry("b", "c", 150)])).toBe(true);
});
