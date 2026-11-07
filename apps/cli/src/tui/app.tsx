/**
 * The terminal UI: the chat with the current bot (the web's `/`), Needs you
 * (tab), the pickers for bots (ctrl-k), this bot's chats (ctrl-o) and
 * models (/model), the help panel (/help) and, on terminals ≥ 100 columns,
 * the crew roster beside the chat. State lives here; the views are dumb;
 * every key is in use-keys.ts, every slash command in use-slash.ts.
 */
import type { ScrollBoxRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Api } from "../client/http.ts";
import type { Live } from "../client/live.ts";
import { sentenceOf } from "../errors.ts";
import { ChatPane } from "./chat-pane.tsx";
import { Header, KeyLine, Roster } from "./chrome.tsx";
import { HelpOverlay } from "./help-overlay.tsx";
import { NeedsView } from "./needs.tsx";
import { BotPicker, ChatPicker, ModelPicker } from "./pickers.tsx";
import { completeSlash, messageOf as slashText, parseSlash, type Slash } from "./slash.ts";
import { THEME } from "./theme.ts";
import { useBotChat, type BotChat, type Wanted } from "./use-bot-chat.ts";
import { useChat, type Chat } from "./use-chat.ts";
import { useCrew, type Crew } from "./use-crew.ts";
import { useKeys, type KeyActions } from "./use-keys.ts";
import { useSlash, type Overlay } from "./use-slash.ts";

const CHAT_KEYS = [
  "enter send",
  "/help keys & commands",
  "tab Needs you",
  "ctrl-k bots",
  "ctrl-o chats",
  "esc stop",
  "ctrl-c quit",
  "ctrl-n new chat",
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
  const complete = (): boolean => {
    const done = completeSlash(draft);
    if (done === undefined || done === draft) return done !== undefined;
    setDraft(done);
    return true;
  };
  return { draft, setDraft, redirect, setRedirect, cardFocused, setCardFocused, submit, complete };
};

/** The notice line and the one way every action reports into it. */
const useNotice = (server: string) => {
  const [notice, setNotice] = useState<string | null>(null);
  const fail = useCallback(
    (cause: unknown) => setNotice(sentenceOf(cause, server).replace(/\n/g, " ")),
    [server],
  );
  const report: Report = (work, done) => {
    work.then(() => setNotice(done ?? null), fail);
  };
  return { notice, setNotice, fail, report };
};

export const App = ({ api, live, wanted }: { api: Api; live: Live; wanted: Wanted }) => {
  const renderer = useRenderer();
  const crew = useCrew(api, live);
  const { notice, setNotice, fail, report } = useNotice(api.server);
  const botChat = useBotChat(api, crew, wanted, fail);
  const chat = useChat(api.server, api.cookie ?? "", botChat.chatId);
  const [view, setView] = useState<"chat" | "needs">("chat");
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [selected, setSelected] = useState(0);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  // The composer hands slash commands to the runner, which needs the draft.
  const slashRef = useRef<(slash: Slash) => void>(() => undefined);
  const composer = useComposer(chat, report, (slash) => slashRef.current(slash));
  slashRef.current = useSlash({
    api,
    chat,
    crew,
    ...botChat,
    setDraft: composer.setDraft,
    notice: setNotice,
    report,
    openOverlay: setOverlay,
    copy: (text) => renderer.copyToClipboardOSC52(text),
  });
  const openChat = (bot: string, id: string): void => {
    botChat.openChat(bot, id);
    setView("chat");
  };
  useKeys({
    view,
    overlay: overlay !== null,
    cardFocused: composer.cardFocused,
    hasCard: chat.snapshot.pending !== null,
    working: chat.snapshot.phase === "working",
    quit: () => renderer.destroy(),
    toggleView: () => setView((current) => (current === "chat" ? "needs" : "chat")),
    openPicker: () => setOverlay("bots"),
    openChats: () => setOverlay(botChat.botId !== undefined ? "chats" : null),
    closeOverlay: () => setOverlay(null),
    newChat: botChat.newChat,
    scroll: (pages) => scrollRef.current?.scrollBy(pages * Math.max(5, renderer.height - 8)),
    stop: () => report(chat.stop(), "Stopped."),
    focusCard: composer.setCardFocused,
    decide: (approved, always) =>
      report(chat.decide(approved, always), approved ? "Approved." : "Denied."),
    toggleRedirect: () => composer.setRedirect((on) => !on),
    retryQueued: () => report(chat.retryQueued()),
    complete: composer.complete,
    ...needsKeys(api, crew, selected, setSelected, report, openChat),
  });
  const botName = crew.bots.find((candidate) => candidate.id === botChat.botId)?.name ?? "…";
  const pane =
    crew.loaded && crew.bots.length === 0 ? (
      <NoBots />
    ) : view === "chat" ? (
      <ChatPane
        snapshot={chat.snapshot}
        bot={botName}
        draft={composer.draft}
        setDraft={composer.setDraft}
        submit={composer.submit}
        typing={overlay === null && !composer.cardFocused}
        cardFocused={composer.cardFocused}
        redirect={composer.redirect}
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
  const floating = (
    <Floating
      overlay={overlay}
      api={api}
      crew={crew}
      botChat={botChat}
      chat={chat}
      close={() => setOverlay(null)}
      openChat={openChat}
      report={report}
      fail={fail}
    />
  );
  return (
    <Screen crew={crew} botId={botChat.botId} chat={chat} view={view} pane={pane}>
      {floating}
    </Screen>
  );
};

/** Whatever floats over the chat: one picker or the help panel. */
const Floating = ({
  overlay,
  api,
  crew,
  botChat,
  chat,
  close,
  openChat,
  report,
  fail,
}: {
  overlay: Overlay | null;
  api: Api;
  crew: Crew;
  botChat: BotChat;
  chat: Chat;
  close: () => void;
  openChat: (bot: string, chat: string) => void;
  report: Report;
  fail: (cause: unknown) => void;
}) => {
  switch (overlay) {
    case null:
      return null;
    case "help":
      return <HelpOverlay />;
    case "bots":
      return (
        <BotPicker
          bots={crew.bots}
          current={botChat.botId}
          mainId={crew.mainId}
          onPick={(bot) => {
            close();
            botChat.setBotId(bot.id);
          }}
        />
      );
    case "chats":
      return botChat.botId === undefined ? null : (
        <ChatPicker
          api={api}
          botId={botChat.botId}
          current={botChat.chatId}
          onError={fail}
          onPick={(picked) => {
            close();
            openChat(picked.profile, picked.id);
          }}
        />
      );
    case "models":
      return (
        <ModelPicker
          api={api}
          current={chat.snapshot.model}
          onError={fail}
          onPick={(model) => {
            close();
            report(chat.configure(model), `This chat now runs on ${model.id}.`);
          }}
        />
      );
  }
};

/** A fresh install: say how to make the first bot instead of waiting forever. */
const NoBots = () => (
  <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingTop={1}>
    <text fg={THEME.ink}>There are no bots yet.</text>
    <text fg={THEME.muted}>Create the first one in another terminal, and it opens here:</text>
    <text fg={THEME.live}> spriessen bots new Wren --description "my right hand"</text>
    <text fg={THEME.muted}>or in the web app. ctrl-c quits.</text>
  </box>
);

/** The frame: header, roster (≥ 100 columns), the pane, the key line, anything floating on top. */
const Screen = ({
  crew,
  botId,
  chat,
  view,
  pane,
  children,
}: {
  crew: Crew;
  botId: string | undefined;
  chat: Chat;
  view: "chat" | "needs";
  pane: ReactNode;
  children: ReactNode;
}) => {
  const { width } = useTerminalDimensions();
  const name = crew.bots.find((bot) => bot.id === botId)?.name ?? "…";
  const waiting = new Set(crew.approvals.map((row) => row.profile));
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={THEME.ground}>
      <Header
        bot={name}
        phase={chat.snapshot.phase}
        link={chat.link}
        needs={crew.approvals.length + crew.failed.length}
        view={view}
        model={chat.snapshot.model}
        usage={chat.snapshot.usage}
        wide={width >= 90}
      />
      <box flexDirection="row" flexGrow={1}>
        {width >= 100 ? (
          <Roster bots={crew.bots} current={botId} mainId={crew.mainId} waiting={waiting} />
        ) : null}
        {pane}
      </box>
      <KeyLine hints={view === "needs" ? NEEDS_KEYS : CHAT_KEYS} width={width} />
      {children}
    </box>
  );
};
