/**
 * The guarded fetch behind skill_install: HTTPS only, every resolved address
 * checked by the broker's SSRF guard (no private, loopback or reserved
 * ranges; the checked address is the one connected to), bounded time and
 * size, and at most three https-only redirects. This is the narrow door
 * outside content enters the skill store through, and it stays gated: the
 * owner's approval happens before this code runs.
 */
import { request as httpsRequest } from "node:https";
import { guardedLookup } from "@ultiv/ext";

export interface FetchedText {
  readonly url: string;
  readonly text: string;
  readonly status: number;
}

export interface FetchedBytes {
  readonly url: string;
  readonly body: Buffer;
  readonly status: number;
}

const MAX_FETCH_BYTES = 5_000_000;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;

/** One GET, guarded; follows same-scheme redirects up to the cap. */
const getOnce = (url: URL): Promise<{ status: number; location?: string; body: Buffer }> =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "GET",
        agent: false,
        lookup: guardedLookup(false) as never,
        headers: {
          accept:
            "text/markdown, text/plain, application/gzip, application/x-tar; q=0.9, */*; q=0.1",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_FETCH_BYTES) {
            res.destroy();
            reject(new Error(`response exceeds ${MAX_FETCH_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            ...(typeof res.headers.location === "string" ? { location: res.headers.location } : {}),
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s`));
    });
    req.on("error", reject);
    req.end();
  });

const redirectOf = (status: number): boolean =>
  status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

/** Fetch bytes over the guarded path. Https URLs only; errors carry plain text. */
export const fetchBytes = async (raw: string): Promise<FetchedBytes> => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a URL: ${raw.slice(0, 120)}`);
  }
  if (url.protocol === "http:") throw new Error("https URLs only");
  if (url.protocol !== "https:") throw new Error(`unsupported scheme: ${url.protocol}`);
  if (url.username !== "" || url.password !== "")
    throw new Error("credentials in URLs are refused");
  for (let hop = 0; ; hop++) {
    const res = await getOnce(url);
    if (redirectOf(res.status)) {
      if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
      const location = res.location;
      if (location === undefined)
        throw new Error(`redirect ${res.status} without a Location header`);
      url = new URL(location, url);
      if (url.protocol !== "https:") throw new Error("redirect left https; refused");
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GET ${url.host}${url.pathname} responded ${res.status}`);
    }
    if (res.body.length === 0) throw new Error("the response was empty");
    return { url: url.toString(), body: res.body, status: res.status };
  }
};

/** Fetch a skill file's raw text (bytes decoded utf8). */
export const fetchText = async (raw: string): Promise<FetchedText> => {
  const fetched = await fetchBytes(raw);
  return { url: fetched.url, text: fetched.body.toString("utf8"), status: fetched.status };
};
