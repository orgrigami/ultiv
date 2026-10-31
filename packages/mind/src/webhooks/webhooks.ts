/**
 * The webhooks faculty: inbound triggers the entity can create for ITSELF.
 * The registry lives in a durable doc (kind "ultiv.webhooks", moved here from
 * the server — same kind); the server keeps only the HTTP ingress and the
 * delivery pump. Bearer tokens are shown at creation and readable by the
 * OWNER, never the entity — key invisibility is the capability boundary, and
 * it is compensated by REJECT ACCOUNTING (per-class counters + retained
 * rejected payloads), so a rotated partner key is a visible outage, never
 * silence. Optional per-webhook JSON Schemas are authored at creation: the
 * ingress validates every payload against the schema BEFORE acking, so a
 * schema rejection is the author's bug to diagnose from the retained bodies.
 */
import { randomUUID } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { Value } from "typebox/value";
import type { WebhookInfo, WebhookList, WebhookReject } from "@spreissen/contracts";
import type { ConverseService } from "../converse/converse.ts";

/** Payload cap enforced before the ack — oversize is a 413, never a silent drop. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
/** Default token-bucket capacity + refill per minute, per webhook. */
export const WEBHOOK_RATE_PER_MIN = Number(process.env.WEBHOOK_RATE_PER_MIN ?? 30);
/** Retained rejected payloads per webhook (bodies truncated). */
const REJECT_RETENTION = 5;
const REJECT_BODY_TRUNCATE = 2048;

export const WebhooksDoc = defineDoc<{ items: WebhookInfo[] }>({
  kind: "ultiv.webhooks",
  version: 3,
  scope: "session",
  initial: () => ({ items: [] }),
  // v2 rows predate profile scoping, schemas and the reject counters.
  migrate: (value) => {
    const stored = (value.items ?? []) as unknown as ReadonlyArray<Record<string, unknown>>;
    const items = stored.map((row) => ({
      ...row,
      profile: typeof row.profile === "string" ? row.profile : "default",
      name: typeof row.name === "string" ? row.name : null,
      schema:
        row.schema !== undefined && row.schema !== null && typeof row.schema === "object"
          ? (row.schema as Record<string, unknown>)
          : null,
      accepted: typeof row.accepted === "number" ? row.accepted : ((row.calls as number) ?? 0),
      rejectedAuth: typeof row.rejectedAuth === "number" ? row.rejectedAuth : 0,
      rejectedSchema: typeof row.rejectedSchema === "number" ? row.rejectedSchema : 0,
      rejectedRate: typeof row.rejectedRate === "number" ? row.rejectedRate : 0,
      rejectedSize: typeof row.rejectedSize === "number" ? row.rejectedSize : 0,
      fireCount: typeof row.fireCount === "number" ? row.fireCount : 0,
      lastFiredAt: typeof row.lastFiredAt === "number" ? row.lastFiredAt : null,
      lastRejectAt: typeof row.lastRejectAt === "number" ? row.lastRejectAt : null,
      lastRejectReason: typeof row.lastRejectReason === "string" ? row.lastRejectReason : null,
      recentRejects: Array.isArray(row.recentRejects) ? row.recentRejects : [],
    }));
    return { items } as unknown as { items: WebhookInfo[] };
  },
  checkpointWhen: () => true,
});

export const listWebhooks = async (converse: ConverseService): Promise<WebhookList> =>
  ((await Effect.runPromise(converse.docs.snapshot(WebhooksDoc)))?.items ?? []).map((webhook) => ({
    ...webhook,
    profile: webhook.profile ?? "default",
    whenBusy: webhook.whenBusy ?? "steer",
  }));

/** Read one webhook without pulling the whole list through the caller's hands. */
export const findWebhook = async (
  converse: ConverseService,
  id: string,
): Promise<WebhookInfo | undefined> => (await listWebhooks(converse)).find((w) => w.id === id);

const writeWebhooks = (converse: ConverseService, items: WebhookInfo[]) =>
  converse.docs.commit(async (tx) => {
    const draft = await tx.doc(WebhooksDoc);
    draft.items = items;
  });

/** Functional update of one webhook row (counters, receipts bookkeeping). */
export const updateWebhook = async (
  converse: ConverseService,
  id: string,
  update: (webhook: WebhookInfo) => WebhookInfo,
): Promise<WebhookInfo | undefined> => {
  let updated: WebhookInfo | undefined;
  await Effect.runPromise(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(WebhooksDoc);
      draft.items = draft.items.map((webhook) => {
        if (webhook.id !== id) return webhook;
        updated = update({ ...webhook, profile: webhook.profile ?? "default" });
        return updated;
      });
    }),
  );
  return updated;
};

/**
 * Validate that a caller-supplied JSON Schema is USABLE (a well-formed
 * object TypeBox's validator accepts). Refused at creation, so a broken
 * schema never reaches the ingress.
 */
export const validateWebhookSchema = (schema: unknown): { ok: boolean; reason?: string } => {
  if (schema === null) return { ok: true };
  if (typeof schema !== "object" || Array.isArray(schema))
    return { ok: false, reason: "schema must be a JSON object (or null to accept any payload)" };
  try {
    // A schema no value can ever satisfy (or that TypeBox cannot compile)
    // surfaces here; {} is the smallest probe.
    Value.Check(schema as never, {});
    return { ok: true };
  } catch (cause) {
    return {
      ok: false,
      reason: `schema is not a usable JSON Schema: ${String(cause).slice(0, 200)}`,
    };
  }
};

/** Validate a parsed payload against a webhook's schema; the ingress pre-ack gate. */
export const checkWebhookPayload = (
  schema: Record<string, unknown> | null,
  payload: unknown,
): { ok: true } | { ok: false; detail: string } => {
  if (schema === null) return { ok: true };
  try {
    if (Value.Check(schema as never, payload)) return { ok: true };
    const first = Value.Errors(schema as never, payload)
      [Symbol.iterator]?.()
      .next();
    const detail =
      first !== undefined && !first.done && first.value !== undefined
        ? JSON.stringify(first.value).slice(0, 300)
        : "payload does not match the webhook schema";
    return { ok: false, detail };
  } catch (cause) {
    return { ok: false, detail: `schema validation failed: ${String(cause).slice(0, 200)}` };
  }
};

/**
 * The token bucket behind 429s. In-memory on purpose: it bounds request
 * BURSTS; restarts reset it, which is acceptable for burst control (the
 * durable record of what got through is the receipt log).
 */
const buckets = new Map<string, { tokens: number; last: number }>();

export const checkWebhookRate = (id: string): { ok: true } | { ok: false; retryAfterS: number } => {
  const now = Date.now();
  const bucket = buckets.get(id) ?? { tokens: WEBHOOK_RATE_PER_MIN, last: now };
  const refill = ((now - bucket.last) / 60_000) * WEBHOOK_RATE_PER_MIN;
  bucket.tokens = Math.min(WEBHOOK_RATE_PER_MIN, bucket.tokens + refill);
  bucket.last = now;
  if (bucket.tokens < 1) {
    buckets.set(id, bucket);
    return {
      ok: false,
      retryAfterS: Math.max(
        1,
        Math.ceil(((1 - bucket.tokens) * 60_000) / WEBHOOK_RATE_PER_MIN / 1000),
      ),
    };
  }
  bucket.tokens -= 1;
  buckets.set(id, bucket);
  return { ok: true };
};

const retainReject = (webhook: WebhookInfo, reject: WebhookReject): WebhookInfo => ({
  ...webhook,
  recentRejects: [reject, ...webhook.recentRejects].slice(0, REJECT_RETENTION),
  lastRejectAt: reject.at,
  lastRejectReason: reject.reason,
});

export type WebhookRejectClass = "auth" | "schema" | "rate" | "size";

/** Account one rejection: bump its class counter and retain the payload. */
export const recordWebhookReject = async (
  converse: ConverseService,
  id: string,
  reject: { reason: WebhookRejectClass; detail: string; body?: string },
): Promise<void> => {
  await updateWebhook(converse, id, (webhook) => {
    const retained = retainReject(webhook, {
      at: Date.now(),
      reason: reject.reason,
      detail: reject.detail.slice(0, 300),
      body: (reject.body ?? "").slice(0, REJECT_BODY_TRUNCATE),
    });
    switch (reject.reason) {
      case "auth":
        return { ...retained, rejectedAuth: retained.rejectedAuth + 1 };
      case "schema":
        return { ...retained, rejectedSchema: retained.rejectedSchema + 1 };
      case "rate":
        return { ...retained, rejectedRate: retained.rejectedRate + 1 };
      case "size":
        return { ...retained, rejectedSize: retained.rejectedSize + 1 };
    }
  });
};

export interface WebhookCreate {
  readonly sessionId: string;
  readonly name?: string | null;
  /** JSON Schema every payload must satisfy (TypeBox-compatible); null/omitted accepts any. */
  readonly schema?: Record<string, unknown> | null;
  /** Mid-turn policy for its wakes (default steer). */
  readonly whenBusy?: "steer" | "followUp" | "reject";
}

export const createWebhook = async (
  converse: ConverseService,
  profiles: { rowOf: (sessionId: string) => Promise<{ profile: string } | undefined> },
  input: WebhookCreate,
): Promise<WebhookInfo> => {
  const schemaCheck = validateWebhookSchema(input.schema ?? null);
  if (!schemaCheck.ok) throw new Error(schemaCheck.reason ?? "invalid schema");
  const row = await profiles.rowOf(input.sessionId);
  const webhook: WebhookInfo = {
    id: randomUUID(),
    token: randomUUID(),
    sessionId: input.sessionId,
    profile: row?.profile ?? "default",
    name: input.name ?? null,
    schema: (input.schema ?? null) as WebhookInfo["schema"],
    createdAt: Date.now(),
    accepted: 0,
    rejectedAuth: 0,
    rejectedSchema: 0,
    rejectedRate: 0,
    rejectedSize: 0,
    fireCount: 0,
    lastFiredAt: null,
    lastRejectAt: null,
    lastRejectReason: null,
    recentRejects: [],
    ...(input.whenBusy !== undefined ? { whenBusy: input.whenBusy } : {}),
  };
  await Effect.runPromise(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(WebhooksDoc);
      draft.items = [...draft.items, webhook];
    }),
  );
  return webhook;
};

export const removeWebhook = async (converse: ConverseService, id: string): Promise<boolean> => {
  const before = await listWebhooks(converse);
  const remaining = before.filter((webhook) => webhook.id !== id);
  if (remaining.length === before.length) return false;
  await Effect.runPromise(writeWebhooks(converse, remaining));
  return true;
};

/** Remove every webhook bound to one of the given sessions (profile purge cascade). */
export const removeWebhooksForSessions = async (
  converse: ConverseService,
  sessionIds: readonly string[],
): Promise<number> => {
  const bound = new Set(sessionIds);
  const before = await listWebhooks(converse);
  const remaining = before.filter((webhook) => !bound.has(webhook.sessionId));
  if (remaining.length !== before.length)
    await Effect.runPromise(writeWebhooks(converse, remaining));
  return before.length - remaining.length;
};

export interface WebhooksService {
  readonly list: () => Promise<WebhookList>;
  readonly find: (id: string) => Promise<WebhookInfo | undefined>;
  readonly create: (input: WebhookCreate) => Promise<WebhookInfo>;
  readonly remove: (id: string) => Promise<boolean>;
  readonly removeForSessions: (sessionIds: readonly string[]) => Promise<number>;
  /** Bump one rejection class and retain the payload (the rotation alarm). */
  readonly recordReject: (
    id: string,
    reject: { reason: WebhookRejectClass; detail: string; body?: string },
  ) => Promise<void>;
  /** Functional counter/update hook for the server's ingress pump. */
  readonly update: (
    id: string,
    update: (webhook: WebhookInfo) => WebhookInfo,
  ) => Promise<WebhookInfo | undefined>;
}

export const webhooksService = (deps: {
  readonly converse: ConverseService;
  readonly profiles: { rowOf: (sessionId: string) => Promise<{ profile: string } | undefined> };
}): WebhooksService => ({
  list: () => listWebhooks(deps.converse),
  find: (id) => findWebhook(deps.converse, id),
  create: (input) => createWebhook(deps.converse, deps.profiles, input),
  remove: (id) => removeWebhook(deps.converse, id),
  removeForSessions: (sessionIds) => removeWebhooksForSessions(deps.converse, sessionIds),
  recordReject: (id, reject) => recordWebhookReject(deps.converse, id, reject),
  update: (id, update) => updateWebhook(deps.converse, id, update),
});
