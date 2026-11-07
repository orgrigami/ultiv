/**
 * The chat as the web draws it, in cells: the owner's messages on a quiet
 * raised block, the bot's prose on the ground (no bubble), tool calls as one
 * owner-worded row each (the shared lens: present tense while running, a ✗
 * and the error sentence when one failed), notes dim. Thinking stays out,
 * as it does in the web's default view. The scrollbox sticks to the bottom
 * while new lines arrive; PageUp/PageDown scroll it (app.tsx).
 */
import type { ScrollBoxRenderable } from "@opentui/core";
import {
  REACTION_EMOJI,
  REACTION_LABEL,
  REACTIONS_TOOL,
  reactionDetailsOf,
  type TranscriptEntry,
} from "@spriessen/contracts";
import type { Ref } from "react";
import { toolLine } from "../render/words.ts";
import { THEME } from "./theme.ts";

const time = (at: number): string => new Date(at).toTimeString().slice(0, 5);

const ToolRow = ({ entry }: { entry: Extract<TranscriptEntry, { kind: "tool" }> }) => {
  const line = toolLine(entry.step);
  if (line === null) return null;
  const mark = line.status === "error" ? "✗" : line.status === "running" ? "…" : "✓";
  const color =
    line.status === "error" ? THEME.signal : line.status === "running" ? THEME.live : THEME.faint;
  return (
    <box flexDirection="column" paddingLeft={2}>
      <text>
        <span fg={color}>{mark} </span>
        <span fg={THEME.muted}>{line.title}</span>
        {line.detail !== null ? <span fg={THEME.faint}> — {line.detail}</span> : null}
      </text>
      {line.error !== null ? (
        <text fg={THEME.signal} paddingLeft={2}>
          {line.error}
        </text>
      ) : null}
    </box>
  );
};

/** A bot's reaction on the owner's message (the web draws it as a chip on the bubble). */
const Reaction = ({
  entry,
  bot,
}: {
  entry: Extract<TranscriptEntry, { kind: "tool" }>;
  bot: string;
}) => {
  const details = reactionDetailsOf(entry.step.details);
  if (details === undefined) return null;
  return (
    <box paddingLeft={1}>
      <text fg={THEME.faint}>
        {bot} reacted {REACTION_EMOJI[details.reaction]} {REACTION_LABEL[details.reaction]}
      </text>
    </box>
  );
};

export const Entry = ({ entry, bot }: { entry: TranscriptEntry; bot: string }) => {
  switch (entry.kind) {
    case "input":
      return (
        <box backgroundColor={THEME.raised} paddingLeft={1} paddingRight={1} marginTop={1}>
          <text fg={THEME.faint}>you · {time(entry.at)}</text>
          <text fg={THEME.owner}>{entry.text}</text>
          {(entry.attachments ?? []).length > 0 ? (
            <text fg={THEME.faint}>
              {(entry.attachments ?? []).map((file) => `[${file.name}]`).join(" ")}
            </text>
          ) : null}
        </box>
      );
    case "output":
      return (
        <box flexDirection="column" marginTop={1} paddingLeft={1}>
          <text fg={THEME.faint}>
            {bot}
            {entry.streaming ? " · writing…" : ""}
            {entry.interrupted === true ? " · cut short" : ""}
          </text>
          <text fg={THEME.ink}>{entry.text}</text>
        </box>
      );
    case "note":
      return (
        <box paddingLeft={1}>
          <text fg={THEME.faint}>· {entry.text}</text>
        </box>
      );
    case "tool":
      return entry.step.name === REACTIONS_TOOL && entry.step.status === "done" ? (
        <Reaction entry={entry} bot={bot} />
      ) : (
        <ToolRow entry={entry} />
      );
    case "thinking":
      return null;
  }
};

export const Transcript = ({
  entries,
  bot,
  loaded,
  scrollRef,
}: {
  entries: readonly TranscriptEntry[];
  bot: string;
  loaded: boolean;
  scrollRef: Ref<ScrollBoxRenderable>;
}) => (
  <scrollbox ref={scrollRef} flexGrow={1} stickyScroll stickyStart="bottom" paddingRight={1}>
    {!loaded ? (
      <text fg={THEME.faint}>Loading the chat…</text>
    ) : entries.length === 0 ? (
      <text fg={THEME.faint}>A new chat with {bot}. Say something below.</text>
    ) : (
      entries.map((entry) => <Entry key={entry.id} entry={entry} bot={bot} />)
    )}
  </scrollbox>
);
