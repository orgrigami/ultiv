/**
 * The frame around the chat: a header (bot · what it is doing · the chat's
 * model and tokens · Needs you · the link), the crew roster on wide
 * terminals (the web's sidebar; a bot with a card waiting is marked) and
 * the key line at the bottom. Plain product words only: connected /
 * connecting / disconnected, working, Needs you.
 */
import type { Phase, ProfileInfo, UsageSummary } from "@spriessen/contracts";
import type { LinkState } from "./use-chat.ts";
import { THEME } from "./theme.ts";

/** 12345 → "12.3k". */
export const tokens = (n: number): string =>
  n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(1)}M`;

/** `provider/model` → the model part, which is what people recognise. */
const modelName = (ref: string): string => ref.slice(ref.indexOf("/") + 1);

export const Header = ({
  bot,
  phase,
  link,
  needs,
  view,
  model,
  usage,
  wide,
}: {
  bot: string;
  phase: Phase;
  link: LinkState;
  needs: number;
  view: "chat" | "needs";
  model: string | null;
  usage: UsageSummary | null;
  wide: boolean;
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
      {wide && model !== null ? <span fg={THEME.faint}> · {modelName(model)}</span> : null}
      {wide && usage !== null && usage.totalTokens > 0 ? (
        <span fg={THEME.faint}> · {tokens(usage.totalTokens)} tokens</span>
      ) : null}
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
  waiting,
}: {
  bots: readonly ProfileInfo[];
  current: string | undefined;
  mainId: string | null;
  /** Bot ids with a card waiting. */
  waiting: ReadonlySet<string>;
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
      <text key={bot.id}>
        <span fg={bot.id === current ? THEME.ink : THEME.muted}>
          {bot.id === current ? "▸ " : "  "}
          {bot.name}
        </span>
        {bot.id === mainId ? <span fg={THEME.faint}> ·</span> : null}
        {waiting.has(bot.id) ? <span fg={THEME.signal}> ●</span> : null}
      </text>
    ))}
    <text fg={THEME.faint}> </text>
    <text fg={THEME.faint}>ctrl-k switch</text>
  </box>
);

/** As many hints as fit on one line, in order of use (the rest are in /help). */
export const fitHints = (hints: readonly string[], width: number): string => {
  let line = "";
  for (const hint of hints) {
    const next = line === "" ? hint : `${line} · ${hint}`;
    if (next.length > width) break;
    line = next;
  }
  return line;
};

export const KeyLine = ({ hints, width }: { hints: readonly string[]; width: number }) => (
  <box paddingLeft={1} flexShrink={0}>
    <text fg={THEME.faint}>{fitHints(hints, width - 2)}</text>
  </box>
);
