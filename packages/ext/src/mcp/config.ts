/**
 * MCP server config, persisted server-side under MCP_DIR (default `var/mcp`,
 * outside git): per HOME, written 0600 (phase 4 slice 7 — the layout: the
 * ORG's file stays `{root}/{owner}/servers.json`; department D's is
 * `{root}/{owner}/dept-<D>/servers.json`). Records hold no secret bytes;
 * header values and stdio env vars are vault item ids. `upgradeMcpHomes`
 * stamps legacy rows (a bare `servers.json` pre-dating the field) as org
 * home connectors — repeatable, like `sealWebhookTokens`.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { InvalidInput, resolveInside } from "@spriessen/core";
import type { HomeRef, McpServerInput } from "@spriessen/contracts";
import { dataPath } from "@spriessen/core";

/** One saved server: the owner's input plus identity, first-use state and home. */
export type McpServerRecord = McpServerInput & {
  readonly id: string;
  readonly owner: string;
  /** Tool-name prefix, unique across all owners. */
  readonly slug: string;
  readonly createdAt: number;
  /** The owner approved one call; read-only tools may now auto-run. */
  readonly firstUseApproved: boolean;
  /**
   * The home the connector belongs to (slice 7): an opaque home segment the
   * mind supplies (`org` or `dept-<department id>`); ext judges nothing.
   * Absent on legacy rows — they read, and upgrade, as the org.
   */
  readonly home?: string;
};

/** The segment of the org home (the mind's convention; ext treats it opaque). */
export const ORG_HOME = "org";

/** The home a record belongs to: the stored segment, else the org. */
export const homeOfRecord = (record: Pick<McpServerRecord, "home">): string =>
  record.home ?? ORG_HOME;

/**
 * The home a record's vault lookups run in (phase 4 slice 8): the org, or
 * the department the segment names. The `dept-` prefix is the mind's home
 * segment convention (slice 7); ext only maps it, it never judges homes.
 */
export const homeRefOfRecord = (record: Pick<McpServerRecord, "home">): HomeRef => {
  const home = homeOfRecord(record);
  return home === ORG_HOME || !home.startsWith("dept-")
    ? { kind: "org" }
    : { kind: "department", departmentId: home.slice("dept-".length) };
};

export const mcpDir = (): string => {
  const configured = process.env.MCP_DIR?.trim();
  return configured !== undefined && configured !== "" ? configured : dataPath("mcp");
};

const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** A home segment is one safe path part, never the stdio `work` dir. */
const validHome = (home: string): boolean => SAFE_SEGMENT.test(home) && home !== "work";

export interface McpConfigStore {
  /** Every record of every owner and home (boot, slug uniqueness). */
  readonly all: () => readonly McpServerRecord[];
  /** Every record of one owner, across that owner's homes (the owner's view). */
  readonly list: (owner: string) => readonly McpServerRecord[];
  /** One home's records (a bot sees only its home's). */
  readonly listHome: (owner: string, home: string) => readonly McpServerRecord[];
  readonly get: (owner: string, id: string) => McpServerRecord | undefined;
  readonly put: (record: McpServerRecord) => void;
  readonly remove: (owner: string, id: string) => boolean;
  /** A private working directory for one stdio server (created 0700). */
  readonly workDir: (owner: string, id: string) => string;
}

/**
 * Stamp legacy rows as org connectors and rewrite their files — the
 * repeatable upgrade (slice 7): existing connectors move to the org, in
 * place (the org file's path is unchanged), and a second run changes
 * nothing. Returns how many records it stamped.
 */
export const upgradeMcpHomes = (root: string = mcpDir()): number => {
  let stamped = 0;
  if (!existsSync(root)) return 0;
  for (const owner of readdirSync(root)) {
    if (!SAFE_SEGMENT.test(owner)) continue;
    const dir = resolveInside(root, owner);
    const legacy = join(dir, "servers.json");
    if (!existsSync(legacy)) continue;
    let records: McpServerRecord[];
    try {
      records = JSON.parse(readFileSync(legacy, "utf8")) as McpServerRecord[];
    } catch {
      continue;
    }
    if (!Array.isArray(records)) continue;
    if (records.every((record) => record.home !== undefined)) continue;
    const next = records.map((record) =>
      record.home !== undefined ? record : { ...record, home: ORG_HOME },
    );
    stamped += next.length - records.filter((record) => record.home !== undefined).length;
    const temp = `${legacy}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(temp, legacy);
    chmodSync(legacy, 0o600);
  }
  return stamped;
};

export const makeMcpConfigStore = (root: string = mcpDir()): McpConfigStore => {
  // The org's records live in the owner's own servers.json; a department
  // home's live in a subdirectory named by its segment.
  const homeDirOf = (owner: string, home: string): string =>
    home === ORG_HOME ? resolveInside(root, owner) : resolveInside(root, owner, home);
  const fileOf = (owner: string, home: string): string =>
    resolveInside(homeDirOf(owner, home), "servers.json");
  const readHome = (owner: string, home: string): McpServerRecord[] => {
    if (!SAFE_SEGMENT.test(owner) || !validHome(home)) return [];
    const path = fileOf(owner, home);
    if (!existsSync(path)) return [];
    try {
      return (JSON.parse(readFileSync(path, "utf8")) as McpServerRecord[]).map((record) => ({
        ...record,
        // A row inside a home file without a stored home belongs to that
        // home (defensive; the upgrade stamps the org file's rows).
        home: record.home ?? home,
      }));
    } catch {
      return [];
    }
  };
  const homesOf = (owner: string): string[] => {
    const dir = resolveInside(root, owner);
    if (!existsSync(dir)) return [];
    return [ORG_HOME, ...readdirSync(dir).filter((entry) => validHome(entry))];
  };
  const read = (owner: string): McpServerRecord[] =>
    homesOf(owner).flatMap((home) => readHome(owner, home));
  const write = (owner: string, home: string, records: readonly McpServerRecord[]): void => {
    if (!SAFE_SEGMENT.test(owner) || !validHome(home))
      throw new InvalidInput({ reason: "bad home" });
    mkdirSync(homeDirOf(owner, home), { recursive: true, mode: 0o700 });
    const path = fileOf(owner, home);
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(records, null, 2), { mode: 0o600 });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  };
  return {
    all: () =>
      existsSync(root)
        ? readdirSync(root)
            .filter((owner) => SAFE_SEGMENT.test(owner))
            .flatMap((owner) => read(owner))
        : [],
    list: (owner) => read(owner).sort((a, b) => a.createdAt - b.createdAt),
    listHome: (owner, home) => readHome(owner, home).sort((a, b) => a.createdAt - b.createdAt),
    get: (owner, id) => read(owner).find((record) => record.id === id),
    put: (record) => {
      const home = homeOfRecord(record);
      const records = readHome(record.owner, home).filter((entry) => entry.id !== record.id);
      write(record.owner, home, [...records, record]);
    },
    remove: (owner, id) => {
      for (const home of homesOf(owner)) {
        const records = readHome(owner, home);
        const kept = records.filter((entry) => entry.id !== id);
        if (kept.length === records.length) continue;
        write(owner, home, kept);
        return true;
      }
      return false;
    },
    workDir: (owner, id) => {
      if (!SAFE_SEGMENT.test(owner) || !SAFE_SEGMENT.test(id)) {
        throw new InvalidInput({ reason: "bad server id" });
      }
      const dir = resolveInside(root, owner, "work", id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    },
  };
};

const isHttpUrl = (text: string): boolean => {
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

/** Shape rules the schema cannot express; throws InvalidInput in plain words. */
export const validateServerInput = (input: McpServerInput): void => {
  if (input.transport === "stdio") {
    if (input.command === null)
      throw new InvalidInput({ reason: "a local server needs a command" });
    if (input.url !== null) throw new InvalidInput({ reason: "a local server has no URL" });
    if (input.auth.kind !== "none") {
      throw new InvalidInput({ reason: "local servers take secrets as environment variables" });
    }
    return;
  }
  if (input.command !== null) throw new InvalidInput({ reason: "a remote server has no command" });
  if (input.url === null || !isHttpUrl(input.url)) {
    throw new InvalidInput({ reason: "a remote server needs an http(s) URL" });
  }
};
