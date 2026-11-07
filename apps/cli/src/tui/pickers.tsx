/**
 * The pickers that float over the chat: bots (ctrl-k, /bot), this bot's
 * chats (ctrl-o, /chats) and models (/model). One frame for all three —
 * ↑/↓ choose, enter opens, esc closes (use-keys.ts) — and the chat and model
 * lists load when the picker opens, so they are never stale.
 */
import type { SelectOption } from "@opentui/core";
import { useEffect, useState } from "react";
import type { ModelInfo, ProfileInfo, SessionInfo } from "@spriessen/contracts";
import type { Api } from "../client/http.ts";
import { ago, clip, shortId } from "../render/out.ts";
import { THEME } from "./theme.ts";

const Picker = ({
  title,
  options,
  index,
  onPick,
  empty,
}: {
  title: string;
  options: readonly SelectOption[] | undefined;
  index: number;
  onPick: (index: number) => void;
  empty: string;
}) => (
  <box
    position="absolute"
    top={2}
    left={4}
    width={66}
    height={Math.min(Math.max((options?.length ?? 1) * 2 + 3, 5), 22)}
    border
    borderStyle="rounded"
    borderColor={THEME.live}
    backgroundColor={THEME.raised}
    title={` ${title} `}
    flexDirection="column"
  >
    {options === undefined ? (
      <text fg={THEME.faint}>Loading…</text>
    ) : options.length === 0 ? (
      <text fg={THEME.faint}>{empty}</text>
    ) : (
      <select
        focused
        flexGrow={1}
        options={[...options]}
        selectedIndex={Math.max(0, index)}
        backgroundColor={THEME.raised}
        showScrollIndicator
        onSelect={(picked) => onPick(picked)}
      />
    )}
    <text fg={THEME.faint}>↑/↓ choose · enter open · esc close</text>
  </box>
);

export const BotPicker = ({
  bots,
  current,
  mainId,
  onPick,
}: {
  bots: readonly ProfileInfo[];
  current: string | undefined;
  mainId: string | null;
  onPick: (bot: ProfileInfo) => void;
}) => (
  <Picker
    title="Talk to"
    options={bots.map((bot) => ({
      name: `${bot.name}${bot.id === mainId ? "  (main)" : ""}`,
      description: clip(bot.description, 60),
      value: bot.id,
    }))}
    index={bots.findIndex((bot) => bot.id === current)}
    onPick={(index) => {
      const bot = bots[index];
      if (bot !== undefined) onPick(bot);
    }}
    empty="No bots yet: spriessen bots new <name>"
  />
);

/** The chats a person opens: the bot's main chat and its other chats, newest first. */
export const chatsOf = (rows: readonly SessionInfo[], botId: string): SessionInfo[] =>
  rows
    .filter((row) => row.profile === botId && (row.kind === "main" || row.kind === "session"))
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt);

export const ChatPicker = ({
  api,
  botId,
  current,
  onPick,
  onError,
}: {
  api: Api;
  botId: string;
  current: string | undefined;
  onPick: (chat: SessionInfo) => void;
  onError: (cause: unknown) => void;
}) => {
  const [chats, setChats] = useState<SessionInfo[] | undefined>(undefined);
  useEffect(() => {
    api.sessions(botId).then((rows) => setChats(chatsOf(rows, botId)), onError);
  }, [api, botId, onError]);
  return (
    <Picker
      title="Chats"
      options={chats?.map((chat) => ({
        name: `${clip(chat.title || "New chat", 48)}${chat.kind === "main" ? "  (main)" : ""}`,
        description: `${ago(chat.lastMessageAt)} · ${shortId(chat.id)}`,
        value: chat.id,
      }))}
      index={chats?.findIndex((chat) => chat.id === current) ?? 0}
      onPick={(index) => {
        const chat = chats?.[index];
        if (chat !== undefined) onPick(chat);
      }}
      empty="No chats yet."
    />
  );
};

export const ModelPicker = ({
  api,
  current,
  onPick,
  onError,
}: {
  api: Api;
  current: string | null;
  onPick: (model: ModelInfo) => void;
  onError: (cause: unknown) => void;
}) => {
  const [models, setModels] = useState<ModelInfo[] | undefined>(undefined);
  useEffect(() => {
    api.models().then((payload) => setModels(payload.models), onError);
  }, [api, onError]);
  return (
    <Picker
      title="Model for this chat"
      options={models?.map((model) => ({
        name: model.id,
        description: `${model.providerName}${model.efforts.length > 0 ? ` · effort ${model.defaultEffort}` : ""}${model.input.includes("image") ? " · images" : ""}`,
        value: model.id,
      }))}
      index={models?.findIndex((model) => model.id === current) ?? 0}
      onPick={(index) => {
        const model = models?.[index];
        if (model !== undefined) onPick(model);
      }}
      empty="No models: set a provider key (spriessen doctor)."
    />
  );
};
