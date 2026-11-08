/**
 * Stop propagation: a Stop travels down the work tree. The task turns
 * cancelled first, then the pending mail its conversation sent settles
 * cancelled without waking it, and the whole walk is idempotent.
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind, type MindHandle } from "../entity.ts";
import { TasksDoc } from "./tasks.ts";
import { MailboxDoc } from "../mailbox/store.ts";

/** The mailbox doc's entries, read raw (the test writes bots that are not profiles). */
const entriesOf = async (handle: MindHandle) => {
  const snapshot = await Effect.runPromise(handle.mind.converse.docs.snapshot(MailboxDoc));
  return snapshot?.items ?? [];
};

type Row = {
  id: string;
  sessionId: string;
  owner: string;
  conversationId: string;
  prompt: string;
  status: "running" | "queued";
  result: null;
  error: null;
  createdAt: number;
  finishedAt: null;
};

const runningRow = (id: string, parent: string, status: "running" | "queued" = "running"): Row => ({
  id,
  sessionId: "s",
  owner: "guest",
  conversationId: parent,
  prompt: "long research",
  status,
  result: null,
  error: null,
  createdAt: Date.now(),
  finishedAt: null,
});

/** A pending envelope sent FROM a conversation, as the mailbox tool would admit. */
const sentFrom = (id: string, from: string, originConversation: string) => ({
  envelope: {
    id,
    chain: [from],
    from,
    to: "other-bot",
    kind: "request" as const,
    replyTo: null,
    body: "what did you find?",
    artifacts: [],
    at: Date.now(),
  },
  status: "pending" as const,
  retries: 0,
  deliveredAt: null,
  settledAt: null,
  error: null,
  owner: "guest",
  origin: "tool" as const,
  originConversation,
  deadlineAt: Date.now() + 15 * 60_000,
});

describe("work-tree stop", () => {
  it("stops a task, settles its sent mail without waking it, and is idempotent", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const parent = await Effect.runPromise(handle.mind.converse.ensure("parent"));
    const parentCid = String(parent.id);
    const taskChat = await Effect.runPromise(handle.mind.converse.ensure("task:tree-1"));
    const taskCid = String(taskChat.id);
    await Effect.runPromise(
      handle.mind.converse.docs.commit(async (tx) => {
        (await tx.doc(TasksDoc)).tasks = [runningRow("tree-1", parentCid)];
        (await tx.doc(MailboxDoc)).items = [sentFrom("m1", "bot-a", taskCid)];
      }),
    );
    const stopped = await Effect.runPromise(handle.mind.tasks.stopTree("tree-1"));
    expect(stopped).toEqual({ tasks: 1, messages: 1, jobs: 0 });
    const task = await Effect.runPromise(handle.mind.tasks.get("tree-1"));
    expect(task?.status).toBe("cancelled");
    const mail = await entriesOf(handle);
    expect(mail[0]?.status).toBe("cancelled");
    // The sender is never woken: its conversation was just stopped.
    expect(mail[0]?.senderNotified).toBe(true);
    expect(mail[0]?.error).toContain("stopped");
    // A second stop finds nothing left.
    expect(await Effect.runPromise(handle.mind.tasks.stopTree("tree-1"))).toBeUndefined();
    await handle.close();
  });

  it("mail from other conversations, and already-settled mail, is left alone", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const parent = await Effect.runPromise(handle.mind.converse.ensure("parent"));
    const parentCid = String(parent.id);
    const taskChat = await Effect.runPromise(handle.mind.converse.ensure("task:tree-2"));
    const taskCid = String(taskChat.id);
    const elsewhere = { ...sentFrom("m2", "bot-a", parentCid), status: "pending" as const };
    const settled = { ...sentFrom("m3", "bot-a", taskCid), status: "replied" as const };
    await Effect.runPromise(
      handle.mind.converse.docs.commit(async (tx) => {
        (await tx.doc(TasksDoc)).tasks = [runningRow("tree-2", parentCid)];
        (await tx.doc(MailboxDoc)).items = [elsewhere, settled];
      }),
    );
    const stopped = await Effect.runPromise(handle.mind.tasks.stopTree("tree-2"));
    expect(stopped?.messages).toBe(0);
    const mail = await entriesOf(handle);
    expect(mail.find((entry) => entry.envelope.id === "m2")?.status).toBe("pending");
    expect(mail.find((entry) => entry.envelope.id === "m3")?.status).toBe("replied");
    await handle.close();
  });

  it("a chat stop takes its queued tasks first, then the running ones and their trees", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const parent = await Effect.runPromise(handle.mind.converse.ensure("parent"));
    const parentCid = String(parent.id);
    const first = await Effect.runPromise(handle.mind.converse.ensure("task:chat-q"));
    const second = await Effect.runPromise(handle.mind.converse.ensure("task:chat-r"));
    await Effect.runPromise(
      handle.mind.converse.docs.commit(async (tx) => {
        (await tx.doc(TasksDoc)).tasks = [
          runningRow("chat-q", parentCid, "queued"),
          runningRow("chat-r", parentCid),
        ];
        (await tx.doc(MailboxDoc)).items = [
          sentFrom("mq", "bot-a", String(first.id)),
          sentFrom("mr", "bot-a", String(second.id)),
        ];
      }),
    );
    const stopped = await Effect.runPromise(handle.mind.tasks.stopChatWork(parentCid));
    expect(stopped).toEqual({ tasks: 2, messages: 2, jobs: 0 });
    for (const id of ["chat-q", "chat-r"]) {
      const task = await Effect.runPromise(handle.mind.tasks.get(id));
      expect(task?.status).toBe("cancelled");
      expect(task?.notified).toBe(true); // quiet: the owner stopped the chat
    }
    // Again: nothing left to stop.
    expect(await Effect.runPromise(handle.mind.tasks.stopChatWork(parentCid))).toEqual({
      tasks: 0,
      messages: 0,
      jobs: 0,
    });
    await handle.close();
  });
});
