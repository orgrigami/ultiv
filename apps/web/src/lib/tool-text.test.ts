import { describe, expect, it } from "vite-plus/test";
import type { ToolStep } from "@ultiv/contracts";
import { DURATION_FLOOR_MS, humanizeMs, presentationOf } from "./tool-text.ts";

const step = (over: Partial<ToolStep>): ToolStep => ({
  callId: "c1",
  name: "web_search",
  status: "done",
  input: {},
  output: null,
  durationMs: 1200,
  ...over,
});

describe("presentationOf", () => {
  it("hides inner monologue (Jev, the clock) from the transcript", () => {
    expect(presentationOf(step({ name: "jev_score" })).kind).toBe("hidden");
    expect(presentationOf(step({ name: "now" })).kind).toBe("hidden");
  });

  it("gives unknown tools a human title, receipts as their body", () => {
    const view = presentationOf(step({ name: "mcp__linear_create_issue" }));
    expect(view.kind).toBe("human");
    if (view.kind !== "human") return fail();
    expect(view.view.done).toBe("Linear create issue");
    expect(view.view.live).toBe("Linear create issue…");
    expect(view.view.structured).toBeUndefined();
  });

  it("covers the whole registry: skills, vault, crew, connectors, history, calendar", () => {
    for (const [name, done] of [
      ["skill_list", "Listed its skills"],
      ["skill_install", "Installed a skill"],
      ["skill_evolve", "Started improving a skill"],
      ["vault_list", "Checked the vault"],
      ["vault_contacts", "Looked up a contact"],
      ["bots_list", "Listed the crew"],
      ["bot_info", "Read a sibling's profile"],
      ["connector_load", "Loaded connector tools"],
      ["connector_reconnect", "Reconnected a connector"],
      ["history_search", "Searched past chats"],
      ["calendar_events", "Read the calendar"],
    ] as const) {
      const view = presentationOf(step({ name }));
      if (view.kind !== "human") return fail();
      expect(view.view.done).toBe(done);
    }
  });

  it("gives list tools their output as the body, no input noise", () => {
    const view = presentationOf(
      step({
        name: "bots_list",
        input: { includeArchived: true },
        output: "1 bot(s):\n- V (id: ba79-4ef4) (you) · Chief of Staff; tools: all tools",
      }),
    );
    if (view.kind !== "human") return fail();
    expect(view.view.detail).toBeUndefined();
    expect(view.view.structured).toEqual({
      t: "output",
      text: "1 bot(s):\n- V (id: ba79-4ef4) (you) · Chief of Staff; tools: all tools",
    });
  });

  it("booleans never ride the line as a detail", () => {
    const view = presentationOf(
      step({ name: "schedule_set", input: { schedule: "30 9 * * 1", once: true } }),
    );
    if (view.kind !== "human") return fail();
    expect(view.view.detail).toBe("30 9 * * 1");
  });

  it("previews a skill's reference file like any file", () => {
    const view = presentationOf(
      step({
        name: "skill_file",
        input: { name: "async-research", path: "references/triage.md" },
        output: "# Triage on arrival\n\nRead the request first.",
      }),
    );
    if (view.kind !== "human") return fail();
    expect(view.view.detail).toBe("references/triage.md");
    expect(view.view.structured).toEqual({
      t: "file",
      name: "references/triage.md",
      text: "# Triage on arrival\n\nRead the request first.",
    });
  });

  it("reads a record off a skill write", () => {
    const view = presentationOf(
      step({
        name: "skill_write",
        input: { name: "async-research", description: "How to take research requests" },
        output: "wrote skill async-research v1",
      }),
    );
    if (view.kind !== "human") return fail();
    expect(view.view.done).toBe("Wrote a skill");
    expect(view.view.structured).toBeDefined();
  });

  it("words a memory write by its consolidation verb, quoting the fact", () => {
    const view = presentationOf(
      step({
        name: "memory_write",
        input: {
          text: "Owner prefers Obsidian CLI for vault operations",
          basis: "owner_said",
          kind: "fact",
        },
        output: "remembered (add): Owner prefers Obsidian CLI for vault operations",
      }),
    );
    expect(view.kind).toBe("human");
    if (view.kind !== "human") return;
    expect(view.view.done).toBe("Remembered");
    expect(view.view.live).toBe("Noting it down…");
    expect(view.view.body).toBe("Owner prefers Obsidian CLI for vault operations");
    expect(view.view.tags).toContain("from you");
    expect(view.view.tags).toContain("fact");
    expect(view.view.lookup).toContain("Obsidian");
  });

  it("tells a correction from a duplicate", () => {
    const supersede = presentationOf(
      step({ name: "memory_write", output: "remembered (supersede, replaced ab12…): x" }),
    );
    const noop = presentationOf(step({ name: "memory_write", output: "remembered (noop): x" }));
    if (supersede.kind !== "human" || noop.kind !== "human") return fail();
    expect(supersede.view.done).toBe("Corrected an older note");
    expect(noop.view.done).toBe("Already knew this");
  });

  it("admits a refused write instead of claiming success", () => {
    const refused = presentationOf(
      step({
        name: "memory_write",
        status: "error",
        output: "refused: standing instructions are only recorded from the owner's own words",
      }),
    );
    if (refused.kind !== "human") return fail();
    expect(refused.view.done).toBe("Couldn't save that memory");
  });

  it("counts recalled memories and keeps their lines", () => {
    const view = presentationOf(
      step({
        name: "memory_recall",
        input: { query: "vault", about: "Obsidian" },
        output: "fact one\nfact two\nfact three",
      }),
    );
    if (view.kind !== "human") return fail();
    expect(view.view.done).toBe("Recalled 3 memories");
    expect(view.view.detail).toBe("Obsidian");
    expect(view.view.lines).toEqual(["fact one", "fact two", "fact three"]);
    expect(view.view.done).not.toContain("memories match");
  });

  it("says when nothing was recalled", () => {
    const view = presentationOf(step({ name: "memory_recall", output: "no matching memory." }));
    if (view.kind !== "human") return fail();
    expect(view.view.done).toBe("No memories matched");
  });

  it("names the sibling a message went to, falling back to the raw id", () => {
    const asked = presentationOf(
      step({
        name: "message",
        input: { to: "bot_2", kind: "request", body: "Can you draft the report?", topic: "Q3" },
        output: "message 1 admitted to bot_2.",
      }),
      (id) => (id === "bot_2" ? "Eve" : undefined),
    );
    const stranger = presentationOf(
      step({ name: "message", input: { to: "bot_9", kind: "notify", body: "hi" } }),
    );
    if (asked.kind !== "human" || stranger.kind !== "human") return fail();
    expect(asked.view.done).toBe("Asked Eve");
    expect(asked.view.tags).toEqual(["room: Q3"]);
    expect(asked.view.body).toBe("Can you draft the report?");
    expect(stranger.view.done).toBe("Notified bot_9");
  });

  it("reads a room's topic and drops the header from its lines", () => {
    const view = presentationOf(
      step({
        name: "room",
        output:
          "Room “Q3 report” (eve, ultius) — full transcript:\n\nEve (10:00): hello\n\n---\n\nUltius (10:01): hi",
      }),
    );
    if (view.kind !== "human") return fail();
    expect(view.view.detail).toBe("Q3 report");
    expect(view.view.lines).toEqual(["Eve (10:00): hello", "Ultius (10:01): hi"]);
  });

  it("searches get their query, fetches their host", () => {
    const search = presentationOf(step({ input: { query: "ultiv monorepo" } }));
    const fetch = presentationOf(
      step({ name: "web_fetch", input: { url: "https://example.com/docs?a=1" } }),
    );
    if (search.kind !== "human" || fetch.kind !== "human") return fail();
    expect(search.view.done).toBe("Searched the web");
    expect(search.view.detail).toBe("ultiv monorepo");
    expect(fetch.view.done).toBe("Read a web page");
    expect(fetch.view.detail).toBe("example.com");
  });

  it("puts a script's first words on the bash line", () => {
    const view = presentationOf(
      step({ name: "bash", input: { command: "ls -la\nrm -rf nothing" } }),
    );
    if (view.kind !== "human") return fail();
    expect(view.view.done).toBe("Ran a script");
    expect(view.view.detail).toBe("ls -la rm -rf nothing");
  });

  it("gives verb-table tools their past and present tenses", () => {
    const done = presentationOf(step({ name: "schedule_set" }));
    const running = presentationOf(step({ name: "schedule_set", status: "running" }));
    if (done.kind !== "human" || running.kind !== "human") return fail();
    expect(done.view.done).toBe("Set a schedule");
    expect(running.view.live).toBe("Setting a schedule…");
  });
});

describe("humanizeMs", () => {
  it("speaks owner units, not machine ones", () => {
    expect(humanizeMs(740)).toBe("740 ms");
    expect(humanizeMs(2339)).toBe("2.3 s");
    expect(humanizeMs(12_400)).toBe("12 s");
    expect(humanizeMs(64_000)).toBe("1 m 04 s");
  });

  it("keeps the floor so quick calls show no duration at all", () => {
    expect(DURATION_FLOOR_MS).toBe(3000);
    expect(humanizeMs(DURATION_FLOOR_MS)).toBe("3.0 s");
  });
});

function fail(): never {
  throw new Error("expected a human presentation");
}

describe("artifact_write file card", () => {
  it("carries the file ref from details on a done write", () => {
    const view = presentationOf(
      step({
        name: "artifact_write",
        input: { name: "report.md", content: "ignored" },
        details: { id: "a1", name: "report.md", mime: "text/markdown", bytes: 12 },
      }),
    );
    if (view.kind !== "human") fail();
    expect(view.view.artifact).toEqual({
      id: "a1",
      name: "report.md",
      mime: "text/markdown",
      bytes: 12,
    });
  });

  it("falls back to the legacy output line for old entries", () => {
    const view = presentationOf(
      step({
        name: "artifact_write",
        input: { name: "old.md", content: "" },
        output: "artifact a2 (old.md) in your workspace; your owner can open it in the app",
      }),
    );
    if (view.kind !== "human") fail();
    expect(view.view.artifact).toEqual({ id: "a2", name: "old.md" });
  });

  it("shows no card while running, on error, or for reads", () => {
    for (const s of [
      step({ name: "artifact_write", status: "running" }),
      step({ name: "artifact_write", status: "error" }),
      step({ name: "artifact_read", status: "done", details: { id: "x" } }),
    ]) {
      const view = presentationOf(s);
      if (view.kind !== "human") fail();
      expect(view.view.artifact).toBeUndefined();
    }
  });
});
