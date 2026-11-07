/**
 * The terminal UI: the chat with the current bot (the web's `/`), Needs you
 * (tab), the bot picker (ctrl-k) and, on terminals ≥ 100 columns, the crew
 * roster beside the chat. State lives here; the views are dumb; every key is
 * in use-keys.ts.
 */
import type { ScrollBoxRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ProfileInfo } from "@spriessen/contracts";
import type { Api } from "../client/http.ts";
import type { Live } from "../client/live.ts";
import { ChatPane } from "./chat-pane.tsx";
import { BotPicker, Header, KeyLine, Roster } from "./chrome.tsx";
import { NeedsView } from "./needs.tsx";
import { THEME } from "./theme.ts";
import { useChat, type Chat } from "./use-chat.ts";
import { useCrew, type Crew } from "./use-crew.ts";
import { useKeys, type KeyActions } from "./use-keys.ts";
import { messageOf as slashText, parseSlash, type Slash } from "./slash.ts";
import { useSlash } from "./use-slash.ts";
import { sentenceOf } from "../errors.ts";

/** A failure as the one-line notice under the chat (the same words the commands print). */
const messageOf = (cause: unknown, server: string): string =>
  sentenceOf(cause, server).replace(/\n/g, " ");

/** Which bot and which of its chats are open; the main bot's main chat to start. */
const useBotChat = (
  api: Api,
  crew: Crew,
  wanted: string | undefined,
  onError: (text: string) => void,
) => {
  const [botId, setBotId] = useState<string | undefined>(undefined);
  const [chatId, setChatId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (botId !== undefined || crew.bots.length === 0) return;
    const needle = wanted?.toLocaleLowerCase("en");
    const pick =
      crew.bots.find((bot) => bot.id === wanted || bot.name.toLocaleLowerCase("en") === needle) ??
      crew.bots.find((bot) => bot.id === crew.mainId) ??
      crew.bots[0];
    if (pick !== undefined) setBotId(pick.id);
  }, [crew.bots, crew.mainId, botId, wanted]);
  useEffect(() => {
    if (botId === undefined) return;
    api.mainChat(botId).then(
      (chat) => setChatId(chat.id),
      (cause) => onError(messageOf(cause, api.server)),
    );
  }, [api, botId, onError]);
  const newChat = useCallback(() => {
    if (botId === undefined) return;
    api.createSession(botId).then(
      (made) => setChatId(made.id),
      (cause) => onError(messageOf(cause, api.server)),
    );
  }, [api, botId, onError]);
  const openChat = useCallback((bot: string, chat: string) => {
    setBotId(bot);
    setChatId(chat);
  }, []);
  return { botId, chatId, setBotId, newChat, openChat };
};

const CHAT_KEYS = [
  "enter send",
  "/help commands",
  "esc stop",
  "tab Needs you",
  "ctrl-k bots",
  "ctrl-n new chat",
  "pgup/pgdn scroll",
  "ctrl-c quit",
];
const NEEDS_KEYS = [
  "↑/↓ choose",
  "a approve",
  "d deny",
  "enter open chat",
  "tab back to chat",
  "ctrl-c quit",
];

type Report = (work: Promise<unknown>, done?: string) => void;

/** Needs you's keys: choose a card, decide it over REST, or open its chat. */
const needsKeys = (
  api: Api,
  crew: Crew,
  selected: number,
  setSelected: (update: (index: number) => number) => void,
  report: Report,
  open: (bot: string, chat: string) => void,
): Pick<KeyActions, "needsMove" | "needsDecide" | "needsOpen"> => ({
  needsMove: (delta) =>
    setSelected((index) => Math.max(0, Math.min(crew.approvals.length - 1, index + delta))),
  needsDecide: (approved, always) => {
    const row = crew.approvals[selected];
    if (row === undefined) return;
    report(
      api.decide(row, approved, always).then(crew.refresh),
      approved ? "Approved." : "Denied.",
    );
  },
  needsOpen: () => {
    const row = crew.approvals[selected];
    if (row?.sessionId != null) open(row.profile, row.sessionId);
  },
});

/** The composer: the draft, the armed redirect, and whether a card holds the keyboard. */
const useComposer = (chat: Chat, report: Report, onSlash: (slash: Slash) => void) => {
  const [draft, setDraft] = useState("");
  const [redirect, setRedirect] = useState(false);
  const [cardFocused, setCardFocused] = useState(false);
  const pendingId = chat.snapshot.pending?.callId;
  // A new card takes the keyboard unless the owner is mid-sentence.
  useEffect(() => setCardFocused(pendingId !== undefined && draft === ""), [pendingId]);
  const submit = (text: string): void => {
    if (text.trim() === "") return;
    const slash = parseSlash(text);
    setDraft("");
    if (slash !== null) return onSlash(slash);
    const working = chat.snapshot.phase === "working";
    setRedirect(false);
    report(chat.send(slashText(text), working ? (redirect ? "redirect" : "steer") : undefined));
  };
  return { draft, setDraft, redirect, setRedirect, cardFocused, setCardFocused, submit };
};

export const App = ({
  api,
  live,
  wanted,
}: {
  api: Api;
  live: Live;
  wanted?: string | undefined;
}) => {
  const renderer = useRenderer();
  const crew = useCrew(api, live);
  const [notice, setNotice] = useState<string | null>(null);
  const { botId, chatId, setBotId, newChat, openChat } = useBotChat(api, crew, wanted, setNotice);
  const chat = useChat(api.server, api.cookie ?? "", chatId);
  const [view, setView] = useState<"chat" | "needs">("chat");
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState(0);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const pendingId = chat.snapshot.pending?.callId;
  const working = chat.snapshot.phase === "working";
  const report: Report = (work, done) => {
    work.then(
      () => setNotice(done ?? null),
      (cause) => setNotice(messageOf(cause, api.server)),
    );
  };
  // The composer hands slash commands to the runner, which needs the draft.
  const slashRef = useRef<(slash: Slash) => void>(() => undefined);
  const { draft, setDraft, redirect, setRedirect, cardFocused, setCardFocused, submit } =
    useComposer(chat, report, (slash) => slashRef.current(slash));
  slashRef.current = useSlash({
    api,
    chat,
    crew,
    botId,
    chatId,
    setBotId,
    newChat,
    openChat,
    setDraft,
    notice: setNotice,
    report,
  });
  useKeys({
    view,
    picking,
    cardFocused,
    hasCard: pendingId !== undefined,
    working,
    quit: () => renderer.destroy(),
    toggleView: () => setView((current) => (current === "chat" ? "needs" : "chat")),
    openPicker: () => setPicking(true),
    closePicker: () => setPicking(false),
    newChat,
    scroll: (pages) => scrollRef.current?.scrollBy(pages * Math.max(5, renderer.height - 8)),
    stop: () => report(chat.stop(), "Stopped."),
    focusCard: setCardFocused,
    decide: (approved, always) =>
      report(chat.decide(approved, always), approved ? "Approved." : "Denied."),
    toggleRedirect: () => setRedirect((on) => !on),
    retryQueued: () => report(chat.retryQueued()),
    ...needsKeys(api, crew, selected, setSelected, report, (bot, id) => {
      openChat(bot, id);
      setView("chat");
    }),
  });
  const pane =
    view === "chat" ? (
      <ChatPane
        snapshot={chat.snapshot}
        bot={crew.bots.find((candidate) => candidate.id === botId)?.name ?? "…"}
        draft={draft}
        setDraft={setDraft}
        submit={submit}
        typing={!picking && !cardFocused}
        cardFocused={cardFocused}
        redirect={redirect}
        notice={notice ?? crew.error}
        scrollRef={scrollRef}
      />
    ) : (
      <NeedsView
        approvals={crew.approvals}
        failed={crew.failed}
        bots={crew.bots}
        selected={selected}
        notice={notice}
      />
    );
  const pick = (picked: ProfileInfo): void => {
    setPicking(false);
    setView("chat");
    setBotId(picked.id);
  };
  return (
    <Screen
      crew={crew}
      botId={botId}
      chat={chat}
      view={view}
      pane={pane}
      picking={picking}
      onPick={pick}
    />
  );
};

/** The frame: header, roster (≥ 100 columns), the pane, the key line, the picker on top. */
const Screen = ({
  crew,
  botId,
  chat,
  view,
  pane,
  picking,
  onPick,
}: {
  crew: Crew;
  botId: string | undefined;
  chat: Chat;
  view: "chat" | "needs";
  pane: ReactNode;
  picking: boolean;
  onPick: (bot: ProfileInfo) => void;
}) => {
  const { width } = useTerminalDimensions();
  const name = crew.bots.find((bot) => bot.id === botId)?.name ?? "…";
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={THEME.ground}>
      <Header
        bot={name}
        phase={chat.snapshot.phase}
        link={chat.link}
        needs={crew.approvals.length + crew.failed.length}
        view={view}
      />
      <box flexDirection="row" flexGrow={1}>
        {width >= 100 ? <Roster bots={crew.bots} current={botId} mainId={crew.mainId} /> : null}
        {pane}
      </box>
      <KeyLine hints={view === "needs" ? NEEDS_KEYS : CHAT_KEYS} />
      {picking ? <BotPicker bots={crew.bots} current={botId} onPick={onPick} /> : null}
    </box>
  );
};
