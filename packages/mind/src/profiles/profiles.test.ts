import { describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { SessionInfo } from "@spreissen/contracts";
import { defaultPolicies } from "./docs.ts";
import { openMind } from "../entity.ts";

describe("Profiles (offline, MemoryStorage)", () => {
  it("a fresh workspace starts empty and scopes sessions to profiles", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { profiles } = handle.mind;
    // Fresh install: no default bot materializes and there is no main.
    expect(await profiles.list("harry")).toEqual([]);
    expect(await profiles.mainOf("harry")).toBeNull();

    const created = await profiles.create("harry", { name: "Scout", onboard: false });
    // The first bot claims main automatically.
    expect(await profiles.mainOf("harry")).toBe(created.id);

    const session = await profiles.createSession("harry", created.id, "work");
    const listed = await profiles.listSessions("harry");
    expect(listed.filter((row) => row.id === session.id).length).toBe(1);
    expect((await profiles.listSessions("someone-else")).length).toBe(0);
    await handle.close();
  });

  it("creates profiles, Bot Mode main chats, and maps conversations to the profile", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { profiles } = handle.mind;
    const researcher = await profiles.create("harry", {
      name: "Researcher",
      description: "Deep-dive analysis",
      persona: "You are meticulous.",
    });
    expect(researcher.timezone.length).toBeGreaterThan(0);

    const main = await profiles.ensureMain("harry", researcher.id);
    expect(main.kind).toBe("main");
    // Idempotent: the same row comes back.
    expect((await profiles.ensureMain("harry", researcher.id)).id).toBe(main.id);
    // The main chat's conversation maps back to the profile (persona/audit scope).
    const scoped = await Effect.runPromise(
      handle.mind.converse.conversationIdOf(await profiles.keyOfRow(main)),
    );
    expect(scoped).toBeDefined();
    expect(profiles.profileOf(String(scoped))?.id).toBe(researcher.id);
    expect(profiles.scopeOf(String(scoped))?.kind).toBe("main");
    await handle.close();
  });

  it("an edit reaches every chat of the bot, clamps, and clears", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { profiles } = handle.mind;
    const bot = await profiles.create("harry", {
      name: "Editor",
      description: "Old role",
      persona: "Old persona.",
      onboard: false,
    });
    const cidOf = async (row: SessionInfo): Promise<string> =>
      String(
        await Effect.runPromise(
          handle.mind.converse.conversationIdOf(await profiles.keyOfRow(row)),
        ),
      );
    const main = await cidOf(await profiles.ensureMain("harry", bot.id));
    const other = await cidOf(await profiles.createSession("harry", bot.id, "side"));
    // A reset leaves the old main listed as a session; it is refreshed too.
    const fresh = await cidOf(await profiles.resetMain("harry", bot.id));

    const long = "x".repeat(9_000);
    const updated = await profiles.update("harry", bot.id, { persona: long });
    expect(updated.persona.length).toBe(8_000);
    expect(profiles.profileOf(main)?.persona).toBe(updated.persona);
    // Other sessions pick the edit up too.
    expect(profiles.profileOf(other)?.persona).toBe(updated.persona);
    expect(profiles.profileOf(fresh)?.persona).toBe(updated.persona);

    // Empty strings clear the role and persona.
    await profiles.update("harry", bot.id, { description: "", persona: "" });
    expect(profiles.profileOf(main)?.persona).toBe("");
    expect(profiles.profileOf(main)?.description).toBe("");
    expect((await profiles.get("harry", bot.id))?.description).toBe("");
    expect(profiles.profileOf(other)?.description).toBe("");
    await handle.close();
  });

  it("a partial policies patch merges per key and rejects an unknown mode", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { profiles } = handle.mind;
    const bot = await profiles.create("harry", { name: "Gated", onboard: false });
    // What the chat-box switcher sends: only the mode key.
    const switched = await profiles.update("harry", bot.id, {
      policies: { ...defaultPolicies(), approvalMode: "yolo" },
    } as never);
    expect(switched.policies.approvalMode).toBe("yolo");
    // The other keys survived (defaults, not a wholesale replace).
    expect(switched.policies.canInitiate).toEqual(["*"]);
    expect(switched.policies.approvalTimeout).toBe("deny");
    expect(switched.policies.dailyTurnBudget).toBeNull();
    expect(switched.policies.memoryKeeper).toBe(false);
    let reason = "";
    try {
      await profiles.update("harry", bot.id, {
        policies: { ...defaultPolicies(), approvalMode: "chaos" },
      } as never);
    } catch (error) {
      reason = (error as { reason?: string }).reason ?? "";
    }
    expect(reason).toBe("unknown approval mode: chaos");
    await handle.close();
  });

  it("reset rotates the main chat and keeps the old transcript listed", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { profiles } = handle.mind;
    const bot = await profiles.create("harry", { name: "Rotator", onboard: false });
    const first = await profiles.ensureMain("harry", bot.id);
    const second = await profiles.resetMain("harry", bot.id);
    expect(second.id).not.toBe(first.id);
    expect(second.kind).toBe("main");
    const rows = await profiles.listSessions("harry");
    const old = rows.find((row) => row.id === first.id);
    expect(old?.kind).toBe("session");
    await handle.close();
  });
});

describe("Profiles: rooms, removal, tool allowlists (offline, MemoryStorage)", () => {
  it("rooms are contextual: one per pair+topic, and never sessions", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { profiles, rooms } = handle.mind;
    const a = await profiles.create("harry", { name: "CoS", onboard: false });
    const b = await profiles.create("harry", { name: "Researcher", onboard: false });
    const report = await rooms.ensure("harry", [a.id, b.id], "Q3 report");
    // Same participants + topic → the same room; different topic → a new one.
    expect((await rooms.ensure("harry", [b.id, a.id], "Q3 report")).id).toBe(report.id);
    const onboard = await rooms.ensure("harry", [a.id, b.id], "onboarding");
    expect(onboard.id).not.toBe(report.id);
    // Rooms are invisible in session lists (bot-to-bot traffic is not "my chats").
    expect((await profiles.listSessions("harry")).every((row) => row.kind !== "room")).toBe(true);
    // A room is just a tunnel record — no seat conversations are created; the
    // thinking happens at the endpoints (main threads / sessions).
    expect(await rooms.purgeProfile("harry", a.id)).toBe(2);
    expect((await rooms.list("harry")).length).toBe(0);
    await handle.close();
  });

  it("rejects bad input and removes profiles with their sessions", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { profiles } = handle.mind;
    let threw = false;
    try {
      await profiles.create("harry", { name: "X", timezone: "Mars/Olympus" });
    } catch (error) {
      threw = (error as { reason?: string }).reason === "unknown timezone: Mars/Olympus";
    }
    expect(threw).toBe(true);
    const profile = await profiles.create("harry", { name: "Temp", onboard: false });
    await profiles.createSession("harry", profile.id, null);
    const removed = await profiles.remove("harry", profile.id);
    expect(removed.length).toBe(1);
    expect((await profiles.listSessions("harry", profile.id)).length).toBe(0);
    expect(await profiles.get("harry", profile.id)).toBeUndefined();
    await handle.close();
  });

  it("applies tool allowlists to the agent new conversations start with", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { profiles } = handle.mind;
    const profile = await profiles.create("harry", {
      name: "Locked",
      toolAllowlist: ["now", "web_search", "no_such_tool"],
    });
    const agent = profiles.agentFor(profile);
    expect(Array.isArray(agent.tools)).toBe(true);
    const names = (agent.tools as readonly { name: string }[]).map((tool) => tool.name);
    // web_search only installs when TINYFISH_API_KEY is set, so expect exactly
    // the allowlisted tools this mind really has; unknown names drop out.
    const installed = new Set(handle.mind.act.tools().map((tool) => tool.name));
    expect(installed.has("now")).toBe(true);
    expect(names).toEqual(["now", "web_search"].filter((name) => installed.has(name)));
    // No allowlist: all tools stay available.
    const open = profiles.agentFor(
      await profiles.create("harry", { name: "Open", onboard: false }),
    );
    expect(open.tools).toBeUndefined();
    // A fresh workspace starts EMPTY — no default bot materializes.
    expect(await profiles.list("someone-else")).toEqual([]);
    await handle.close();
  });

  it("allowTool never widens a patterned list, and never saves a rule that cannot approve", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { profiles } = handle.mind;
    const profile = await profiles.create("harry", {
      name: "P",
      onboard: false,
      policies: { ...defaultPolicies(), autoApprove: ["bash:git *"] },
    });
    // A destructive call the pattern refused: the exact-text rule would go
    // through the same refusal on the next identical call — a dead rule —
    // so nothing is saved and the call stays gated.
    expect(
      await profiles.allowTool("harry", profile.id, "bash", { script: "git push --force" }),
    ).toEqual([]);
    expect((await profiles.get("harry", profile.id))?.policies.autoApprove).toEqual(["bash:git *"]);
    // A benign call outside the pattern's glob: the exact text verifies, so
    // one narrow pattern is added — the whole tool is never granted.
    expect(
      await profiles.allowTool("harry", profile.id, "bash", { script: "npm install" }),
    ).toEqual(["bash:npm install"]);
    expect((await profiles.get("harry", profile.id))?.policies.autoApprove).toEqual([
      "bash:git *",
      "bash:npm install",
    ]);
    // A MULTI-FIELD call stores nothing at all: per-field rules would let
    // the weakest field ("http_request:POST") approve any POST to any host.
    const http = await profiles.create("harry", {
      name: "H",
      onboard: false,
      policies: { ...defaultPolicies(), autoApprove: ["http_request:api.example.com"] },
    });
    expect(
      await profiles.allowTool("harry", http.id, "http_request", {
        method: "POST",
        url: "https://api.example.com/ok",
        host: "api.example.com",
        credential: "GH",
      }),
    ).toEqual([]);
    expect((await profiles.get("harry", http.id))?.policies.autoApprove).toEqual([
      "http_request:api.example.com",
    ]);
    // The privileged host shell is never granted from a card, bare or not.
    expect(await profiles.allowTool("harry", http.id, "bash_host", { script: "ls" })).toEqual([]);
    expect((await profiles.get("harry", http.id))?.policies.autoApprove).not.toContain("bash_host");
    // A profile with no pattern for the tool keeps today's bare-name grant.
    const plain = await profiles.create("harry", { name: "Plain", onboard: false });
    await profiles.allowTool("harry", plain.id, "bash", { script: "ls" });
    const wide = await profiles.get("harry", plain.id);
    expect(wide?.policies.autoApprove).toContain("bash");
    await handle.close();
  });
});
