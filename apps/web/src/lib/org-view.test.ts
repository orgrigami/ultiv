import { describe, expect, it } from "vite-plus/test";
import {
  groupByHome,
  homeName,
  parseCollapsed,
  reachLine,
  reachTouches,
  readVmInput,
  toggleCollapsed,
  vmLabel,
} from "./org-view.ts";

const teams = [
  { id: "team-y", name: "Yard" },
  { id: "team-x", name: "Atelier" },
];

describe("groupByHome", () => {
  it("lists the org's bots first, then every team by name, empty ones too", () => {
    const groups = groupByHome(
      [
        { id: "a", teamId: "team-y" },
        { id: "b", teamId: null },
      ],
      teams,
      "Personal",
    );
    expect(groups.map((group) => [group.id, group.bots.map((bot) => bot.id)])).toEqual([
      [null, ["b"]],
      ["team-x", []],
      ["team-y", ["a"]],
    ]);
  });

  it("keeps the org on top even when it has no bots of its own", () => {
    const groups = groupByHome([{ id: "a", teamId: "team-x" }], teams, "Personal");
    expect(groups[0]).toEqual({ id: null, name: "Personal", bots: [] });
  });

  it("reads a bot whose team is gone as an org bot", () => {
    const groups = groupByHome([{ id: "a", teamId: "team-gone" }], teams, "Personal");
    expect(groups[0]).toEqual({
      id: null,
      name: "Personal",
      bots: [{ id: "a", teamId: "team-gone" }],
    });
  });
});

describe("home and size labels", () => {
  it("names the home", () => {
    expect(homeName("team-x", teams, "Personal")).toBe("Atelier");
    expect(homeName(null, teams, "Personal")).toBe("Personal (no team)");
  });

  it("shows and reads the VM size", () => {
    expect(vmLabel({ cpus: 1, memoryMiB: 512 })).toBe("1 CPU · 512 MiB");
    expect(vmLabel({ cpus: 2, memoryMiB: 1024 })).toBe("2 CPUs · 1024 MiB");
    expect(readVmInput("2", "1024")).toEqual({ cpus: 2, memoryMiB: 1024 });
    expect(readVmInput("0", "512")).toMatch(/CPUs/);
    expect(readVmInput("1", "64")).toMatch(/Memory/);
    expect(readVmInput("1.5", "512")).toMatch(/CPUs/);
    expect(readVmInput("8", "8192")).toEqual({ cpus: 8, memoryMiB: 8192 });
    expect(readVmInput("9", "512")).toMatch(/1 to 8/);
    expect(readVmInput("1", "8193")).toMatch(/128 to 8192/);
  });
});

describe("collapsed groups", () => {
  it("reads the stored list tolerantly and flips one group", () => {
    expect([...parseCollapsed('["team-x",3]')]).toEqual(["team-x"]);
    expect([...parseCollapsed("not json")]).toEqual([]);
    expect([...parseCollapsed(null)]).toEqual([]);
    expect(toggleCollapsed(new Set(["team-x"]), "team-x")).toEqual([]);
    expect(toggleCollapsed(new Set(["team-x"]), "team-y")).toEqual(["team-x", "team-y"]);
  });
});

describe("reach rows", () => {
  const row = {
    reach: {
      from: { kind: "team" as const, teamId: "team-x" },
      to: { kind: "org" as const },
      surface: "message" as const,
    },
  };

  it("reads a reach row as from → to and its surface", () => {
    expect(reachLine(row, teams, "Personal")).toBe("Atelier → Personal · message");
    expect(reachLine({}, teams, "Personal")).toBeNull();
  });

  it("knows which teams a row touches", () => {
    expect(reachTouches(row, "team-x")).toBe(true);
    expect(reachTouches(row, "team-y")).toBe(false);
  });
});
