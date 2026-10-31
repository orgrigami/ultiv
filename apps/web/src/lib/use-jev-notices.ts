/**
 * Jev's gate decisions in this chat, keyed by tool call id, so the transcript
 * can say what Jev approved, denied or sent back. Read from the audit tail
 * (REST has no push): refetched when a tool call finishes, which is after Jev
 * decided it. Old decisions stay visible after the mode is switched off.
 */
import { useEffect, useState } from "react";
import type { TranscriptEntry } from "@spreissen/contracts";
import { api } from "@/lib/api";
import { jevNotices, type JevNotice } from "@/lib/jev-text";

const EMPTY: ReadonlyMap<string, JevNotice> = new Map();

export function useJevNotices(
  conversationId: string | null,
  transcript: readonly TranscriptEntry[],
): ReadonlyMap<string, JevNotice> {
  const [notices, setNotices] = useState(EMPTY);
  const finished = transcript.filter(
    (entry) => entry.kind === "tool" && entry.step.status !== "running",
  ).length;
  useEffect(() => {
    if (conversationId === null) return;
    let live = true;
    api
      .adjudications(conversationId)
      .then((events) => {
        if (live) setNotices(jevNotices(events));
      })
      .catch(() => {
        // Notices are a courtesy; a failed read keeps the last ones.
      });
    return () => {
      live = false;
    };
  }, [conversationId, finished]);
  useEffect(() => setNotices(EMPTY), [conversationId]);
  return notices;
}
