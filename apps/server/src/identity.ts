/**
 * Identity: the principal seam. Chord stamps every link (and every REST
 * request, via the header) with a principal; the registry, conversations and
 * tasks scope themselves under its owner label. There is no IdP yet —
 * `x-spreissen-user` IS the identity — but every key and registry row is
 * owner-partitioned HERE, in one file, so a real authenticator later only
 * replaces `principalFromHeaders` and the WebSocket callback.
 */
import { AGENT_OWNER } from "@spreissen/mind";

export type Principal = { kind: "guest" } | { kind: "user"; id: string } | { kind: "server" };

export const USER_HEADER = "x-spreissen-user";
/** The pre-rename header, still accepted when the new one is absent. */
export const LEGACY_USER_HEADER = "x-ultiv-user";

/**
 * The registry label a principal's data lives under.
 */
export const ownerOf = (principal: Principal): string =>
  principal.kind === "user" ? principal.id : "guest";

/** The durable conversation key for an app session id, scoped to its owner. */
export const sessionKey = (owner: string, id: string): string => `${owner}:${id}`;

/**
 * Owner labels the seam never hands out: `agent` is the sentinel bot-spawned
 * task rows are filed under (see @spreissen/mind's AGENT_OWNER), so a caller
 * NAMING itself that would pass every "own rows" check on those rows —
 * including the pending approval inputs task rows carry. A principal that
 * claims a reserved label resolves to guest.
 */
const RESERVED_OWNERS: readonly string[] = [AGENT_OWNER];

const principalFor = (id: string): Principal =>
  id === "" || RESERVED_OWNERS.includes(id) ? { kind: "guest" } : { kind: "user", id };

/** Resolve a principal from header-style access; empty/missing means guest. */
export const principalFromHeaders = (get: (name: string) => string | undefined): Principal =>
  principalFor((get(USER_HEADER) ?? get(LEGACY_USER_HEADER) ?? "").trim());

/** The principal of an incoming HTTP request (REST and WebSocket upgrades alike). */
export const principalFromRequest = (request: { readonly headers: unknown }): Principal => {
  const headers = request.headers as { get?: (name: string) => unknown } | Record<string, unknown>;
  const read = (name: string): unknown =>
    typeof (headers as { get?: unknown }).get === "function"
      ? (headers as { get: (name: string) => unknown }).get(name)
      : (headers as Record<string, unknown>)[name];
  const raw = read(USER_HEADER) ?? read(LEGACY_USER_HEADER);
  return principalFor(typeof raw === "string" ? raw.trim() : "");
};
