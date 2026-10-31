/**
 * Identity: the principal seam. Every request authenticates through the
 * sign-in session (auth/guard.ts) and carries THE owner account; chord links
 * carry the same principal. The registry, conversations, tasks, memory and
 * vault scope themselves under its owner label. There is one account, so the
 * label is a constant; phase 3 attaches roles to it.
 */
import { AGENT_OWNER } from "@spriessen/mind";

export type Principal = { kind: "guest" } | { kind: "user"; id: string } | { kind: "server" };

/**
 * The single owner account: every signed-in principal is this label, and the
 * migration moves every pre-sign-in row (guest, or whatever an older client
 * sent) under it.
 */
export const OWNER_ID = "owner";

/** The durable conversation key for an app session id, scoped to its owner. */
export const sessionKey = (owner: string, id: string): string => `${owner}:${id}`;

/**
 * Owner labels the seam never hands out: `agent` is the sentinel bot-spawned
 * task rows are filed under (see @spriessen/mind's AGENT_OWNER), so a caller
 * NAMING itself that would pass every "own rows" check on those rows —
 * including the pending approval inputs task rows carry. The signed-in
 * account is never a reserved label.
 */
const RESERVED_OWNERS: readonly string[] = [AGENT_OWNER];

/** The principal of a signed-in session (and of the loopback bootstrap). */
export const principalOfAccount = (): Principal => ({ kind: "user", id: OWNER_ID });

/**
 * Resolve a principal from a caller-claimed label, refusing reserved ones.
 * Kept for the one internal path that receives a label from a stored row
 * (never from a request).
 */
export const principalForLabel = (id: string): Principal =>
  id === "" || RESERVED_OWNERS.includes(id) ? { kind: "guest" } : { kind: "user", id };

/** The registry label a principal's data lives under. */
export const ownerOf = (principal: Principal): string =>
  principal.kind === "user" ? principal.id : "guest";
