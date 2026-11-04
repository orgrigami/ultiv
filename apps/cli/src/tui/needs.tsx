/**
 * Needs you, in the terminal: every card waiting across the crew and every
 * failed task, newest first. ↑/↓ choose a card; a approve · d deny ·
 * A always allow · enter opens its chat. Decisions go through the same REST
 * route the web's inbox uses, so the card leaves every client at once.
 */
import type { ProfileInfo, TaskRow } from "@spriessen/contracts";
import type { ApprovalRow } from "../client/http.ts";
import { cardWords } from "../render/words.ts";
import { THEME } from "./theme.ts";

export const NeedsView = ({
  approvals,
  failed,
  bots,
  selected,
  notice,
}: {
  approvals: readonly ApprovalRow[];
  failed: readonly TaskRow[];
  bots: readonly ProfileInfo[];
  selected: number;
  notice: string | null;
}) => {
  const nameOf = (id: string): string => bots.find((bot) => bot.id === id)?.name ?? id;
  if (approvals.length === 0 && failed.length === 0) {
    return (
      <box flexGrow={1} paddingLeft={1}>
        <text fg={THEME.faint}>Nothing needs you.</text>
        {notice !== null ? <text fg={THEME.muted}>{notice}</text> : null}
      </box>
    );
  }
  return (
    <scrollbox flexGrow={1} paddingLeft={1} paddingRight={1}>
      {approvals.map((row, index) => {
        const words = cardWords(row);
        const active = index === selected;
        return (
          <box
            key={`${row.conversationId}:${row.callId}`}
            border
            borderStyle="rounded"
            borderColor={active ? THEME.signal : THEME.rule}
            paddingLeft={1}
            flexDirection="column"
          >
            <text fg={THEME.ink}>
              {nameOf(row.profile)} wants to {words.action}
            </text>
            {words.hint !== null ? <text fg={THEME.muted}>{words.hint}</text> : null}
            {active ? (
              <text fg={THEME.faint}>
                a approve · d deny
                {words.always !== null ? ` · A ${words.always.toLocaleLowerCase("en")}` : ""}
                {row.sessionId !== null ? " · enter open the chat" : ""}
              </text>
            ) : null}
          </box>
        );
      })}
      {failed.map((task) => (
        <box key={task.id} paddingLeft={1}>
          <text>
            <span fg={THEME.signal}>✗ </span>
            <span fg={THEME.muted}>
              {task.bot !== undefined ? `${nameOf(task.bot.profileId)}'s task` : "A task"} failed
              {` (${task.title ?? task.prompt.slice(0, 40)}): `}
              {task.error ?? "no reason given"}
            </span>
          </text>
        </box>
      ))}
      {notice !== null ? <text fg={THEME.muted}>{notice}</text> : null}
    </scrollbox>
  );
};
