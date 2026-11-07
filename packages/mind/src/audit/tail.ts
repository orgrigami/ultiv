/**
 * Reading the audit trail without reading all of it. The JSONL file only
 * grows, and `tail` runs on hot paths (every memory write, every Needs you
 * load), so it reads backwards from the end in chunks until it has enough
 * lines. The per-conversation ledger answers "what ran in THIS chat lately"
 * without depending on how busy every other bot has been.
 */
import { renameLegacyTeams, renameTeamTool } from "../migrate/teams.ts";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import type { AuditEvent } from "@spriessen/contracts";

const CHUNK = 64 * 1024;
const NEWLINE = 0x0a;

/**
 * The last `limit` non-empty lines of a file, oldest first. Splits on the
 * newline BYTE before decoding: a newline never occurs inside a multi-byte
 * UTF-8 sequence, so no character is cut.
 */
export const readLastLines = (path: string, limit: number): string[] => {
  if (limit <= 0 || !existsSync(path)) return [];
  const fd = openSync(path, "r");
  try {
    let position = fstatSync(fd).size;
    const chunks: Buffer[] = [];
    let newlines = 0;
    // One newline more than wanted guarantees the oldest kept line is whole.
    while (position > 0 && newlines <= limit) {
      const size = Math.min(CHUNK, position);
      position -= size;
      const chunk = Buffer.alloc(size);
      readSync(fd, chunk, 0, size, position);
      for (const byte of chunk) if (byte === NEWLINE) newlines += 1;
      chunks.unshift(chunk);
    }
    const lines: string[] = [];
    const all = Buffer.concat(chunks);
    let end = all.length;
    for (let index = all.length - 1; index >= -1 && lines.length < limit; index -= 1) {
      if (index >= 0 && all[index] !== NEWLINE) continue;
      // Skip the partial first line unless the read reached the file start.
      if (index < 0 && position > 0) break;
      const line = all.subarray(index + 1, end).toString("utf8");
      if (line.trim() !== "") lines.push(line);
      end = index;
    }
    return lines.reverse();
  } finally {
    closeSync(fd);
  }
};

/**
 * Teams were called departments, and the log is append-only: lines written
 * before the rename read with the new names (keys, home kinds, the
 * `dept-shared` area, the old team tool names and `department-…` changes).
 */
const withTeamNames = (event: AuditEvent): AuditEvent => {
  const renamed = renameLegacyTeams(event);
  const name = renamed.name;
  if (typeof name !== "string") return renamed;
  const next = renameTeamTool(name).replace(/^department-/, "team-");
  return next === name ? renamed : { ...renamed, name: next };
};

export const parseLines = (lines: readonly string[]): AuditEvent[] =>
  lines.flatMap((line) => {
    try {
      return [withTeamNames(JSON.parse(line) as AuditEvent)];
    } catch {
      return [];
    }
  });

/** The windows `findIn` widens through, in lines. */
const FIND_WINDOWS = [5_000, 20_000, 50_000] as const;

/** Search the trail's tail, widening the window until it has enough (see AuditService.find). */
export const findIn = (
  tail: (limit: number) => readonly AuditEvent[],
  match: (event: AuditEvent) => boolean,
  options: { readonly limit: number; readonly since?: number },
): AuditEvent[] => {
  const since = options.since ?? Number.NEGATIVE_INFINITY;
  let found: AuditEvent[] = [];
  for (const window of FIND_WINDOWS) {
    const events = tail(window);
    found = events.filter((event) => event.at >= since && match(event));
    const exhausted = events.length < window;
    const pastSince = events.length > 0 && (events[0]?.at ?? 0) < since;
    if (found.length >= options.limit || exhausted || pastSince) break;
  }
  return found.slice(-options.limit);
};

/** Events kept per conversation, and conversations kept, in the ledger. */
const PER_CONVERSATION = 200;
const CONVERSATIONS = 1_000;
/** How far back the file is read to seed the ledger after a restart. */
const SEED_LINES = 5_000;

/**
 * Recent events per conversation, in memory. Seeded once from the file's
 * tail (so a turn resumed after a restart still sees what ran before it),
 * then kept current by every record.
 */
export const makeLedger = (seed: () => readonly AuditEvent[]) => {
  const byConversation = new Map<string, AuditEvent[]>();
  let seeded = false;
  const add = (event: AuditEvent): void => {
    const list = byConversation.get(event.conversationId) ?? [];
    list.push(event);
    if (list.length > PER_CONVERSATION) list.splice(0, list.length - PER_CONVERSATION);
    // Re-insert so the map's order is least recently written first.
    byConversation.delete(event.conversationId);
    byConversation.set(event.conversationId, list);
    if (byConversation.size > CONVERSATIONS) {
      const oldest = byConversation.keys().next().value;
      if (oldest !== undefined) byConversation.delete(oldest);
    }
  };
  const ensureSeeded = (): void => {
    if (seeded) return;
    seeded = true;
    for (const event of seed()) add(event);
  };
  return {
    add: (event: AuditEvent): void => {
      // Seed first, or the seed would later re-add what is already here.
      ensureSeeded();
      add(event);
    },
    of: (conversationId: string): readonly AuditEvent[] => {
      ensureSeeded();
      return [...(byConversation.get(conversationId) ?? [])];
    },
  };
};

export const LEDGER_SEED_LINES = SEED_LINES;
