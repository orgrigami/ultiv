/**
 * Connectors per home (phase 4 slice 7): MCP server config moves from per
 * owner to per home. The storage layout: the ORG's file stays
 * `{MCP_DIR}/{owner}/servers.json`; team D's records live at
 * `{MCP_DIR}/{owner}/team-<D>/servers.json`. `upgradeMcpHomes` stamps legacy
 * rows as org connectors — repeatable, like `sealWebhookTokens`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { makeMcpManager } from "./manager.ts";
import {
  homeOfRecord,
  makeMcpConfigStore,
  upgradeMcpHomes,
  type McpServerRecord,
} from "./config.ts";

const dirs: string[] = [];
const tempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "spriessen-mcp-homes-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const input = (name: string) => ({
  name,
  transport: "http" as const,
  url: "https://example.test/mcp",
  command: null,
  auth: { kind: "none" as const },
  profiles: null,
  enabled: true,
  autoAllowReadOnly: false,
  disabledTools: [],
});

describe("the per-home config store", () => {
  it("files each record under its home: the org at the owner root, a team in its segment", () => {
    const root = tempRoot();
    const store = makeMcpConfigStore(root);
    const org = {
      ...input("Org relay"),
      id: "srv-org",
      owner: "owner-a",
      slug: "orgrelay",
      createdAt: 1,
      firstUseApproved: false,
    };
    const team = {
      ...input("Team relay"),
      id: "srv-team",
      owner: "owner-a",
      slug: "teamrelay",
      createdAt: 2,
      firstUseApproved: false,
      home: "team-x",
    };
    store.put(org);
    store.put(team);
    // Layout: the org's file is unchanged ({owner}/servers.json); the
    // team's is {owner}/team-x/servers.json.
    expect(existsSync(join(root, "owner-a", "servers.json"))).toBe(true);
    expect(existsSync(join(root, "owner-a", "team-x", "servers.json"))).toBe(true);
    // The owner's list spans homes; a home's list is exactly its own.
    expect(store.list("owner-a").map((record) => record.id)).toEqual(["srv-org", "srv-team"]);
    expect(store.listHome("owner-a", "org").map((record) => record.id)).toEqual(["srv-org"]);
    expect(store.listHome("owner-a", "team-x").map((record) => record.id)).toEqual(["srv-team"]);
    // get/remove search across homes; the record remembers its home (a row
    // in a home file reads as that home).
    expect(store.get("owner-a", "srv-team")?.home).toBe("team-x");
    expect(store.get("owner-a", "srv-org")?.home).toBe("org");
    expect(homeOfRecord(store.get("owner-a", "srv-org")!)).toBe("org");
    expect(store.remove("owner-a", "srv-team")).toBe(true);
    expect(store.get("owner-a", "srv-team")).toBeUndefined();
    expect(store.listHome("owner-a", "team-x")).toEqual([]);
  });

  it("keeps a record's home on re-put and never mixes homes with the same id", () => {
    const root = tempRoot();
    const store = makeMcpConfigStore(root);
    const record: McpServerRecord = {
      ...input("Team relay"),
      id: "srv-1",
      owner: "owner-a",
      slug: "teamrelay",
      createdAt: 1,
      firstUseApproved: false,
      home: "team-x",
    };
    store.put(record);
    store.put({ ...record, name: "Renamed" });
    expect(store.get("owner-a", "srv-1")?.name).toBe("Renamed");
    expect(store.listHome("owner-a", "org")).toEqual([]);
    expect(store.listHome("owner-a", "team-x")).toHaveLength(1);
  });
});

describe("upgradeMcpHomes (existing connectors move to the org)", () => {
  const legacyFile = (root: string, records: unknown[]): string => {
    const dir = join(root, "owner-a");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "servers.json");
    writeFileSync(path, JSON.stringify(records), { mode: 0o600 });
    return path;
  };

  it("stamps legacy rows as the org, in place; a second run changes nothing", () => {
    const root = tempRoot();
    const path = legacyFile(root, [
      {
        ...input("Old relay"),
        id: "srv-1",
        owner: "owner-a",
        slug: "oldrelay",
        createdAt: 1,
        firstUseApproved: false,
      },
      {
        ...input("Kept"),
        id: "srv-2",
        owner: "owner-a",
        slug: "kept",
        createdAt: 2,
        firstUseApproved: false,
        home: "team-x",
      },
    ]);
    expect(upgradeMcpHomes(root)).toBe(1);
    const records = JSON.parse(readFileSync(path, "utf8")) as McpServerRecord[];
    expect(records.find((record) => record.id === "srv-1")?.home).toBe("org");
    // The team row is untouched.
    expect(records.find((record) => record.id === "srv-2")?.home).toBe("team-x");
    // Repeatable: the second run changes nothing.
    expect(upgradeMcpHomes(root)).toBe(0);
    // A missing dir is not an error.
    expect(upgradeMcpHomes(join(root, "nope"))).toBe(0);
  });

  it("a record without home reads as the org before the upgrade runs", () => {
    const root = tempRoot();
    legacyFile(root, [
      {
        ...input("Old relay"),
        id: "srv-1",
        owner: "owner-a",
        slug: "oldrelay",
        createdAt: 1,
        firstUseApproved: false,
      },
    ]);
    const store = makeMcpConfigStore(root);
    expect(store.listHome("owner-a", "org").map((record) => record.id)).toEqual(["srv-1"]);
    expect(homeOfRecord(store.get("owner-a", "srv-1")!)).toBe("org");
  });
});

describe("the manager stamps the home it is given", () => {
  it("add(owner, input, home) lands the connector in that home", async () => {
    const root = tempRoot();
    const manager = makeMcpManager({
      config: makeMcpConfigStore(root),
      vault: null,
      vaultRoot: null,
    });
    try {
      const team = manager.add("owner-a", input("Team relay"), "team-y");
      expect(team.home).toBe("team-y");
      const org = manager.add("owner-a", input("Org relay"));
      expect(org.home).toBeUndefined();
      expect(manager.view("owner-a", team.id)?.record.home).toBe("team-y");
    } finally {
      await manager.close();
    }
  });
});
