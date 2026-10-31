import { describe, expect, it } from "vite-plus/test";
import type { AuditEvent, ProfileInfo, TaskRow } from "@ultiv/contracts";
import type { PendingApprovalRow } from "./api";
import { NEEDS_YOU_LIMIT, needsYouItems } from "./needs-you.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const bot = (id: string, over: Partial<ProfileInfo> = {}): ProfileInfo =>
  ({ id, name: `Bot ${id}`, archivedAt: null, ...over }) as ProfileInfo;

const approval = (over: Partial<PendingApprovalRow> = {}): PendingApprovalRow => ({
  conversationId: "conv-1",
  profile: "a",
  kind: "main",
  sessionId: null,
  callId: "call-1",
  name: "bash",
  input: {},
  reason: null,
  ...over,
});

const task = (over: Partial<TaskRow> = {}): TaskRow =>
  ({
    id: "t1",
    sessionId: "s-task",
    owner: "owner-a",
    conversationId: null,
    prompt: "Summarise the inbox",
    title: "Inbox summary",
    status: "failed",
    result: null,
    error: "The provider timed out",
    createdAt: NOW - 2 * HOUR,
    finishedAt: NOW - HOUR,
    bot: { owner: "owner-a", profileId: "a" },
    ...over,
  }) as TaskRow;

const escalation = (over: Partial<AuditEvent> = {}): AuditEvent =>
  ({
    at: NOW - 3 * HOUR,
    kind: "escalation",
    conversationId: "conv-r",
    profile: "b",
    callId: null,
    name: "Routine stopped",
    durationMs: null,
    ok: false,
    error: "Morning check failed 3 times",
    ...over,
  }) as AuditEvent;

const base = {
  approvals: [] as PendingApprovalRow[],
  tasks: [] as TaskRow[],
  extra: null,
  profiles: [bot("a"), bot("b")],
  dismissed: new Set<string>(),
  now: NOW,
};

describe("needsYouItems", () => {
  it("is empty when nothing waits", () => {
    expect(needsYouItems(base)).toEqual([]);
  });

  it("orders approvals, failed tasks, escalations, then tidy", () => {
    const items = needsYouItems({
      ...base,
      approvals: [approval()],
      tasks: [task()],
      extra: { tidy: [{ profile: "a", open: 2 }], escalations: [escalation()], chats: {} },
    });
    expect(items.map((item) => item.kind)).toEqual([
      "approval",
      "failed-task",
      "escalation",
      "tidy",
    ]);
    expect(items[3]?.title).toBe("2 memory suggestions for Bot a");
  });

  it("sends each kind to the screen that settles it", () => {
    const items = needsYouItems({
      ...base,
      approvals: [approval(), approval({ conversationId: "conv-2", callId: "c2" })],
      tasks: [task()],
      extra: {
        tidy: [{ profile: "a", open: 1 }],
        escalations: [escalation()],
        chats: { "conv-2": "s-chat" },
      },
    });
    const byId = new Map(items.map((item) => [item.id, item.target]));
    expect(byId.get("approval:conv-1:call-1")).toEqual({ kind: "bot-chat", botId: "a" });
    expect(byId.get("approval:conv-2:c2")).toEqual({ kind: "session", sessionId: "s-chat" });
    expect(byId.get("task:t1")).toEqual({ kind: "session", sessionId: "s-task" });
    expect(items.find((i) => i.kind === "escalation")?.target).toEqual({
      kind: "profile",
      botId: "b",
      tab: "routines",
    });
    expect(byId.get("tidy:a")).toEqual({ kind: "profile", botId: "a", tab: "memory" });
  });

  it("finds a task's chat for an approval raised inside the task", () => {
    const [item] = needsYouItems({
      ...base,
      approvals: [approval({ conversationId: "conv-task" })],
      tasks: [task({ status: "running", taskConversationId: "conv-task" })],
    });
    expect(item?.target).toEqual({ kind: "session", sessionId: "s-task" });
  });

  it("drops old failures, old escalations, hidden bots and done tasks", () => {
    const items = needsYouItems({
      ...base,
      profiles: [bot("a"), bot("b", { archivedAt: NOW - HOUR })],
      approvals: [approval({ profile: "b" })],
      tasks: [task({ finishedAt: NOW - 25 * HOUR }), task({ id: "t2", status: "done" })],
      extra: {
        tidy: [{ profile: "b", open: 3 }],
        escalations: [escalation({ profile: "a", at: NOW - 8 * 24 * HOUR })],
        chats: {},
      },
    });
    expect(items).toEqual([]);
  });

  it("hides dismissed failures but never dismisses approvals", () => {
    const items = needsYouItems({
      ...base,
      approvals: [approval()],
      tasks: [task()],
      dismissed: new Set(["task:t1", "approval:conv-1:call-1"]),
    });
    expect(items.map((item) => item.id)).toEqual(["approval:conv-1:call-1"]);
  });

  it("stays a short list", () => {
    const approvals = Array.from({ length: 30 }, (_, i) => approval({ callId: `c${i}` }));
    expect(needsYouItems({ ...base, approvals })).toHaveLength(NEEDS_YOU_LIMIT);
  });
});
