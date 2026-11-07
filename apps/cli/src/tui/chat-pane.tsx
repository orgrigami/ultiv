/**
 * The chat column: transcript, the waiting card, the "Not sent" line for a
 * queue a failed run left behind (D3: never sent by itself — ctrl-t sends
 * it), the error sentence, and the composer. Enter sends; while the bot
 * works a message steers the running turn, or redirects it when ctrl-r
 * armed that. A half-typed /command shows what it could be (tab completes).
 */
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useRef, type Ref } from "react";
import type { SessionSnapshot } from "../client/session.ts";
import { ApprovalCard } from "./card.tsx";
import { slashMatches } from "./slash.ts";
import { THEME } from "./theme.ts";
import { Transcript } from "./transcript.tsx";

export const ChatPane = ({
  snapshot,
  bot,
  draft,
  setDraft,
  submit,
  typing,
  cardFocused,
  redirect,
  notice,
  scrollRef,
}: {
  snapshot: SessionSnapshot;
  bot: string;
  draft: string;
  setDraft: (text: string) => void;
  submit: (text: string) => void;
  typing: boolean;
  cardFocused: boolean;
  redirect: boolean;
  notice: string | null;
  scrollRef: Ref<ScrollBoxRenderable>;
}) => {
  const inputRef = useRef<InputRenderable>(null);
  const working = snapshot.phase === "working";
  const stranded = snapshot.queued.length > 0 && !working;
  const placeholder = working
    ? redirect
      ? `Redirect ${bot}: stop and answer this instead`
      : `Steer ${bot} while it works (ctrl-r: redirect instead)`
    : `Message ${bot}`;
  return (
    <box flexDirection="column" flexGrow={1}>
      <Transcript
        entries={snapshot.transcript}
        bot={bot}
        loaded={snapshot.loaded}
        scrollRef={scrollRef}
      />
      {snapshot.pending !== null ? (
        <ApprovalCard pending={snapshot.pending} bot={bot} focused={cardFocused} />
      ) : null}
      {stranded ? (
        <text fg={THEME.live}>
          Not sent: {snapshot.queued.length} queued message(s) · ctrl-t send them now
        </text>
      ) : null}
      {snapshot.lastError !== null && !working ? (
        <text fg={THEME.signal}>{snapshot.lastError}</text>
      ) : null}
      {notice !== null ? <text fg={THEME.muted}>{notice}</text> : null}
      <SlashHints draft={draft} />
      <box
        border
        borderStyle="rounded"
        borderColor={typing ? (redirect && working ? THEME.signal : THEME.live) : THEME.rule}
        height={3}
        flexShrink={0}
      >
        <input
          focused={typing}
          value={draft}
          placeholder={placeholder}
          onInput={setDraft}
          ref={inputRef}
          // The input hands over its value (older builds an event): send the draft either way.
          onSubmit={(value: unknown) => {
            const text = typeof value === "string" ? value : draft;
            submit(text);
            // Clear the box itself: text pasted and sent in one go may not
            // have reached the draft yet, and clearing the draft alone is then
            // no change at all.
            if (text.trim() !== "" && inputRef.current !== null) inputRef.current.value = "";
          }}
          textColor={THEME.ink}
          placeholderColor={THEME.faint}
        />
      </box>
    </box>
  );
};

/** What a half-typed /command could be, one line (tab completes the shared start). */
const SlashHints = ({ draft }: { draft: string }) => {
  const matches = slashMatches(draft);
  if (matches.length === 0) return null;
  return (
    <text>
      {matches.slice(0, 6).map((spec, index) => (
        <span key={spec.name}>
          {index > 0 ? <span fg={THEME.faint}> · </span> : null}
          <span fg={THEME.live}>/{spec.name}</span>
          {matches.length <= 2 ? <span fg={THEME.faint}> {spec.about}</span> : null}
        </span>
      ))}
    </text>
  );
};
