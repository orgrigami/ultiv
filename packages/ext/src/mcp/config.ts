/**
 * MCP server config, persisted server-side under MCP_DIR (default `var/mcp`,
 * outside git): one `servers.json` per owner, written 0600. Records hold no
 * secret bytes; header values and stdio env vars are vault item ids.
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
import { InvalidInput } from "@spreissen/core";
import type { McpServerInput } from "@spreissen/contracts";

/** One saved server: the owner's input plus identity and first-use state. */
export type McpServerRecord = McpServerInput & {
  readonly id: string;
  readonly owner: string;
  /** Tool-name prefix, unique across all owners. */
  readonly slug: string;
  readonly createdAt: number;
  /** The owner approved one call; read-only tools may now auto-run. */
  readonly firstUseApproved: boolean;
};

export const mcpDir = (): string => {
  const configured = process.env.MCP_DIR?.trim();
  return configured !== undefined && configured !== "" ? configured : "var/mcp";
};

const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export interface McpConfigStore {
  readonly all: () => readonly McpServerRecord[];
  readonly list: (owner: string) => readonly McpServerRecord[];
  readonly get: (owner: string, id: string) => McpServerRecord | undefined;
  readonly put: (record: McpServerRecord) => void;
  readonly remove: (owner: string, id: string) => boolean;
  /** A private working directory for one stdio server (created 0700). */
  readonly workDir: (owner: string, id: string) => string;
}

export const makeMcpConfigStore = (root: string = mcpDir()): McpConfigStore => {
  const fileOf = (owner: string): string => join(root, owner, "servers.json");
  const read = (owner: string): McpServerRecord[] => {
    if (!SAFE_SEGMENT.test(owner)) return [];
    const path = fileOf(owner);
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, "utf8")) as McpServerRecord[];
    } catch {
      return [];
    }
  };
  const write = (owner: string, records: readonly McpServerRecord[]): void => {
    if (!SAFE_SEGMENT.test(owner)) throw new InvalidInput({ reason: "bad owner" });
    mkdirSync(join(root, owner), { recursive: true, mode: 0o700 });
    const path = fileOf(owner);
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
    get: (owner, id) => read(owner).find((record) => record.id === id),
    put: (record) => {
      const records = read(record.owner).filter((entry) => entry.id !== record.id);
      write(record.owner, [...records, record]);
    },
    remove: (owner, id) => {
      const records = read(owner);
      const kept = records.filter((entry) => entry.id !== id);
      if (kept.length === records.length) return false;
      write(owner, kept);
      return true;
    },
    workDir: (owner, id) => {
      if (!SAFE_SEGMENT.test(owner) || !SAFE_SEGMENT.test(id)) {
        throw new InvalidInput({ reason: "bad server id" });
      }
      const dir = join(root, owner, "work", id);
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
