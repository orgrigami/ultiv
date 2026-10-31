/**
 * The webhooks faculty: inbound triggers the entity can create for ITSELF.
 * The registry lives in a durable doc (kind "ultiv.webhooks", moved here from
 * the server — same kind); the server keeps only the HTTP ingress and the
 * delivery pump. Bearer tokens are shown to the OWNER once, at creation or
 * rotation, and only their SHA-256 is stored (`tokenHash`); the ingress
 * compares hashes in constant time. The entity never sees a token — key
 * invisibility is the capability boundary, and
 * it is compensated by REJECT ACCOUNTING (per-class counters + retained
 * rejected payloads), so a rotated partner key is a visible outage, never
 * silence. Optional per-webhook JSON Schemas are authored at creation: the
 * ingress validates every payload against the schema BEFORE acking, so a
 * schema rejection is the author's bug to diagnose from the retained bodies.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
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

/**
 * The stored row: the public info plus the token's hash. Rows written before
 * hashing carry the plaintext `token` until `sealWebhookTokens` replaces it.
 */
export type StoredWebhook = WebhookInfo & { tokenHash?: string; token?: string };

/** `sha256:<hex>` of a bearer token — the only form a token is stored in. */
export const hashWebhookToken = (token: string): string =>
  `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;

/** Constant-time compare of two token hashes (equal-length hex by construction). */
const hashesMatch = (stored: string, presented: string): boolean => {
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The public view of a row: no token, no hash. */
const publicOf = (row: StoredWebhook): WebhookInfo => {
  const { token: _token, tokenHash: _hash, ...info } = row;
  return { ...info, profile: info.profile ?? "default", whenBusy: info.whenBusy ?? "steer" };
};

export const WebhooksDoc = defineDoc<{ items: StoredWebhook[] }>({
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
    return { items } as unknown as { items: StoredWebhook[] };
  },
  checkpointWhen: () => true,
});

const readStored = async (converse: ConverseService): Promise<StoredWebhook[]> =>
  (await Effect.runPromise(converse.docs.snapshot(WebhooksDoc)))?.items ?? [];

/** Every webhook, public view (never a token or its hash). */
export const listWebhooks = async (converse: ConverseService): Promise<WebhookList> =>
  (await readStored(converse)).map(publicOf);

/**
 * Does `presented` open webhook `id`? Hashes are compared in constant time; a
 * not-yet-sealed legacy row is checked by hashing its plaintext the same way.
 * Unknown ids are false. Nothing here logs either token.
 */
export const verifyWebhookToken = async (
  converse: ConverseService,
  id: string,
  presented: string,
): Promise<boolean> => {
  const row = (await readStored(converse)).find((webhook) => webhook.id === id);
  if (row === undefined) return false;
  const stored =
    row.tokenHash ?? (typeof row.token === "string" ? hashWebhookToken(row.token) : undefined);
  return stored !== undefined && hashesMatch(stored, hashWebhookToken(presented));
};

/**
 * One-time startup migration: replace every stored plaintext token with its
 * hash, so existing webhook URLs keep working while the token is no longer
 * on disk. Commits only when a plaintext token is still present, so running
 * it again is a no-op. Returns how many rows it sealed.
 */
export const sealWebhookTokens = async (converse: ConverseService): Promise<number> => {
  const pending = (await readStored(converse)).filter((row) => typeof row.token === "string");
  if (pending.length === 0) return 0;
  await Effect.runPromise(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(WebhooksDoc);
      draft.items = draft.items.map((row) => {
        if (typeof row.token !== "string") return row;
        const { token, ...rest } = row;
        return { ...rest, tokenHash: row.tokenHash ?? hashWebhookToken(token) };
      });
    }),
  );
  return pending.length;
};

/** Read one webhook without pulling the whole list through the caller's hands. */
export const findWebhook = async (
  converse: ConverseService,
  id: string,
): Promise<WebhookInfo | undefined> => (await listWebhooks(converse)).find((w) => w.id === id);

/** Keep only the rows `keep` accepts (stored form, so hashes survive). */
const keepWebhooks = (converse: ConverseService, keep: (row: StoredWebhook) => boolean) =>
  converse.docs.commit(async (tx) => {
    const draft = await tx.doc(WebhooksDoc);
    draft.items = draft.items.filter(keep);
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
      draft.items = draft.items.map((row) => {
        if (row.id !== id) return row;
        // The update sees and returns the public view; the stored secret
        // fields ride along untouched.
        const next = update(publicOf(row));
        updated = next;
        return {
          ...next,
          ...(row.tokenHash !== undefined ? { tokenHash: row.tokenHash } : {}),
          ...(row.token !== undefined ? { token: row.token } : {}),
        };
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

/** A webhook as handed back at creation or rotation: the only time its token exists. */
export type WebhookWithToken = WebhookInfo & { token: string };

export const createWebhook = async (
  converse: ConverseService,
  profiles: { rowOf: (sessionId: string) => Promise<{ profile: string } | undefined> },
  input: WebhookCreate,
): Promise<WebhookWithToken> => {
  const schemaCheck = validateWebhookSchema(input.schema ?? null);
  if (!schemaCheck.ok) throw new Error(schemaCheck.reason ?? "invalid schema");
  const row = await profiles.rowOf(input.sessionId);
  const webhook: WebhookInfo = {
    id: randomUUID(),
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
  const token = randomUUID();
  await Effect.runPromise(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(WebhooksDoc);
      draft.items = [...draft.items, { ...webhook, tokenHash: hashWebhookToken(token) }];
    }),
  );
  return { ...webhook, token };
};

/**
 * Issue a new token for a webhook (the old one stops working at once) and
 * hand it back once. Undefined for an unknown id.
 */
export const rotateWebhookToken = async (
  converse: ConverseService,
  id: string,
): Promise<WebhookWithToken | undefined> => {
  const token = randomUUID();
  let info: WebhookInfo | undefined;
  await Effect.runPromise(
    converse.docs.commit(async (tx) => {
      const draft = await tx.doc(WebhooksDoc);
      draft.items = draft.items.map((row) => {
        if (row.id !== id) return row;
        const { token: _legacy, ...rest } = row;
        // A plain copy: the draft's nested values die with the transaction.
        info = JSON.parse(JSON.stringify(publicOf(row))) as WebhookInfo;
        return { ...rest, tokenHash: hashWebhookToken(token) };
      });
    }),
  );
  return info !== undefined ? { ...info, token } : undefined;
};

export const removeWebhook = async (converse: ConverseService, id: string): Promise<boolean> => {
  const before = await listWebhooks(converse);
  if (!before.some((webhook) => webhook.id === id)) return false;
  await Effect.runPromise(keepWebhooks(converse, (row) => row.id !== id));
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
    await Effect.runPromise(keepWebhooks(converse, (row) => !bound.has(row.sessionId)));
  return before.length - remaining.length;
};

export interface WebhooksService {
  readonly list: () => Promise<WebhookList>;
  readonly find: (id: string) => Promise<WebhookInfo | undefined>;
  /** The returned token is the only copy; only its hash is stored. */
  readonly create: (input: WebhookCreate) => Promise<WebhookWithToken>;
  /** New token, returned once; the old one stops working. */
  readonly rotateToken: (id: string) => Promise<WebhookWithToken | undefined>;
  /** Constant-time check of a presented token. */
  readonly verifyToken: (id: string, presented: string) => Promise<boolean>;
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
  rotateToken: (id) => rotateWebhookToken(deps.converse, id),
  verifyToken: (id, presented) => verifyWebhookToken(deps.converse, id, presented),
  remove: (id) => removeWebhook(deps.converse, id),
  removeForSessions: (sessionIds) => removeWebhooksForSessions(deps.converse, sessionIds),
  recordReject: (id, reject) => recordWebhookReject(deps.converse, id, reject),
  update: (id, update) => updateWebhook(deps.converse, id, update),
});
