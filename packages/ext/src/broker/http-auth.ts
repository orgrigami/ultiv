/**
 * HTTP auth placement and binding matching: where a secret goes on a request
 * (bearer, basic, custom header, query parameter, JSON body field) and which
 * URLs a binding covers (hostnames, `*.` wildcards, `host:port`, https URL
 * prefixes on a path boundary).
 */
import type { CredentialBinding } from "@spreissen/contracts";
import type { SecretMaterial } from "./redact.ts";

/** One outgoing hop before auth: what the adapter will send. */
export interface HopRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** Headers a caller may never set: auth, cookies, framing and routing. */
const RESERVED = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/** Lower-cased caller headers minus the reserved ones (and the binding's own header). */
export const callerHeaders = (
  headers: Readonly<Record<string, string>> | undefined,
  bindingHeader: string | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.toLowerCase();
    if (RESERVED.has(key) || key === bindingHeader?.toLowerCase()) continue;
    out[key] = value;
  }
  return out;
};

const basicPair = (material: SecretMaterial): string =>
  material.username !== null ? `${material.username}:${material.secret}` : material.secret;

/** The hop with the secret placed per the binding. Throws for an impossible placement. */
export const withAuth = (
  hop: HopRequest,
  auth: CredentialBinding["auth"],
  material: SecretMaterial,
): HopRequest => {
  const headers = { ...hop.headers };
  switch (auth.placement) {
    case "bearer":
      headers.authorization = `Bearer ${material.secret}`;
      return { ...hop, headers };
    case "basic":
      headers.authorization = `Basic ${Buffer.from(basicPair(material)).toString("base64")}`;
      return { ...hop, headers };
    case "header":
      headers[(auth.name ?? "x-api-key").toLowerCase()] = `${auth.prefix ?? ""}${material.secret}`;
      return { ...hop, headers };
    case "query": {
      const url = new URL(hop.url);
      url.searchParams.set(auth.name ?? "api_key", material.secret);
      return { ...hop, url };
    }
    case "body": {
      const parsed: unknown = hop.body === undefined || hop.body === "" ? {} : JSON.parse(hop.body);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("body placement needs a JSON object body");
      }
      const body = JSON.stringify({ ...parsed, [auth.name ?? "api_key"]: material.secret });
      headers["content-type"] = "application/json";
      return { ...hop, headers, body };
    }
  }
};

const defaultPort = (url: URL): string => url.port || (url.protocol === "https:" ? "443" : "80");

/** Does one binding entry cover this URL? */
export const entryMatches = (entry: string, url: URL): boolean => {
  const pattern = entry.trim().toLowerCase();
  if (/^https?:\/\//.test(pattern)) {
    const prefix = new URL(pattern);
    if (prefix.origin !== url.origin) return false;
    const base = prefix.pathname.endsWith("/") ? prefix.pathname : `${prefix.pathname}/`;
    return url.pathname === prefix.pathname || url.pathname.startsWith(base);
  }
  const [host = "", port] = pattern.split(/:(?=\d+$)/);
  if (port !== undefined ? port !== defaultPort(url) : url.port !== "") return false;
  const target = url.hostname.toLowerCase();
  return host.startsWith("*.") ? target.endsWith(host.slice(1)) : target === host;
};

/** Does the binding allow this URL at all? */
export const bindingCovers = (binding: CredentialBinding, url: URL): boolean =>
  binding.hosts.some((entry) => entryMatches(entry, url));
