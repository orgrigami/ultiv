import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptEntry } from "@spriessen/contracts";
import { TranscriptItems } from "./transcript-items.tsx";
import { StatusRow } from "./chat-states.tsx";
import { MessageActions } from "./message-parts.tsx";

const at = Date.UTC(2026, 10, 5, 9, 0);
const ask: TranscriptEntry = { id: 1, kind: "input", at, text: "What's the weather?" };
const reply = (extra: Partial<Extract<TranscriptEntry, { kind: "output" }>>): TranscriptEntry => ({
  id: 2,
  kind: "output",
  at: at + 1000,
  text: "Sunny, 31°C.",
  streaming: false,
  ...extra,
});

const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe("a bot message's action row", () => {
  it("offers copy exactly once per finished reply, interrupted or not", () => {
    for (const interrupted of [false, true]) {
      const html = renderToStaticMarkup(
        <TranscriptItems transcript={[ask, reply({ interrupted })]} bot={{ name: "Ada" }} />,
      );
      expect(count(html, 'aria-label="Copy message"')).toBe(1);
      expect(count(html, ">Interrupted<")).toBe(interrupted ? 1 : 0);
    }
  });

  it("has no copy while the reply streams, and none for a reply cut before any text", () => {
    const streaming = renderToStaticMarkup(
      <TranscriptItems transcript={[ask, reply({ streaming: true })]} bot={{ name: "Ada" }} />,
    );
    expect(streaming).not.toContain("Copy message");
    expect(streaming).toContain("data-streaming");
    const empty = renderToStaticMarkup(
      <TranscriptItems
        transcript={[ask, reply({ text: "", interrupted: true })]}
        bot={{ name: "Ada" }}
      />,
    );
    expect(empty).not.toContain("Copy message");
    expect(empty).toContain("Interrupted before replying");
  });

  it("puts the status before copy and a reason on its own line", () => {
    const html = renderToStaticMarkup(
      <MessageActions text="hi" status="Couldn't be delivered" detail="Budget spent." />,
    );
    expect(html.indexOf("Couldn&#x27;t be delivered")).toBeLessThan(html.indexOf("Copy message"));
    expect(html).toContain("Budget spent.</p>");
  });
});

describe("StatusRow", () => {
  it("says nothing while a reply streams: the caret already shows it", () => {
    const html = renderToStaticMarkup(
      <StatusRow transcript={[ask, reply({ streaming: true })]} pending={null} />,
    );
    expect(html).toBe("");
  });

  it("shows the face only before the bot's turn has a head of its own", () => {
    const fresh = renderToStaticMarkup(<StatusRow transcript={[ask]} pending={null} />);
    const open = renderToStaticMarkup(<StatusRow transcript={[ask, reply({})]} pending={null} />);
    expect(fresh).toContain("<svg");
    expect(fresh).toContain("Working…");
    expect(open).toContain("Working…");
    expect(count(open, 'class="char ')).toBe(0);
  });
});
