/**
 * The History faculty: the entity can reread its own past. Transcripts are
 * already durable in the harness — this is the retrieval surface over them,
 * scoped to the asking profile's sessions. Substring match over entry text,
 * newest first; entries compaction retired are still searched (the scan reads
 * storage, not the live context).
 */
import { Effect } from "effect";
import type { ConverseService } from "../converse/converse.ts";
import { ATTACHMENTS_MARK, INPUT_ENTRY_KIND } from "../converse/steps.ts";
import type { ProfilesService } from "../profiles/profiles.ts";

export interface HistoryHit {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly kind: string;
  readonly role: string;
  readonly snippet: string;
}

/** Text of one entry's model messages, joined (user input, assistant text, tool output). */
const entryText = (entry: {
  readonly kind: string;
  readonly model?: readonly unknown[];
}): {
  role: string;
  text: string;
} => {
  const role =
    entry.kind === "pi.user" || entry.kind === INPUT_ENTRY_KIND
      ? "user"
      : entry.kind === "pi.tool-result"
        ? "tool"
        : "assistant";
  const parts: string[] = [];
  for (const message of entry.model ?? []) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        const text = (block as { text?: string }).text;
        if (typeof text === "string" && text !== "") parts.push(text);
      }
    }
  }
  // Attachment reference lines are machinery: history searches what was said.
  const text = (parts.join(" ").split(ATTACHMENTS_MARK)[0] ?? "").trim();
  return { role, text };
};

const snippetAround = (text: string, at: number, span = 80): string => {
  const start = Math.max(0, at - span / 2);
  const end = Math.min(text.length, at + span);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
};

export interface HistoryService {
  /** Search one profile's sessions for a query; newest first, capped. */
  readonly search: (
    owner: string,
    profileId: string,
    query: string,
    limit: number,
  ) => Promise<HistoryHit[]>;
}

const MAX_SESSIONS = 50;
const MAX_ENTRIES_PER_SESSION = 500;

export const historyService = (deps: {
  readonly converse: ConverseService;
  readonly profiles: ProfilesService;
}): HistoryService => ({
  search: async (owner, profileId, query, limit) => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    const rows = (await deps.profiles.listSessions(owner, profileId)).slice(0, MAX_SESSIONS);
    const hits: HistoryHit[] = [];
    for (const row of rows) {
      if (hits.length >= limit) break;
      const key = await deps.profiles.keyOfRow(row);
      const cid = await Effect.runPromise(deps.converse.conversationIdOf(key));
      if (cid === undefined) continue;
      const entries = await Effect.runPromise(
        deps.converse.entriesOf(cid, MAX_ENTRIES_PER_SESSION),
      );
      for (const entry of entries) {
        if (hits.length >= limit) break;
        const { role, text } = entryText(entry);
        if (text === "") continue;
        const at = text.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        hits.push({
          sessionId: row.id,
          sessionTitle: row.title,
          kind: row.kind,
          role,
          snippet: snippetAround(text, at),
        });
      }
    }
    return hits;
  },
});
