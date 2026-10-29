/** The URLs a listening server answers on, for the boot log: one per facet. */
import type { Server } from "node:http";
import { networkInterfaces } from "node:os";

const WILDCARDS = new Set(["0.0.0.0", "::"]);

const hostPart = (address: string): string => (address.includes(":") ? `[${address}]` : address);

/** localhost plus every interface address when bound to all, else the bound address. */
export const reachableUrls = (server: Server, host: string | undefined): string[] => {
  const bound = server.address();
  if (bound === null || typeof bound === "string") return [String(bound)];
  const port = bound.port;
  if (host !== undefined && !WILDCARDS.has(host)) return [`http://${hostPart(host)}:${port}`];
  const ipv4Only = bound.family === "IPv4";
  const addresses = Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((info) => !info.internal && !(ipv4Only && info.family === "IPv6"))
    // Link-local IPv6 needs a zone id no browser takes; skip it.
    .filter((info) => !info.address.startsWith("fe80:"))
    .map((info) => `http://${hostPart(info.address)}:${port}`);
  return [`http://localhost:${port}`, ...addresses];
};
