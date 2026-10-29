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

  it("leaves unknown tools in the classic wrench style", () => {
    expect(presentationOf(step({ name: "mcp__linear_create_issue" })).kind).toBe("classic");
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
