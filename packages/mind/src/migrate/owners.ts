/**
 * Owner-label migration: the one pass that moves every row and store an old
 * owner label holds to the ONE owner account. It runs at boot (repeatable,
 * logs a count) and as a dry run (`migrate-owners.ts`) that reports what
 * would move without writing.
 *
 * What moves: session rows, profile rows, the main-bot map, task rows
 (including their adopted bot stamp), rooms, mailbox entries, the
 * session-key aliases (a relabeled row keeps its durable conversation
 * through a new `ultiv.session-map` entry pointing at the SAME conversation),
 * and the v2 memory doc families (content copied to the new family key; the
 * old key stays put as the rollback path). Rows stamped `agent` (bot-spawned
 * task sentinel) never move. See docs/SECURITY.md for the rollback note.
 */
import { Effect } from "effect";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { SessionInfo } from "@spriessen/contracts";
import { AGENT_OWNER } from "../act/task-tools.ts";
import type { ConverseService } from "../converse/converse.ts";
import { SessionMapDoc } from "../converse/converse.ts";
import {
  SettingsDoc,
  commitProfiles,
  commitSessions,
  legacyKey,
  pairKey,
  readProfiles,
  readSessions,
  scopedKey,
} from "../profiles/docs.ts";
import { RoomsDoc } from "../profiles/rooms.ts";
import { MailboxDoc, readEntries } from "../mailbox/store.ts";
import { TasksDoc, readTasks } from "../tasks/store.ts";
import {
  ArchiveDoc,
  CoreDoc,
  EpisodesDoc,
  FactsDoc,
  GraphDoc,
  ProposalsDoc,
  ownerKey,
  profileKey,
} from "../memory/model.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

/** An owner label the migration moves to the account; `agent` rows never move. */
const migratable = (owner: string, to: string): boolean =>
  owner !== to && owner !== AGENT_OWNER && owner.trim() !== "";

export interface OwnerMigrationReport {
  /** The labels that had data and moved (or would move). */
  movedFrom: string[];
  sessions: number;
  profiles: number;
  mainBots: number;
  tasks: number;
  rooms: number;
  mailbox: number;
  /** New session-map aliases keeping conversations reachable under new keys. */
  conversationKeys: number;
  /** Memory family keys whose content moved. */
  memoryStores: number;
  /** Family keys left alone because the target already had content. */
  memorySkipped: number;
}

export interface MigrateOwnersOptions {
  readonly to: string;
  readonly dryRun?: boolean;
}

interface MigrateDeps {
  readonly converse: ConverseService;
}

/** Collect the old labels, then move rows, keys and memory. */
export const migrateOwners = async (
  converse: ConverseService,
  options: MigrateOwnersOptions,
): Promise<OwnerMigrationReport> => {
  const deps: MigrateDeps = { converse };
  const to = options.to;
  const [sessions, profiles, tasks, rooms, mailbox, settings] = await Promise.all([
    run(readSessions(converse)),
    run(readProfiles(converse)),
    run(readTasks(converse)),
    run(converse.docs.snapshot(RoomsDoc)).then((doc) => doc?.items ?? []),
    readEntries(converse),
    run(converse.docs.snapshot(SettingsDoc)).then((doc) => doc?.main ?? {}),
  ]);
  const labels = new Set<string>();
  for (const row of sessions) if (migratable(row.owner, to)) labels.add(row.owner);
  for (const row of profiles) if (migratable(row.owner, to)) labels.add(row.owner);
  const settingsMoves = Object.keys(settings).filter((key) => migratable(key, to));
  const report: OwnerMigrationReport = {
    movedFrom: [...labels, ...settingsMoves].filter(
      (value, index, all) => all.indexOf(value) === index,
    ),
    sessions: sessions.filter((row) => migratable(row.owner, to)).length,
    profiles: profiles.filter((row) => migratable(row.owner, to)).length,
    mainBots: settingsMoves.length,
    tasks: tasks.filter((row) => migratable(row.owner, to) || migratable(row.bot?.owner ?? "", to))
      .length,
    rooms: rooms.filter((row) => migratable(row.owner, to)).length,
    mailbox: mailbox.filter((row) => migratable(row.owner ?? "", to)).length,
    conversationKeys: 0,
    memoryStores: 0,
    memorySkipped: 0,
  };
  if (options.dryRun === true) {
    report.conversationKeys = await countAliases(deps, sessions, to);
    return report;
  }
  report.conversationKeys = await writeAliases(deps, sessions, to);
  await relabelRows(deps, to);
  await moveMainBots(deps, settingsMoves, to);
  const memory = await moveMemory(deps, labels, profiles, to);
  report.memoryStores = memory.moved;
  report.memorySkipped = memory.skipped;
  return report;
};

/** The durable conversation a row's OLD key resolves to (keyOfRow's logic). */
const oldKeysOf = (row: SessionInfo): readonly string[] => {
  const scoped =
    row.kind === "dm" && row.participants !== null
      ? pairKey(row.owner, row.participants[0] ?? "", row.participants[1] ?? "")
      : scopedKey(row.owner, row.profile, row.id);
  if (row.profile === "default" && row.kind === "session") {
    return [scoped, legacyKey(row.owner, row.id)];
  }
  return [scoped];
};

const newKeyOf = (row: SessionInfo, to: string): string =>
  row.kind === "dm" && row.participants !== null
    ? pairKey(to, row.participants[0] ?? "", row.participants[1] ?? "")
    : scopedKey(to, row.profile, row.id);

/** Alias plans: (new key, existing conversation) pairs, skips already-mapped keys. */
const aliasPlans = async (
  deps: MigrateDeps,
  sessions: readonly SessionInfo[],
  to: string,
): Promise<{ readonly newKey: string; readonly conversationId: string }[]> => {
  const plans: { newKey: string; conversationId: string }[] = [];
  for (const row of sessions) {
    if (!migratable(row.owner, to)) continue;
    const newKey = newKeyOf(row, to);
    if ((await run(deps.converse.conversationIdOf(newKey))) !== undefined) continue;
    for (const oldKey of oldKeysOf(row)) {
      const cid = await run(deps.converse.conversationIdOf(oldKey));
      if (cid !== undefined) {
        plans.push({ newKey, conversationId: cid });
        break;
      }
    }
  }
  return plans;
};

const countAliases = async (
  deps: MigrateDeps,
  sessions: readonly SessionInfo[],
  to: string,
): Promise<number> => (await aliasPlans(deps, sessions, to)).length;

const writeAliases = async (
  deps: MigrateDeps,
  sessions: readonly SessionInfo[],
  to: string,
): Promise<number> => {
  const plans = await aliasPlans(deps, sessions, to);
  if (plans.length === 0) return 0;
  await run(
    deps.converse.docs.commit(async (tx) => {
      for (const plan of plans) {
        const conversationId = plan.conversationId as unknown as ConversationId;
        const draft = await tx.doc(SessionMapDoc, plan.newKey as never, { conversationId });
        draft.conversationId = conversationId;
      }
    }),
  );
  return plans.length;
};

const relabelRows = async (deps: MigrateDeps, to: string): Promise<void> => {
  await run(
    commitSessions(deps.converse, (rows) =>
      rows.map((row) => (migratable(row.owner, to) ? { ...row, owner: to } : row)),
    ),
  );
  await run(
    commitProfiles(deps.converse, (rows) =>
      rows.map((row) => (migratable(row.owner, to) ? { ...row, owner: to } : row)),
    ),
  );
  await run(
    deps.converse.docs.commit(async (tx) => {
      const draft = await tx.doc(RoomsDoc);
      draft.items = draft.items.map((room) =>
        migratable(room.owner, to) ? { ...room, owner: to } : room,
      );
    }),
  );
  await run(
    deps.converse.docs.commit(async (tx) => {
      const draft = await tx.doc(MailboxDoc);
      draft.items = draft.items.map((entry) =>
        migratable(entry.owner ?? "", to) ? { ...entry, owner: to } : entry,
      );
    }),
  );
  await run(
    deps.converse.docs.commit(async (tx) => {
      const draft = await tx.doc(TasksDoc);
      draft.tasks = draft.tasks.map((task) => ({
        ...task,
        ...(migratable(task.owner, to) ? { owner: to } : {}),
        ...(task.bot !== undefined && migratable(task.bot.owner, to)
          ? { bot: { ...task.bot, owner: to } }
          : {}),
      }));
    }),
  );
};

const moveMainBots = async (
  deps: MigrateDeps,
  moves: readonly string[],
  to: string,
): Promise<void> => {
  if (moves.length === 0) return;
  await run(
    deps.converse.docs.commit(async (tx) => {
      const draft = await tx.doc(SettingsDoc);
      for (const old of moves) {
        const profileId = draft.main[old];
        if (profileId !== undefined) draft.main[to] = profileId;
      }
    }),
  );
};

interface MemoryFamilies {
  moved: number;
  skipped: number;
}

const MEMORY_DOCS = [FactsDoc, ArchiveDoc, GraphDoc, EpisodesDoc, CoreDoc, ProposalsDoc] as const;

const nonEmpty = (value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  const record = value as Record<string, unknown>;
  const list =
    record.facts ?? record.lines ?? record.entities ?? record.episodes ?? record.proposals;
  return Array.isArray(list) && list.length > 0;
};

const copyFamily = async (
  deps: MigrateDeps,
  doc: Parameters<ConverseService["docs"]["snapshotKeyed"]>[0],
  from: string,
  to: string,
): Promise<"copied" | "empty" | "skipped"> => {
  const old = await run(deps.converse.docs.snapshotKeyed(doc, from));
  if (old === undefined || !nonEmpty(old)) return "empty";
  const existing = await run(deps.converse.docs.snapshotKeyed(doc, to));
  if (existing !== undefined && nonEmpty(existing)) return "skipped";
  await run(
    deps.converse.docs.commit(async (tx) => {
      // Every family doc seeds with its value verbatim, so writing the old
      // content as the initial value IS the copy.
      await tx.doc(doc as never, to, old as never);
    }),
  );
  return "copied";
};

/** Copy each family key under the old labels to the account's keys. */
const moveMemory = async (
  deps: MigrateDeps,
  labels: ReadonlySet<string>,
  profiles: readonly { readonly owner: string; readonly id: string }[],
  to: string,
): Promise<MemoryFamilies> => {
  const result: MemoryFamilies = { moved: 0, skipped: 0 };
  const keys: { from: string; to: string }[] = [];
  for (const label of labels) {
    keys.push({ from: ownerKey(label), to: ownerKey(to) });
    for (const profile of profiles) {
      if (profile.owner === label) {
        keys.push({ from: profileKey(label, profile.id), to: profileKey(to, profile.id) });
      }
    }
  }
  for (const key of keys) {
    for (const doc of MEMORY_DOCS) {
      const outcome = await copyFamily(deps, doc, key.from, key.to);
      if (outcome === "copied") result.moved += 1;
      if (outcome === "skipped") result.skipped += 1;
    }
  }
  return result;
};
