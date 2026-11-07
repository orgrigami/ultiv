/**
 * The TUI's pieces, rendered headless with OpenTUI's test renderer on Node:
 * the transcript words tool calls through the shared lens and hides
 * thinking, the approval card offers "always allow" only where the web
 * does, Needs you lists cards by bot name, and the key dispatch keeps bare
 * letters away from the composer unless a card holds the keyboard.
 */
import type { KeyEvent } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import type { ProfileInfo, TranscriptEntry } from "@spriessen/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { EMPTY_SNAPSHOT } from "../client/session.ts";
import { ApprovalCard } from "./card.tsx";
import { ChatPane } from "./chat-pane.tsx";
import { NeedsView } from "./needs.tsx";
import { dispatchKey, type KeyActions } from "./use-keys.ts";

const frameOf = async (node: React.ReactNode, width = 80, height = 24): Promise<string> => {
  const setup = await testRender(node, { width, height });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
};

const entries: TranscriptEntry[] = [
  { id: 1, kind: "input", at: 0, text: "find the release notes" },
  { id: 2, kind: "thinking", at: 1, text: "SECRET REASONING" },
  {
    id: 3,
    kind: "tool",
    at: 2,
    step: {
      callId: "c1",
      name: "web_search",
      status: "done",
      input: { query: "release notes" },
      output: "[]",
      durationMs: 10,
    },
  },
  { id: 4, kind: "output", at: 3, text: "Here they are.", streaming: false },
];

const bot = { id: "b1", name: "Wren" } as ProfileInfo;

describe("the TUI views", () => {
  it("draws the chat: owner text, the worded tool row, the reply, never thinking", async () => {
    const frame = await frameOf(
      <ChatPane
        snapshot={{ ...EMPTY_SNAPSHOT, loaded: true, transcript: entries }}
        bot="Wren"
        draft=""
        setDraft={() => undefined}
        submit={() => undefined}
        typing
        cardFocused={false}
        redirect={false}
        notice={null}
        scrollRef={{ current: null }}
      />,
    );
    expect(frame).toContain("find the release notes");
    expect(frame).toContain("Here they are.");
    expect(frame).toMatch(/✓ Searched the web/);
    expect(frame).not.toContain("SECRET REASONING");
    expect(frame).toContain("Message Wren");
  });

  it("draws machinery as one dim line and a reaction as a line, not as your message", async () => {
    const frame = await frameOf(
      <ChatPane
        snapshot={{
          ...EMPTY_SNAPSHOT,
          loaded: true,
          transcript: [
            { id: 1, kind: "input", at: 0, text: "[cron daily] check the feeds" },
            { id: 2, kind: "input", at: 1, text: "[task t1 finished]\n\nThree new posts." },
            { id: 3, kind: "input", at: 2, text: "thanks" },
            {
              id: 4,
              kind: "tool",
              at: 3,
              step: {
                callId: "r1",
                name: "react",
                status: "done",
                input: { reaction: "ok" },
                output: "",
                durationMs: 1,
                details: { target: 3, reaction: "ok" },
              },
            },
          ],
        }}
        bot="Wren"
        draft=""
        setDraft={() => undefined}
        submit={() => undefined}
        typing
        cardFocused={false}
        redirect={false}
        notice={null}
        scrollRef={{ current: null }}
      />,
      100,
    );
    expect(frame).toContain("· Routine ran: check the feeds");
    expect(frame).toContain("· Task finished: Three new posts.");
    expect(frame).toContain("· Wren reacted 👍 Got it");
    expect(frame.match(/you ·/g) ?? []).toHaveLength(1);
  });

  it("offers always-allow on an ordinary card and never on a floor", async () => {
    const plain = await frameOf(
      <ApprovalCard
        pending={{ callId: "x", name: "artifact_delete", input: { id: "f1" }, reason: null }}
        bot="Wren"
        focused
      />,
    );
    expect(plain).toContain("Wren wants to");
    expect(plain).toMatch(/a approve · d deny · A always allow/);
    const floor = await frameOf(
      <ApprovalCard
        pending={{ callId: "y", name: "secret_request", input: {}, reason: null }}
        bot="Wren"
        focused
      />,
    );
    expect(floor).not.toContain("always");
  });

  it("lists every waiting card by bot name in Needs you", async () => {
    const frame = await frameOf(
      <NeedsView
        approvals={[
          {
            conversationId: "c",
            profile: "b1",
            kind: "main",
            sessionId: "s",
            callId: "k",
            name: "artifact_delete",
            input: {},
            reason: null,
          },
        ]}
        failed={[]}
        bots={[bot]}
        selected={0}
        notice={null}
      />,
    );
    expect(frame).toContain("Wren wants to");
    expect(frame).toContain("enter open the chat");
  });
});

const key = (name: string, extra: Partial<KeyEvent> = {}): KeyEvent =>
  ({ name, ctrl: false, shift: false, meta: false, ...extra }) as KeyEvent;

const actions = (over: Partial<KeyActions> = {}): KeyActions => ({
  view: "chat",
  overlay: false,
  cardFocused: false,
  hasCard: false,
  working: false,
  quit: vi.fn(),
  toggleView: vi.fn(),
  openPicker: vi.fn(),
  openChats: vi.fn(),
  closeOverlay: vi.fn(),
  complete: vi.fn(() => false),
  newChat: vi.fn(),
  scroll: vi.fn(),
  stop: vi.fn(),
  focusCard: vi.fn(),
  decide: vi.fn(),
  toggleRedirect: vi.fn(),
  retryQueued: vi.fn(),
  needsMove: vi.fn(),
  needsDecide: vi.fn(),
  needsOpen: vi.fn(),
  ...over,
});

describe("dispatchKey", () => {
  it("never decides a card from letters typed into the composer", () => {
    const act = actions({ hasCard: true });
    expect(dispatchKey(key("a"), act)).toBe(false);
    expect(act.decide).not.toHaveBeenCalled();
  });

  it("a focused card takes a / A / d and swallows everything else", () => {
    const act = actions({ hasCard: true, cardFocused: true });
    dispatchKey(key("a"), act);
    dispatchKey(key("a", { shift: true }), act);
    dispatchKey(key("d"), act);
    expect(act.decide).toHaveBeenNthCalledWith(1, true, undefined);
    expect(act.decide).toHaveBeenNthCalledWith(2, true, true);
    expect(act.decide).toHaveBeenNthCalledWith(3, false, undefined);
    expect(dispatchKey(key("x"), act)).toBe(true);
  });

  it("esc answers a waiting card first, else stops a working reply", () => {
    const carded = actions({ hasCard: true, working: true });
    dispatchKey(key("escape"), carded);
    expect(carded.focusCard).toHaveBeenCalledWith(true);
    expect(carded.stop).not.toHaveBeenCalled();
    const working = actions({ working: true });
    dispatchKey(key("escape"), working);
    expect(working.stop).toHaveBeenCalled();
  });

  it("ctrl-c always quits, even with the picker open; esc closes it; the rest is the picker's", () => {
    const act = actions({ overlay: true });
    expect(dispatchKey(key("down"), act)).toBe(false);
    expect(dispatchKey(key("a"), act)).toBe(false);
    dispatchKey(key("escape"), act);
    expect(act.closeOverlay).toHaveBeenCalled();
    dispatchKey(key("c", { ctrl: true }), act);
    expect(act.quit).toHaveBeenCalled();
  });

  it("tab completes a half-typed /command before it switches to Needs you", () => {
    const completing = actions({ complete: vi.fn(() => true) });
    dispatchKey(key("tab"), completing);
    expect(completing.toggleView).not.toHaveBeenCalled();
    const plain = actions();
    dispatchKey(key("tab"), plain);
    expect(plain.toggleView).toHaveBeenCalled();
    const chats = actions();
    dispatchKey(key("o", { ctrl: true }), chats);
    expect(chats.openChats).toHaveBeenCalled();
  });

  it("Needs you: arrows choose, letters decide, enter opens", () => {
    const act = actions({ view: "needs" });
    dispatchKey(key("down"), act);
    dispatchKey(key("a"), act);
    dispatchKey(key("return"), act);
    expect(act.needsMove).toHaveBeenCalledWith(1);
    expect(act.needsDecide).toHaveBeenCalledWith(true, undefined);
    expect(act.needsOpen).toHaveBeenCalled();
  });
});
