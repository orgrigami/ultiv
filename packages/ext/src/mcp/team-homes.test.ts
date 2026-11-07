import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { homeRefOfRecord, upgradeMcpTeamHomes } from "./config.ts";

let root = "";
afterEach(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("upgradeMcpTeamHomes", () => {
  it("renames each team's connector folder and its records' home, once", () => {
    root = mkdtempSync(join(tmpdir(), "spriessen-mcp-teams-"));
    const old = join(root, "owner", "dept-dept-ops");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "servers.json"), JSON.stringify([{ id: "s1", home: "dept-dept-ops" }]));
    mkdirSync(join(root, "owner", "dept-dept-a"), { recursive: true });
    mkdirSync(join(root, "owner", "team-dept-a"), { recursive: true });
    const [moved, conflicts] = upgradeMcpTeamHomes(root);
    expect(moved).toBe(1);
    expect(conflicts).toEqual(["owner/dept-dept-a"]);
    const moved1 = join(root, "owner", "team-dept-ops", "servers.json");
    expect(JSON.parse(readFileSync(moved1, "utf8"))).toEqual([{ id: "s1", home: "team-dept-ops" }]);
    expect(existsSync(old)).toBe(false);
    expect(upgradeMcpTeamHomes(root)[0]).toBe(0);
  });

  it("reads either segment as its team", () => {
    expect(homeRefOfRecord({ home: "team-x" })).toEqual({ kind: "team", teamId: "x" });
    expect(homeRefOfRecord({ home: "dept-x" })).toEqual({ kind: "team", teamId: "x" });
    expect(homeRefOfRecord({ home: "org" })).toEqual({ kind: "org" });
  });
});
