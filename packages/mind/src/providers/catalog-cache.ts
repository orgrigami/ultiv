/**
 * The on-disk copy of models.dev: the raw body plus when it was fetched and
 * its ETag. The mind boots from this file (no network on the hot path) and
 * revalidates in the background with `If-None-Match`, so an unchanged
 * catalog costs one 304.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface CachedCatalog {
  readonly fetchedAt: number;
  readonly etag?: string;
  readonly body: unknown;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** The cached catalog, or undefined when the file is missing or unreadable. */
export const readCache = async (path: string): Promise<CachedCatalog | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<CachedCatalog>;
    if (typeof parsed.fetchedAt !== "number" || parsed.body === undefined) return undefined;
    return {
      fetchedAt: parsed.fetchedAt,
      ...(typeof parsed.etag === "string" ? { etag: parsed.etag } : {}),
      body: parsed.body,
    };
  } catch {
    return undefined;
  }
};

/** Write through a temp file so a crash never leaves half a catalog behind. */
export const writeCache = async (path: string, entry: CachedCatalog): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(entry));
  await rename(temp, path);
};

/** A JSON file the owner may or may not have written (the overlay). */
export const readJsonFile = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
};

/** Fetch the catalog, revalidating against the previous copy; a 304 only refreshes its age. */
export const fetchCatalog = async (
  url: string,
  previous: CachedCatalog | undefined,
  options: { readonly fetcher: Fetcher; readonly timeoutMs: number; readonly now: number },
): Promise<CachedCatalog> => {
  const headers: Record<string, string> = { accept: "application/json" };
  if (previous?.etag !== undefined) headers["if-none-match"] = previous.etag;
  const response = await options.fetcher(url, {
    headers,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (response.status === 304 && previous !== undefined) {
    return { ...previous, fetchedAt: options.now };
  }
  if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
  const body = (await response.json()) as unknown;
  const etag = response.headers.get("etag");
  return { fetchedAt: options.now, ...(etag !== null ? { etag } : {}), body };
};
