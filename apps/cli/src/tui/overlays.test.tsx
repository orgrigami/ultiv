/**
 * The pieces that float over the chat, rendered headless: the help panel
 * lists keys and commands from the tables that run them, the chat picker
 * lists this bot's chats newest first (never another bot's, never bot
 * talks), and a half-typed /command shows what it could be.
 */
import { testRender } from "@opentui/react/test-utils";
import type { SessionInfo } from "@spriessen/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { Api } from "../client/http.ts";
import { EMPTY_SNAPSHOT } from "../client/session.ts";
import { ChatPane } from "./chat-pane.tsx";
import { HelpOverlay } from "./help-overlay.tsx";
import { chatsOf, ChatPicker } from "./pickers.tsx";

const frameOf = async (node: React.ReactNode, width = 90, height = 40): Promise<string> => {
  const setup = await testRender(node, { width, height });
  await setup.renderOnce();
  // Let a picker's list load, then draw again.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  setup.renderer.destroy();
  return frame;
};

const row = (id: string, profile: string, kind: SessionInfo["kind"], at: number, title: string) =>
  ({ id, profile, kind, title, lastMessageAt: at, createdAt: 0 }) as SessionInfo;

const rows = [
  row("main-aaaa1111", "b1", "main", 10, "Wren"),
  row("bbbb2222", "b1", "session", 30, "Trip to Bali"),
  row("cccc3333", "b2", "session", 40, "Someone else's"),
  row("dddd4444", "b1", "dm", 50, "bot talk"),
];

describe("the overlays", () => {
  it("help lists the keys and the slash commands", async () => {
    const frame = await frameOf(<HelpOverlay />);
    expect(frame).toContain("ctrl-o");
    expect(frame).toContain("/model [id]");
    expect(frame).toContain("/copy");
  });

  it("the chat picker shows this bot's chats, newest first", async () => {
    expect(chatsOf(rows, "b1").map((chat) => chat.id)).toEqual(["bbbb2222", "main-aaaa1111"]);
    const api = { sessions: async () => rows } as unknown as Api;
    const frame = await frameOf(
      <ChatPicker
        api={api}
        botId="b1"
        current="bbbb2222"
        onPick={() => undefined}
        onError={() => undefined}
      />,
    );
    expect(frame).toContain("Trip to Bali");
    expect(frame).toContain("(main)");
    expect(frame).not.toContain("Someone else's");
  });

  it("a half-typed /command shows what it could be", async () => {
    const frame = await frameOf(
      <ChatPane
        snapshot={{ ...EMPTY_SNAPSHOT, loaded: true }}
        bot="Wren"
        draft="/mo"
        setDraft={() => undefined}
        submit={() => undefined}
        typing
        cardFocused={false}
        redirect={false}
        notice={null}
        scrollRef={{ current: null }}
      />,
    );
    expect(frame).toContain("/model this chat's model");
  });
});
