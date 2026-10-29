import { describe, expect, it } from "vite-plus/test";
import type { ProfileInfo } from "@ultiv/contracts";
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

const tools = () => [{ name: "bash" }, { name: "bash_host" }, { name: "web_search" }];

/** The tool names of an agent's override, in order. */
const namesOf = (agent: { tools?: unknown }): readonly string[] =>
  Array.isArray(agent.tools) ? agent.tools.map((tool) => (tool as { name: string }).name) : [];

describe("the per-profile agent's tool set", () => {
  it("no allowlist and sandbox on hands the model every tool (no override)", () => {
    expect(
      agentForProfile(row({ policies: { ...defaultPolicies(), sandbox: true } }), tools).tools,
    ).toBeUndefined();
    // Bots created before the toggle existed (no stored key) read as sandboxed too.
    const { sandbox: _sandbox, ...legacy } = defaultPolicies();
    expect(agentForProfile(row({ policies: legacy }), tools).tools).toBeUndefined();
  });

  it("sandbox off removes bash (and only bash) even with no allowlist", () => {
    const agent = agentForProfile(
      row({ policies: { ...defaultPolicies(), sandbox: false } }),
      tools,
    );
    expect(namesOf(agent)).toEqual(["bash_host", "web_search"]);
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
});
