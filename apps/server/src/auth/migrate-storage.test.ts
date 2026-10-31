/**
 * The storage half of the owner migration: per-owner folders move (or merge
 * into an existing account folder), artifact sidecars relabel, push
 * subscriptions follow their owner, and a second run finds nothing.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { migrateStorage } from "./migrate-storage.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-migrate-storage-"));
// Explicit bases: the migration reads the environment for its real dirs, and
// env vars leak across test files in one process, so the test passes its own.
const dirs = {
  artifacts: join(scratch, "artifacts"),
  skills: join(scratch, "skills"),
  botFiles: join(scratch, "bot-files"),
  mcp: join(scratch, "mcp"),
  vault: join(scratch, "vault"),
  push: join(scratch, "push"),
};
const move = (to: string, from?: string[]): ReturnType<typeof migrateStorage> =>
  migrateStorage({ to, ...(from !== undefined ? { from } : {}), dirs });

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const seed = (base: string, label: string, file: string, body: string): void => {
  const path = join(base, label, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};

describe("migrateStorage", () => {
  it("moves folders, relabels sidecars and push rows, and is repeatable", () => {
    seed(dirs.artifacts, "guest", "bot-1/note.json", JSON.stringify({ owner: "guest", name: "n" }));
    seed(dirs.artifacts, "guest", "bot-1/blob", "# raw bytes stay");
    seed(dirs.skills, "guest", "weekly/SKILL.md", "---\nname: weekly\n---\n");
    seed(dirs.vault, "guest", "items/a.json", "{}");
    mkdirSync(dirs.push, { recursive: true });
    writeFileSync(
      join(dirs.push, "subscriptions.json"),
      JSON.stringify({ guest: [{ endpoint: "https://push.example/1" }] }),
    );

    const report = move("owner", ["guest"]);
    expect(report.folders.length).toBeGreaterThanOrEqual(3);
    expect(report.sidecars).toBe(1);
    expect(report.pushEntries).toBe(1);

    // Content under the account label; the guest folders are gone.
    const movedSidecar = JSON.parse(
      readFileSync(join(dirs.artifacts, "owner", "bot-1", "note.json"), "utf8"),
    ) as { owner: string };
    expect(movedSidecar.owner).toBe("owner");
    expect(readFileSync(join(dirs.artifacts, "owner", "bot-1", "blob"), "utf8")).toBe(
      "# raw bytes stay",
    );
    expect(readFileSync(join(dirs.skills, "owner", "weekly", "SKILL.md"), "utf8")).toContain(
      "weekly",
    );
    expect(readFileSync(join(dirs.vault, "owner", "items", "a.json"), "utf8")).toBe("{}");
    const subs = JSON.parse(readFileSync(join(dirs.push, "subscriptions.json"), "utf8")) as Record<
      string,
      unknown[]
    >;
    expect(subs["owner"]).toHaveLength(1);
    expect(subs["guest"]).toBeUndefined();

    // Repeatable: nothing left to move.
    const second = move("owner", ["guest"]);
    expect(second.folders).toEqual([]);
    expect(second.sidecars).toBe(0);
    expect(second.pushEntries).toBe(0);
  });

  it("merges into an existing account folder without clobbering it", () => {
    seed(dirs.artifacts, "guest", "bot-2/arriving.json", JSON.stringify({ owner: "guest" }));
    seed(dirs.artifacts, "owner", "bot-2/kept.json", JSON.stringify({ owner: "owner" }));
    const report = move("owner", ["guest"]);
    expect(
      JSON.parse(readFileSync(join(dirs.artifacts, "owner", "bot-2", "kept.json"), "utf8")),
    ).toEqual({
      owner: "owner",
    });
    expect(
      JSON.parse(readFileSync(join(dirs.artifacts, "owner", "bot-2", "arriving.json"), "utf8")),
    ).toEqual({
      owner: "owner",
    });
    expect(report.folders.join("\n")).toContain("merged");
  });

  it("relabels the owner stored inside MCP records and vault items", () => {
    seed(
      dirs.mcp,
      "label-a",
      "servers.json",
      JSON.stringify([{ id: "srv-1", owner: "label-a", name: "one" }]),
    );
    seed(
      dirs.vault,
      "label-a",
      "items/item-1.json",
      JSON.stringify({ info: { id: "item-1", owner: "label-a" }, sealed: "opaque" }),
    );
    const report = move("owner", ["label-a"]);
    const servers = JSON.parse(
      readFileSync(join(dirs.mcp, "owner", "servers.json"), "utf8"),
    ) as { owner: string }[];
    expect(servers.map((row) => row.owner)).toEqual(["owner"]);
    const item = JSON.parse(
      readFileSync(join(dirs.vault, "owner", "items", "item-1.json"), "utf8"),
    ) as { info: { owner: string }; sealed: string };
    expect(item.info.owner).toBe("owner");
    expect(item.sealed).toBe("opaque");
    expect(report.records).toBe(2);
  });

  it("merges two servers.json files instead of dropping the arriving one", () => {
    seed(
      dirs.mcp,
      "label-b",
      "servers.json",
      JSON.stringify([
        { id: "srv-1", owner: "label-b", name: "same id: the account's copy wins" },
        { id: "srv-2", owner: "label-b", name: "two" },
      ]),
    );
    const report = move("owner", ["label-b"]);
    const servers = JSON.parse(
      readFileSync(join(dirs.mcp, "owner", "servers.json"), "utf8"),
    ) as { id: string; owner: string; name: string }[];
    expect(servers.map((row) => row.id)).toEqual(["srv-1", "srv-2"]);
    expect(servers.find((row) => row.id === "srv-1")?.name).toBe("one");
    expect(servers.every((row) => row.owner === "owner")).toBe(true);
    expect(report.conflicts).toEqual([]);
  });

  it("leaves bot-owned and other labels' sidecars alone, and reports kept collisions", () => {
    seed(dirs.artifacts, "owner", "bot-4/by-bot.json", JSON.stringify({ owner: "agent" }));
    seed(dirs.artifacts, "owner", "bot-4/unowned.json", JSON.stringify({ owner: null }));
    seed(dirs.artifacts, "label-c", "bot-4/clash.json", JSON.stringify({ owner: "label-c" }));
    seed(dirs.artifacts, "owner", "bot-4/clash.json", JSON.stringify({ owner: "owner" }));
    const report = move("owner", ["label-c"]);
    const at = (name: string): unknown =>
      JSON.parse(readFileSync(join(dirs.artifacts, "owner", "bot-4", name), "utf8"));
    expect(at("by-bot.json")).toEqual({ owner: "agent" });
    expect(at("unowned.json")).toEqual({ owner: null });
    expect(report.conflicts).toEqual([join(dirs.artifacts, "label-c", "bot-4", "clash.json")]);
  });

  it("the dry run reports without touching anything", () => {
    seed(dirs.artifacts, "smoker", "bot-3/x.json", JSON.stringify({ owner: "smoker" }));
    const plan = migrateStorage({ to: "owner", from: ["smoker"], dirs, dryRun: true });
    expect(plan.folders.join(",")).toContain("smoker");
    expect(readFileSync(join(dirs.artifacts, "smoker", "bot-3", "x.json"), "utf8")).toContain(
      "smoker",
    );
    expect(
      migrateStorage({ to: "owner", from: ["smoker"], dirs, dryRun: true }).folders.length,
    ).toBe(1);
  });
});
