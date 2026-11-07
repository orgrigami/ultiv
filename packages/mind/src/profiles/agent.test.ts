import { describe, expect, it } from "vite-plus/test";
import type { ProfileInfo } from "@spriessen/contracts";
import { defaultPolicies } from "./docs.ts";
import { agentForProfile } from "./agent.ts";

const row = (over: Partial<ProfileInfo>): ProfileInfo => ({
  id: "p1",
  owner: "harry",
  name: "Scout",
  description: "",
  persona: "",
  timezone: "Asia/Jakarta",
  model: null,
  toolAllowlist: null,
  policies: defaultPolicies(),
  createdAt: 0,
  archivedAt: null,
  ...over,
});

const tools = () => [{ name: "bash" }, { name: "notes_search" }, { name: "web_search" }];

/**
 * The tool names a conversation ends up with against `registry`, the way
 * pi-durable resolves them: a list selects exactly, `{ remove }` drops names,
 * unset/null keeps every registry tool.
 */
const namesOf = (
  agent: { tools?: unknown },
  registry: readonly { name: string }[] = tools(),
): readonly string[] => {
  if (Array.isArray(agent.tools)) {
    return agent.tools.map((tool) => (tool as { name: string }).name);
  }
  const removed =
    agent.tools !== undefined && agent.tools !== null
      ? (agent.tools as { remove: readonly { name: string }[] }).remove.map((tool) => tool.name)
      : [];
  return registry.map((tool) => tool.name).filter((name) => !removed.includes(name));
};

describe("the per-profile agent's tool set", () => {
  it("no allowlist and sandbox on hands the model every tool (clears any stored filter)", () => {
    expect(
      agentForProfile(row({ policies: { ...defaultPolicies(), sandbox: true } }), tools).tools,
    ).toBeNull();
    // Bots created before the toggle existed (no stored key) read as sandboxed too.
    const { sandbox: _sandbox, ...legacy } = defaultPolicies();
    expect(agentForProfile(row({ policies: legacy }), tools).tools).toBeNull();
  });

  it("sandbox off removes bash (and only bash) even with no allowlist", () => {
    const agent = agentForProfile(
      row({ policies: { ...defaultPolicies(), sandbox: false } }),
      tools,
    );
    expect(namesOf(agent)).toEqual(["notes_search", "web_search"]);
  });

  it("an allowlist naming bash does not override a sandbox-off bot", () => {
    const agent = agentForProfile(
      row({
        toolAllowlist: ["bash", "web_search"],
        policies: { ...defaultPolicies(), sandbox: false },
      }),
      tools,
    );
    expect(namesOf(agent)).toEqual(["web_search"]);
  });

  it("sandbox off also removes the read-only browser (no VM to run it in)", () => {
    const withBrowser = () => [...tools(), { name: "browser_open" }];
    const agent = agentForProfile(
      row({ policies: { ...defaultPolicies(), sandbox: false } }),
      withBrowser,
    );
    expect(namesOf(agent, withBrowser())).toEqual(["notes_search", "web_search"]);
    // And an allowlist naming it does not override the exclusion either.
    const allowlisted = agentForProfile(
      row({
        toolAllowlist: ["browser_open", "web_search"],
        policies: { ...defaultPolicies(), sandbox: false },
      }),
      withBrowser,
    );
    expect(namesOf(allowlisted)).toEqual(["web_search"]);
  });
});

/**
 * Regression (Phase 4): a team bot with its host switch off got a FIXED
 * list built from the act/bot/connector catalog — every mind faculty tool
 * (`message`, rooms, memory, tasks, schedules) and every late install was
 * silently gone, so it could not answer its mailbox.
 */
describe("faculty tools survive every exclusion", () => {
  /** The catalog `tools()` (allowlistable) vs the whole registry (faculties too). */
  const catalog = () => [{ name: "bash" }, { name: "notes_search" }, { name: "web_search" }];
  const faculties = [
    { name: "message" },
    { name: "room_send" },
    { name: "memory_save" },
    { name: "task_spawn" },
    { name: "schedule_create" },
  ];
  const stdio = [{ name: "fs_local__read" }];
  const registry = [...catalog(), ...faculties, ...stdio];
  const all = () => registry;
  const orgBot = agentForProfile(row({}), catalog, undefined, [], all);
  const teamBot = agentForProfile(
    row({ teamId: "research" } as Partial<ProfileInfo>),
    catalog,
    undefined,
    ["notes_search", "fs_local__read"],
    all,
  );

  it("a host-switch-off team bot has exactly the org bot's tools minus host-direct ones", () => {
    const org = namesOf(orgBot, registry);
    const team = namesOf(teamBot, registry);
    expect(team).toEqual(
      org.filter((name) => name !== "notes_search" && name !== "fs_local__read"),
    );
    expect(team).toContain("message");
  });

  it("a tool installed AFTER the agent was built still reaches the excluded bot", () => {
    const late = [...registry, { name: "late_faculty" }];
    expect(namesOf(teamBot, late)).toContain("late_faculty");
  });

  it("a sandbox-off bot keeps message", () => {
    const agent = agentForProfile(
      row({ policies: { ...defaultPolicies(), sandbox: false } }),
      catalog,
      undefined,
      ["notes_search"],
      all,
    );
    const names = namesOf(agent, registry);
    expect(names).toContain("message");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("notes_search");
  });

  it("an allowlist governs only the catalog: faculties stay", () => {
    const agent = agentForProfile(
      row({ toolAllowlist: ["web_search"] }),
      catalog,
      undefined,
      [],
      all,
    );
    expect(namesOf(agent, registry)).toEqual([
      "web_search",
      ...faculties.map((tool) => tool.name),
      ...stdio.map((tool) => tool.name),
    ]);
  });
});
