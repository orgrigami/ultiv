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

const departments = [
  { id: "dept-y", name: "Yard" },
  { id: "dept-x", name: "Atelier" },
];

describe("groupByHome", () => {
  it("lists the org's bots first, then every department by name, empty ones too", () => {
    const groups = groupByHome(
      [
        { id: "a", departmentId: "dept-y" },
        { id: "b", departmentId: null },
      ],
      departments,
      "Personal",
    );
    expect(groups.map((group) => [group.id, group.bots.map((bot) => bot.id)])).toEqual([
      [null, ["b"]],
      ["dept-x", []],
      ["dept-y", ["a"]],
    ]);
  });

  it("keeps the org on top even when it has no bots of its own", () => {
    const groups = groupByHome([{ id: "a", departmentId: "dept-x" }], departments, "Personal");
    expect(groups[0]).toEqual({ id: null, name: "Personal", bots: [] });
  });

  it("reads a bot whose department is gone as an org bot", () => {
    const groups = groupByHome([{ id: "a", departmentId: "dept-gone" }], departments, "Personal");
    expect(groups[0]).toEqual({
      id: null,
      name: "Personal",
      bots: [{ id: "a", departmentId: "dept-gone" }],
    });
  });
});

describe("home and size labels", () => {
  it("names the home", () => {
    expect(homeName("dept-x", departments, "Personal")).toBe("Atelier");
    expect(homeName(null, departments, "Personal")).toBe("Personal (no department)");
  });

  it("shows and reads the VM size", () => {
    expect(vmLabel({ cpus: 1, memoryMiB: 512 })).toBe("1 CPU · 512 MiB");
    expect(vmLabel({ cpus: 2, memoryMiB: 1024 })).toBe("2 CPUs · 1024 MiB");
    expect(readVmInput("2", "1024")).toEqual({ cpus: 2, memoryMiB: 1024 });
    expect(readVmInput("0", "512")).toMatch(/CPUs/);
    expect(readVmInput("1", "64")).toMatch(/Memory/);
    expect(readVmInput("1.5", "512")).toMatch(/CPUs/);
    expect(readVmInput("64", "512")).toEqual({ cpus: 64, memoryMiB: 512 });
    expect(readVmInput("65", "512")).toMatch(/1 to 64/);
  });
});

describe("collapsed groups", () => {
  it("reads the stored list tolerantly and flips one group", () => {
    expect([...parseCollapsed('["dept-x",3]')]).toEqual(["dept-x"]);
    expect([...parseCollapsed("not json")]).toEqual([]);
    expect([...parseCollapsed(null)]).toEqual([]);
    expect(toggleCollapsed(new Set(["dept-x"]), "dept-x")).toEqual([]);
    expect(toggleCollapsed(new Set(["dept-x"]), "dept-y")).toEqual(["dept-x", "dept-y"]);
  });
});

describe("reach rows", () => {
  const row = {
    reach: {
      from: { kind: "department" as const, departmentId: "dept-x" },
      to: { kind: "org" as const },
      surface: "message" as const,
    },
  };

  it("reads a reach row as from → to and its surface", () => {
    expect(reachLine(row, departments, "Personal")).toBe("Atelier → Personal · message");
    expect(reachLine({}, departments, "Personal")).toBeNull();
  });

  it("knows which departments a row touches", () => {
    expect(reachTouches(row, "dept-x")).toBe(true);
    expect(reachTouches(row, "dept-y")).toBe(false);
  });
});
