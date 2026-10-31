/**
 * The HTTP adapter: https-only egress (plain http only to localhost under a
 * binding's explicit opt-in), every hop SSRF-guarded at connect time,
 * redirects followed by hand (capped; auth dropped for good once a hop leaves
 * the original host or the binding), and hard size and time limits.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { CredentialBinding } from "@spreissen/contracts";
import type { BindingCheck, CredentialAdapterImpl } from "./adapter.ts";
import { bindingCovers, callerHeaders, withAuth, type HopRequest } from "./http-auth.ts";
import { addressesAllowed, guardedLookup, isLocalhostName } from "./net-guard.ts";
import type { SecretMaterial } from "./redact.ts";

export const HTTP_LIMITS = {
  timeoutMs: 20_000,
  maxRequestBytes: 256 * 1024,
  maxResponseBytes: 512 * 1024,
  maxRedirects: 5,
} as const;

export interface HttpCall {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface HttpResult {
  readonly status: number;
  /** The final URL (the broker scrubs it before the model sees it). */
  readonly url: string;
  readonly contentType: string | null;
  readonly body: string;
  readonly truncated: boolean;
  readonly redirects: number;
  /** A redirect left the credential's host or binding, so later hops went without it. */
  readonly authDropped: boolean;
}

/** One raw exchange: status, headers, body bytes (capped). Swappable in tests. */
export type Transport = (
  hop: HopRequest,
  options: {
    readonly allowLoopback: boolean;
    readonly signal: AbortSignal;
    readonly maxBytes: number;
  },
) => Promise<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
  readonly truncated: boolean;
}>;

/** Scheme, userinfo and literal-IP rules for one hop. Returns the refusal, if any. */
export const targetProblem = (url: URL, allowLocalhostHttp: boolean): string | undefined => {
  if (url.username !== "" || url.password !== "")
    return "URLs with embedded credentials are refused";
  const localhost = allowLocalhostHttp && isLocalhostName(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localhost)) {
    return "only https URLs are allowed (plain http only to localhost, by explicit opt-in)";
  }
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) !== 0 && !addressesAllowed([literal], localhost)) {
    return `refused: ${literal} is a private, loopback, link-local or reserved address`;
  }
  return undefined;
};

const collect = (
  stream: NodeJS.ReadableStream & { destroy: () => void },
  maxBytes: number,
): Promise<{ body: Buffer; truncated: boolean }> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      if (size >= maxBytes) return;
      chunks.push(chunk.subarray(0, maxBytes - size));
      size += chunk.length;
      if (size >= maxBytes) {
        stream.destroy();
        resolve({ body: Buffer.concat(chunks), truncated: true });
      }
    });
    stream.on("end", () => resolve({ body: Buffer.concat(chunks), truncated: false }));
    stream.on("error", reject);
  });

/** The real transport: node http(s) with the guarded lookup, no agent reuse. */
export const nodeTransport: Transport = (hop, options) =>
  new Promise((resolve, reject) => {
    const send = hop.url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      hop.url,
      {
        method: hop.method,
        headers: hop.headers,
        agent: false,
        lookup: guardedLookup(options.allowLoopback) as never,
        signal: options.signal,
      },
      (response) => {
        collect(response, options.maxBytes).then(
          ({ body, truncated }) =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body,
              truncated,
            }),
          reject,
        );
      },
    );
    request.on("error", reject);
    if (hop.body !== undefined) request.write(hop.body);
    request.end();
  });

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The method and body after a redirect, per fetch semantics. */
const redirected = (hop: HopRequest, status: number, next: URL): HopRequest => {
  const toGet =
    (status === 303 && hop.method !== "HEAD") ||
    ((status === 301 || status === 302) && hop.method === "POST");
  if (!toGet) return { ...hop, url: next };
  const { "content-type": _type, ...headers } = hop.headers;
  return { url: next, method: "GET", headers, body: undefined };
};

export interface PerformOptions {
  readonly allowLocalhostHttp: boolean;
  readonly transport?: Transport;
}

const headerOf = (value: string | string[] | undefined): string | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

/**
 * Perform one call. `auth` (when present) is placed only on hops that stay on
 * the original host AND inside the binding; once a hop leaves, it never returns.
 */
export const performHttp = async (
  call: HttpCall,
  auth: { readonly material: SecretMaterial; readonly binding: CredentialBinding } | null,
  options: PerformOptions,
): Promise<HttpResult> => {
  const transport = options.transport ?? nodeTransport;
  if (call.body !== undefined && Buffer.byteLength(call.body) > HTTP_LIMITS.maxRequestBytes) {
    throw new Error(`request body over ${HTTP_LIMITS.maxRequestBytes} bytes`);
  }
  const origin = new URL(call.url);
  const signal = AbortSignal.timeout(HTTP_LIMITS.timeoutMs);
  let hop: HopRequest = {
    url: origin,
    method: call.method,
    headers: callerHeaders(call.headers, auth?.binding.auth.name),
    body: call.body,
  };
  let authDropped = false;
  for (let redirects = 0; ; redirects++) {
    const problem = targetProblem(hop.url, options.allowLocalhostHttp);
    if (problem !== undefined) throw new Error(problem);
    const stays = hop.url.host === origin.host && hop.url.protocol === origin.protocol;
    if (auth !== null && !(stays && bindingCovers(auth.binding, hop.url))) authDropped = true;
    const sent =
      auth !== null && !authDropped ? withAuth(hop, auth.binding.auth, auth.material) : hop;
    const allowLoopback = options.allowLocalhostHttp && isLocalhostName(hop.url.hostname);
    const response = await transport(sent, {
      allowLoopback,
      signal,
      maxBytes: HTTP_LIMITS.maxResponseBytes,
    });
    const location = headerOf(response.headers.location);
    if (REDIRECTS.has(response.status) && location !== null) {
      if (redirects >= HTTP_LIMITS.maxRedirects) {
        throw new Error(`too many redirects (over ${HTTP_LIMITS.maxRedirects})`);
      }
      hop = redirected(hop, response.status, new URL(location, hop.url));
      continue;
    }
    return {
      status: response.status,
      url: hop.url.toString(),
      contentType: headerOf(response.headers["content-type"]),
      body: response.body.toString("utf8"),
      truncated: response.truncated,
      redirects,
      authDropped: auth !== null && authDropped,
    };
  }
};

/** Binding policy for HTTP: method, scheme and target coverage. */
export const checkHttp = (binding: CredentialBinding, call: HttpCall): BindingCheck => {
  let url: URL;
  try {
    url = new URL(call.url);
  } catch {
    return { ok: false, reason: "not an absolute URL" };
  }
  if (!binding.methods.includes(call.method as CredentialBinding["methods"][number])) {
    return { ok: false, reason: `this credential is not allowed for ${call.method}` };
  }
  if (!bindingCovers(binding, url)) {
    return { ok: false, reason: `this credential is not allowed for ${url.host}` };
  }
  return { ok: true, host: url.host };
};

export const httpAdapter: CredentialAdapterImpl<HttpCall, HttpResult> = {
  kind: "http",
  check: checkHttp,
  perform: (call, secret) =>
    performHttp(call, secret, { allowLocalhostHttp: secret?.binding.allowLocalhostHttp ?? false }),
};
