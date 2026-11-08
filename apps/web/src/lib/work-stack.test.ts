import { describe, expect, it } from "vite-plus/test";
import type { TaskInfo } from "@spriessen/contracts";
import {
  tabTop,
  workDock,
  workKey,
  WORK_TABS_LIMIT,
  type WorkDock,
  type WorkItem,
} from "./work-stack.ts";

const file = (id: string): WorkItem => ({ kind: "file", file: { id, name: `${id}.txt` } });
const task = (id: string, title: string): WorkItem => ({
  kind: "task",
  task: { id, title } as unknown as TaskInfo,
});
const fresh = (dock: WorkDock, item: WorkItem): WorkDock =>
  workDock(dock, { type: "open", item, fresh: true });
/** The kind of the item a tab shows, "" when there is no such tab. */
const topKind = (dock: WorkDock, index = 0): string => {
  const tab = dock.tabs[index];
  return tab === undefined ? "" : tabTop(tab).kind;
};

describe("workDock", () => {
  it("opens tabs, switches and closes them", () => {
    let dock = fresh({ tabs: [], active: null }, task("t1", "a"));
    dock = fresh(dock, file("f1"));
    expect(dock.tabs.map((tab) => workKey(tab.root))).toEqual(["task:t1", "file:f1"]);
    expect(dock.active).toBe("file:f1");
    dock = workDock(dock, { type: "select", key: "task:t1" });
    expect(dock.active).toBe("task:t1");
    dock = workDock(dock, { type: "close", key: "task:t1" });
    expect(dock.tabs.map((tab) => workKey(tab.root))).toEqual(["file:f1"]);
    expect(dock.active).toBe("file:f1");
    dock = workDock(dock, { type: "close" });
    expect(dock.tabs).toEqual([]);
    expect(dock.active).toBeNull();
  });
  it("pushes inside the active tab and Back reaches the root", () => {
    let dock = fresh({ tabs: [], active: null }, task("t1", "a"));
    dock = workDock(dock, { type: "open", item: file("f1") });
    expect(topKind(dock)).toBe("file");
    dock = workDock(dock, { type: "back" });
    expect(topKind(dock)).toBe("task");
  });
  it("reuses a tab when the same root opens fresh again", () => {
    let dock = fresh({ tabs: [], active: null }, task("t1", "old"));
    dock = workDock(dock, { type: "open", item: file("f1") });
    dock = fresh(dock, task("t1", "new"));
    expect(dock.tabs).toHaveLength(1);
    expect(topKind(dock)).toBe("task");
    expect(dock.active).toBe("task:t1");
  });
  it("keeps the root at the trail base when the trail is capped", () => {
    let dock = fresh({ tabs: [], active: null }, task("t1", "a"));
    for (let index = 0; index < 6; index++)
      dock = workDock(dock, { type: "open", item: file(`f${index}`) });
    const tab = dock.tabs[0];
    expect(tab !== undefined && tab.trail[0]?.kind).toBe("task");
    expect(tab?.trail.length ?? 0).toBeLessThanOrEqual(3);
  });
  it("caps tabs and evicts the oldest that is not active", () => {
    let dock: WorkDock = { tabs: [], active: null };
    for (let index = 0; index < 12; index++) dock = fresh(dock, file(`f${index}`));
    expect(dock.tabs).toHaveLength(WORK_TABS_LIMIT);
    expect(dock.tabs.at(-1)).toMatchObject({ root: { file: { id: "f11" } } });
  });
  it("keys memory by bot", () => {
    expect(workKey({ kind: "memory", profileId: "b1", name: "Atlas", query: "x" })).toBe(
      "memory:b1",
    );
  });
});
