/**
 * The built web app, served by the server itself (`spriessen serve`): one
 * process is the whole app, no `vp preview` in front. Only GET/HEAD outside
 * the server's own prefixes (/api, /hooks, /chord, /agent, /push) are files;
 * every path resolves INSIDE the dist folder (`resolveInside`), a missing
 * file answers the SPA's index.html (client routes), and hashed assets
 * cache for a year while index.html, the service worker and the manifest
 * always revalidate. The page itself carries no data: everything it shows
 * comes through the signed-in API.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { tryResolveInside } from "@spriessen/ext";

const SERVER_PREFIXES = ["/api/", "/hooks/", "/chord", "/agent", "/push"];

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** A handler that answers true when it served the request (false: not a web file). */
export const staticHandler = (
  dist: string,
): ((req: IncomingMessage, res: ServerResponse) => boolean) => {
  if (!existsSync(join(dist, "index.html"))) {
    throw new Error(`no web build at ${dist} (run: vp -C apps/web build)`);
  }
  const index = join(dist, "index.html");
  return (req, res) => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") return false;
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (SERVER_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))) return false;
    let relative: string;
    try {
      relative = decodeURIComponent(path).replace(/^\/+/, "");
    } catch {
      return false;
    }
    const found = relative === "" ? undefined : tryResolveInside(dist, relative);
    const file = found !== undefined && isFile(found) ? found : index;
    const hashed = file !== index && relative.startsWith("assets/");
    res.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
    });
    if (method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
    return true;
  };
};
