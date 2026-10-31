/**
 * Request helpers the auth gate and routes share: cookie parsing, the
 * loopback test (the client, not just the peer, must be on this machine), the HTTPS test, and a
 * capped JSON body reader for the pre-auth routes.
 */
import type { IncomingMessage } from "node:http";
import { AUTH_BODY_LIMIT, SESSION_COOKIE } from "./config.ts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export const cookieOf = (req: IncomingMessage, name: string): string | undefined => {
  const header = req.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
};

export const serializeCookie = (
  name: string,
  value: string,
  options: { readonly maxAge?: number; readonly clear?: boolean; readonly secure: boolean },
): string => {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  if (options.clear) parts.push("Max-Age=0");
  else if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
};

/** The direct peer address, before any proxy header is considered. */
const peerOf = (req: IncomingMessage): string => req.socket.remoteAddress ?? "";

const headerText = (value: string | string[] | undefined): string | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? value.join(",") : value;

/**
 * True only when the CLIENT is on this machine. A loopback peer is not
 * enough: tailscale serve, the web dev proxy and any reverse proxy connect
 * from 127.0.0.1 on behalf of someone else. So a forwarded request counts
 * only when every hop it names in `x-forwarded-for` is loopback too (the
 * host's own browser through the dev proxy); a proxy that hides the client
 * (`forwarded`, `x-real-ip`, or only `x-forwarded-proto`) never counts.
 */
export const isLoopback = (req: IncomingMessage): boolean => {
  if (!LOOPBACK.has(peerOf(req))) return false;
  if (req.headers.forwarded !== undefined) return false;
  const realIp = headerText(req.headers["x-real-ip"]);
  if (realIp !== undefined && !LOOPBACK.has(realIp.trim())) return false;
  const chain = headerText(req.headers["x-forwarded-for"]);
  if (chain === undefined) return req.headers["x-forwarded-proto"] === undefined;
  const hops = chain.split(",").map((hop) => hop.trim());
  return hops.every((hop) => LOOPBACK.has(hop));
};

/** Served over HTTPS: a TLS socket, or a proxy that says the client used it. */
export const isHttps = (req: IncomingMessage): boolean =>
  (req.socket as { encrypted?: boolean }).encrypted === true ||
  req.headers["x-forwarded-proto"] === "https";

export const readJsonBody = async <T>(req: IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > AUTH_BODY_LIMIT) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return (raw === "" ? {} : JSON.parse(raw)) as T;
};

export const sessionCookieOf = (req: IncomingMessage): string | undefined =>
  cookieOf(req, SESSION_COOKIE);
