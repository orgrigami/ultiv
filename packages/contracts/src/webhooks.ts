import {
  arr,
  bool,
  map,
  nul,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
  unknown,
  type Static,
} from "@earendil-works/pi-schema";
import { RoutineTrialSchema } from "./routine-trial.ts";

/** One retained rejected payload (bounded, bodies truncated) for diagnosis. */
export const WebhookRejectSchema = obj(
  {
    at: num(),
    /** Rejection class: auth | schema | rate | size. */
    reason: str(),
    /** Why the payload was refused (schema error detail, etc.). */
    detail: str(),
    /** The first bytes of the rejected body — enough to diagnose, not enough to hurt. */
    body: str(),
  },
  { open: true },
);

export type WebhookReject = Static<typeof WebhookRejectSchema>;

/** Who may start work through a webhook: the sender's place in the payload and the allowed ones. */
export const WebhookSendersSchema = obj(
  {
    /** Dotted path to the sender in the payload, e.g. "sender.login". */
    path: str(),
    /** Allowed senders, compared exactly (case-insensitive). */
    allow: arr(str()),
  },
  { open: true },
);

export type WebhookSenders = Static<typeof WebhookSendersSchema>;

/** One outside thread and the chat its payloads continue. */
export const WebhookThreadSchema = obj(
  {
    key: str(),
    sessionId: str(),
    /** When the thread last received a payload. */
    at: num(),
  },
  { open: true },
);

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
export const WebhookInfoSchema = obj(
  {
    id: str(),
    /** Bearer secret the caller must present: only in the create / rotate-token response. */
    token: opt(str()),
    sessionId: str(),
    /** The profile the bound session lives under. */
    profile: str(),
    /** Optional label the creator gave this webhook. */
    name: union([str(), nul()]),
    /**
     * Optional JSON Schema (TypeBox-compatible) the ingress validates every
     * payload against BEFORE acking; null accepts any payload. Authored at
     * creation — schema rejections are the author's bug, not the sender's.
     */
    schema: union([map(unknown()), nul()]),
    createdAt: num(),
    /** Payloads that passed ingress and were queued for delivery. */
    accepted: num(),
    rejectedAuth: num(),
    rejectedSchema: num(),
    rejectedRate: num(),
    rejectedSize: num(),
    /** Fire receipts: payloads ever accepted (successful ingress). */
    fireCount: num(),
    lastFiredAt: union([num(), nul()]),
    lastRejectAt: union([num(), nul()]),
    /** Rejection class of the most recent reject ("auth" | "schema" | "rate" | "size"). */
    lastRejectReason: union([str(), nul()]),
    /** The last few rejected payloads, newest first — the schema-drift diagnosis path. */
    recentRejects: arr(WebhookRejectSchema),
    /** When the bot is mid-turn: steer the turn at the next boundary, or queue as follow-up. */
    whenBusy: opt(oneOf(["steer", "followUp", "reject"])),
    /**
     * One chat per outside thread: where the thread's id sits in the payload,
     * as a dotted path ("issue.number", "event.thread_ts"). Payloads with the
     * same id continue the same chat; a payload without one goes to the
     * webhook's own chat. Absent or null: every payload goes there.
     */
    threadKey: opt(union([str(), nul()])),
    /** Where a thread's title sits (dotted path); it names the thread's chat. */
    threadTitle: opt(union([str(), nul()])),
    /**
     * Who may start work: where the sender sits in the payload (dotted path)
     * and the senders allowed. Anyone else's payload only adds context to a
     * thread that already has a chat, and is ignored otherwise. Absent or
     * null: anyone holding the token.
     */
    senders: opt(union([WebhookSendersSchema, nul()])),
    /** Each outside thread's chat, oldest first (at most MAX_WEBHOOK_THREADS). */
    threads: opt(arr(WebhookThreadSchema)),
    /** Trial mode (routine-trial.ts): each allowed payload runs as a trial until turned live. */
    trial: opt(bool()),
    /** The latest trials, oldest first (at most TRIALS_KEPT). */
    trials: opt(arr(RoutineTrialSchema)),
  },
  { open: true },
);

export type WebhookInfo = Omit<Static<typeof WebhookInfoSchema>, "schema"> & {
  schema: JsonSchemaObject | null;
};

export const WebhookListSchema = arr(WebhookInfoSchema);

export type WebhookList = WebhookInfo[];
