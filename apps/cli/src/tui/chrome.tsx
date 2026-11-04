/**
 * The frame around the chat: a header (bot · what it is doing · the link),
 * the crew roster on wide terminals (the web's sidebar), the bot picker
 * (ctrl-k) and the key line at the bottom. Plain product words only:
 * connected / connecting / disconnected, working, Needs you.
 */
import type { SelectOption } from "@opentui/core";
import type { Phase, ProfileInfo } from "@spriessen/contracts";
import type { LinkState } from "./use-chat.ts";
import { THEME } from "./theme.ts";

export const Header = ({
  bot,
  phase,
  link,
  needs,
  view,
}: {
  bot: string;
  phase: Phase;
  link: LinkState;
  needs: number;
  view: "chat" | "needs";
}) => (
  <box
    flexDirection="row"
    justifyContent="space-between"
    paddingLeft={1}
    paddingRight={1}
    flexShrink={0}
  >
    <text>
      <span fg={THEME.live}>
        <strong>Spriessen</strong>
      </span>
      <span fg={THEME.faint}> · </span>
      <span fg={view === "chat" ? THEME.ink : THEME.muted}>{bot}</span>
      {phase === "working" ? <span fg={THEME.live}> · working…</span> : null}
      {phase === "error" ? <span fg={THEME.signal}> · stopped on an error</span> : null}
    </text>
    <text>
      <span fg={needs > 0 ? THEME.signal : THEME.faint}>
        {view === "needs" ? "▸ " : ""}Needs you {needs}
      </span>
      <span fg={THEME.faint}> · </span>
      <span
        fg={link === "connected" ? THEME.ok : link === "connecting" ? THEME.live : THEME.signal}
      >
        {link}
      </span>
    </text>
  </box>
);

export const Roster = ({
  bots,
  current,
  mainId,
}: {
  bots: readonly ProfileInfo[];
  current: string | undefined;
  mainId: string | null;
}) => (
  <box
    width={24}
    flexShrink={0}
    flexDirection="column"
    paddingLeft={1}
    border={["right"]}
    borderColor={THEME.rule}
  >
    <text fg={THEME.faint}>Crew</text>
    {bots.map((bot) => (
      <text key={bot.id} fg={bot.id === current ? THEME.ink : THEME.muted}>
        {bot.id === current ? "▸ " : "  "}
        {bot.name}
        {bot.id === mainId ? " ·" : ""}
      </text>
    ))}
  </box>
);

export const BotPicker = ({
  bots,
  current,
  onPick,
}: {
  bots: readonly ProfileInfo[];
  current: string | undefined;
  onPick: (bot: ProfileInfo) => void;
}) => {
  const options: SelectOption[] = bots.map((bot) => ({
    name: bot.name,
    description: bot.description.slice(0, 70),
    value: bot.id,
  }));
  const index = Math.max(
    0,
    bots.findIndex((bot) => bot.id === current),
  );
  return (
    <box
      position="absolute"
      top={2}
      left={4}
      width={60}
      height={Math.min(bots.length * 2 + 2, 20)}
      border
      borderStyle="rounded"
      borderColor={THEME.live}
      backgroundColor={THEME.raised}
      title=" Talk to "
    >
      <select
        focused
        flexGrow={1}
        options={options}
        selectedIndex={index}
        backgroundColor={THEME.raised}
        onSelect={(picked) => {
          const bot = bots[picked];
          if (bot !== undefined) onPick(bot);
        }}
      />
    </box>
  );
};

export const KeyLine = ({ hints }: { hints: readonly string[] }) => (
  <box paddingLeft={1} flexShrink={0}>
    <text fg={THEME.faint}>{hints.join(" · ")}</text>
  </box>
);
