import { Type, type Static } from "typebox";
import { RoutineTrialSchema } from "./routine-trial.ts";

/** One retained rejected payload (bounded, bodies truncated) for diagnosis. */
export const WebhookRejectSchema = Type.Object({
  at: Type.Number(),
  /** Rejection class: auth | schema | rate | size. */
  reason: Type.String(),
  /** Why the payload was refused (schema error detail, etc.). */
  detail: Type.String(),
  /** The first bytes of the rejected body — enough to diagnose, not enough to hurt. */
  body: Type.String(),
});

export type WebhookReject = Static<typeof WebhookRejectSchema>;

/** Who may start work through a webhook: the sender's place in the payload and the allowed ones. */
export const WebhookSendersSchema = Type.Object({
  /** Dotted path to the sender in the payload, e.g. "sender.login". */
  path: Type.String(),
  /** Allowed senders, compared exactly (case-insensitive). */
  allow: Type.Array(Type.String()),
});

export type WebhookSenders = Static<typeof WebhookSendersSchema>;

/** One outside thread and the chat its payloads continue. */
export const WebhookThreadSchema = Type.Object({
  key: Type.String(),
  sessionId: Type.String(),
  /** When the thread last received a payload. */
  at: Type.Number(),
});

export type WebhookThread = Static<typeof WebhookThreadSchema>;

/** Threads a webhook remembers; the least recently active is forgotten first. */
export const MAX_WEBHOOK_THREADS = 200;

/**
 * A JSON-safe value: the recursive shape a JSON Schema document actually
 * has (objects, arrays, primitives — nothing host-language-typed), so a
 * webhook's schema is storable in a durable doc.
 */
export type JsonSchemaValue =
  | string
  | number
  | boolean
  | null
  | JsonSchemaValue[]
  | { [key: string]: JsonSchemaValue };

export type JsonSchemaObject = { [key: string]: JsonSchemaValue };

/**
 * One inbound webhook: a URL the outside world can POST to reach a session.
 * The bearer token is returned to the OWNER once, in the create (or
 * rotate-token) response, and only its hash is stored, so lists never carry
 * it. The entity never sees it — key invisibility is the capability
 * boundary, and the reject counters below are what make rotation debuggable.
 */
export const WebhookInfoSchema = Type.Object({
  id: Type.String(),
  /** Bearer secret the caller must present: only in the create / rotate-token response. */
  token: Type.Optional(Type.String()),
  sessionId: Type.String(),
  /** The profile the bound session lives under. */
  profile: Type.String(),
  /** Optional label the creator gave this webhook. */
  name: Type.Union([Type.String(), Type.Null()]),
  /**
   * Optional JSON Schema (TypeBox-compatible) the ingress validates every
   * payload against BEFORE acking; null accepts any payload. Authored at
   * creation — schema rejections are the author's bug, not the sender's.
   */
  schema: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  createdAt: Type.Number(),
  /** Payloads that passed ingress and were queued for delivery. */
  accepted: Type.Number(),
  rejectedAuth: Type.Number(),
  rejectedSchema: Type.Number(),
  rejectedRate: Type.Number(),
  rejectedSize: Type.Number(),
  /** Fire receipts: payloads ever accepted (successful ingress). */
  fireCount: Type.Number(),
  lastFiredAt: Type.Union([Type.Number(), Type.Null()]),
  lastRejectAt: Type.Union([Type.Number(), Type.Null()]),
  /** Rejection class of the most recent reject ("auth" | "schema" | "rate" | "size"). */
  lastRejectReason: Type.Union([Type.String(), Type.Null()]),
  /** The last few rejected payloads, newest first — the schema-drift diagnosis path. */
  recentRejects: Type.Array(WebhookRejectSchema),
  /** When the bot is mid-turn: steer the turn at the next boundary, or queue as follow-up. */
  whenBusy: Type.Optional(
    Type.Union([Type.Literal("steer"), Type.Literal("followUp"), Type.Literal("reject")]),
  ),
  /**
   * One chat per outside thread: where the thread's id sits in the payload,
   * as a dotted path ("issue.number", "event.thread_ts"). Payloads with the
   * same id continue the same chat; a payload without one goes to the
   * webhook's own chat. Absent or null: every payload goes there.
   */
  threadKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** Where a thread's title sits (dotted path); it names the thread's chat. */
  threadTitle: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /**
   * Who may start work: where the sender sits in the payload (dotted path)
   * and the senders allowed. Anyone else's payload only adds context to a
   * thread that already has a chat, and is ignored otherwise. Absent or
   * null: anyone holding the token.
   */
  senders: Type.Optional(Type.Union([WebhookSendersSchema, Type.Null()])),
  /** Each outside thread's chat, oldest first (at most MAX_WEBHOOK_THREADS). */
  threads: Type.Optional(Type.Array(WebhookThreadSchema)),
  /** Trial mode (routine-trial.ts): each allowed payload runs as a trial until turned live. */
  trial: Type.Optional(Type.Boolean()),
  /** The latest trials, oldest first (at most TRIALS_KEPT). */
  trials: Type.Optional(Type.Array(RoutineTrialSchema)),
});

export type WebhookInfo = Omit<Static<typeof WebhookInfoSchema>, "schema"> & {
  schema: JsonSchemaObject | null;
};

export const WebhookListSchema = Type.Array(WebhookInfoSchema);

export type WebhookList = WebhookInfo[];
