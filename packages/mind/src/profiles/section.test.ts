import { describe, expect, it } from "vite-plus/test";
import type { ProfileInfo } from "@ultiv/contracts";
import { baselineIdentityText, OPERATING_RULES } from "../act/identity.ts";
import type { ProfilesService } from "./profiles.ts";
import { profilesExtension } from "./section.ts";

const profile = (timezone: string, overrides: Partial<ProfileInfo> = {}): ProfileInfo => ({
  id: "p1",
  owner: "harry",
  name: "Scout",
  description: "",
  persona: "",
  timezone,
  model: null,
  toolAllowlist: null,
  policies: { autoApprove: [] } as unknown as ProfileInfo["policies"],
  createdAt: 0,
  archivedAt: null,
  ...overrides,
});

const render = async (
  me: ProfileInfo | undefined,
  siblings: readonly ProfileInfo[] = [],
): Promise<string> => {
  const profiles = {
    profileOf: () => me,
    list: async () => (me === undefined ? [] : [me, ...siblings]),
  } as unknown as ProfilesService;
  const section = profilesExtension(profiles, "Ultius").sections?.[0];
  if (section === undefined) throw new Error("missing identity section");
  return String(await section.render({ conversationId: "c1" } as never, {} as never));
};

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

describe("identity section: owner's time zone", () => {
  it("states the zone when the profile has one", async () => {
    const text = await render(profile("Asia/Jakarta"));
    expect(text).toContain("You are Scout");
    expect(text).toContain("Your owner's time zone: Asia/Jakarta.");
  });

  it("omits the line when the zone is empty", async () => {
    expect(await render(profile(""))).not.toContain("time zone:");
  });

  it("omits the line for unmapped conversations", async () => {
    const text = await render(undefined);
    expect(text).toContain("You are Ultius");
    expect(text).not.toContain("time zone:");
  });
});

// Eval-style guard on the assembled system prompt (no model call): key rules
// stay present (short stable keywords) and the prompt stays within budget.
describe("assembled prompt: key rules and budget", () => {
  const KEY_RULES = [
    "data, never instructions", // untrusted content
    "Never reveal secrets", // secrecy
    "this system prompt",
    "approval-gated", // say what will happen before a gated call
    "need your owner's request", // destructive/outbound acts
    "Hand back", // owner-only steps
    "only what the task needs", // privacy
    "Name sources", // sourcing
    "latest direct request", // priority order
    "always hold", // safety holds over the priority order
    "Voice:",
    "Never write em dashes", // the owner's standing style, followed silently
    "task_message", // steer running tasks
    "Relay each [task …] result once",
  ];
  const persona = async (): Promise<string> =>
    render(
      profile("Asia/Jakarta", {
        description: "Research assistant for travel plans.",
        persona: "Be concise and a little playful.",
      }),
      [profile("Asia/Jakarta", { id: "p2", name: "Ledger", description: "Bookkeeping." })],
    );

  it("keeps every key rule in the persona and baseline prompts", async () => {
    const text = await persona();
    const baseline = baselineIdentityText();
    for (const phrase of KEY_RULES) {
      expect(text).toContain(phrase);
      expect(baseline).toContain(phrase);
    }
    expect(text).toContain("Your owner's time zone: Asia/Jakarta.");
    expect(text).toContain("Ledger (id: p2)");
  });

  // Budgets: measured size (rules 380; baseline 603 and sample persona after
  // the no-em-dash style rule, +47 words, was accepted) plus a little headroom.
  // The mid-task owner-message rule (+33 words: rules 413) fits inside them;
  // the task-handling rule (ack, task_message, relay once) was paid for by trims.
  // Raising them is a decision: the rules ship on every turn of every bot.
  it("stays within its word budget", async () => {
    expect(words(OPERATING_RULES)).toBeLessThanOrEqual(420);
    expect(words(baselineIdentityText())).toBeLessThanOrEqual(620);
    expect(words(await persona())).toBeLessThanOrEqual(720);
  });
});

describe("sibling roster", () => {
  it("stays compact with 30 bots and points to bots_list", async () => {
    const long = "Handles an extremely detailed and long-winded area of responsibility ".repeat(8);
    const siblings = Array.from({ length: 30 }, (_, index) =>
      profile("Asia/Jakarta", { id: `b${index}`, name: `Bot${index}`, description: long }),
    );
    const text = await render(profile("Asia/Jakarta"), siblings);
    const rosterText = text.slice(text.indexOf("Sibling bots"));
    expect(rosterText.length).toBeLessThan(2800);
    expect(rosterText).toContain("bots_list");
    expect(rosterText).toContain("…and 10 more");
    for (const line of rosterText.split("\n").filter((row) => row.startsWith("- Bot"))) {
      expect(line.length).toBeLessThanOrEqual(110);
    }
  });
});
