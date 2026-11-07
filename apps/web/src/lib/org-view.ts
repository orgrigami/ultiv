/**
 * Pure readings of the org for the UI: crew groups by home (the org's own
 * bots first, then every team, empty ones included so a new one is
 * visible at once), home labels, the VM size as typed and as shown, the
 * remembered collapsed groups, and reach rows in words.
 */
import type { AuditEvent, TeamInfo, HomeRef, VmSettings } from "@spriessen/contracts";
import { plural } from "./plural.ts";

export interface CrewGroup<T> {
  /** The team id, or null for the org's own bots. */
  readonly id: string | null;
  readonly name: string;
  readonly bots: T[];
}

/** The org's own bots first (always), then teams by name. */
export const groupByHome = <T extends { teamId?: string | null | undefined }>(
  bots: readonly T[],
  teams: readonly Pick<TeamInfo, "id" | "name">[],
  orgName: string,
): CrewGroup<T>[] => {
  const known = new Set(teams.map((row) => row.id));
  const groups: CrewGroup<T>[] = [...teams]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((row) => ({
      id: row.id,
      name: row.name,
      bots: bots.filter((bot) => bot.teamId === row.id),
    }));
  // A bot whose team is gone reads as an org bot (never lost).
  const orgBots = bots.filter(
    (bot) => bot.teamId === null || bot.teamId === undefined || !known.has(bot.teamId),
  );
  return [{ id: null, name: orgName, bots: orgBots }, ...groups];
};

/** Where a bot lives, in words. */
export const homeName = (
  teamId: string | null | undefined,
  teams: readonly Pick<TeamInfo, "id" | "name">[],
  orgName: string,
): string => teams.find((row) => row.id === teamId)?.name ?? `${orgName} (no team)`;

export const vmLabel = (vm: VmSettings): string =>
  `${vm.cpus} ${plural(vm.cpus, "CPU", "CPUs")} · ${vm.memoryMiB} MiB`;

/** The size as typed: whole CPUs (1-8) and MiB (128-8192), or what is wrong. */
export const readVmInput = (cpus: string, memory: string): VmSettings | string => {
  const c = Number(cpus);
  const m = Number(memory);
  if (!Number.isInteger(c) || c < 1 || c > 8) return "CPUs: a whole number from 1 to 8.";
  if (!Number.isInteger(m) || m < 128 || m > 8_192) {
    return "Memory: a whole number of MiB from 128 to 8192.";
  }
  return { cpus: c, memoryMiB: m };
};

/** Where the crew's collapsed groups are remembered (team ids). */
export const COLLAPSED_KEY = "spriessen.crew.collapsed";

/** The stored list, tolerant of anything that isn't a list of strings. */
export const parseCollapsed = (raw: string | null): Set<string> => {
  try {
    const value: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
};

/** The list with one group flipped. */
export const toggleCollapsed = (current: ReadonlySet<string>, id: string): string[] =>
  current.has(id) ? [...current].filter((one) => one !== id) : [...current, id];

const homeOf = (
  ref: HomeRef,
  teams: readonly Pick<TeamInfo, "id" | "name">[],
  orgName: string,
): string => (ref.kind === "org" ? orgName : homeName(ref.teamId, teams, orgName));

const SURFACE: Record<NonNullable<AuditEvent["reach"]>["surface"], string> = {
  message: "message",
};

/** One reach row in words: "Atelier → Yard · message", or null when it isn't one. */
export const reachLine = (
  row: Pick<AuditEvent, "reach">,
  teams: readonly Pick<TeamInfo, "id" | "name">[],
  orgName: string,
): string | null =>
  row.reach === undefined
    ? null
    : `${homeOf(row.reach.from, teams, orgName)} → ${homeOf(row.reach.to, teams, orgName)} · ${SURFACE[row.reach.surface]}`;

/** Whether a reach row starts or ends in this team. */
export const reachTouches = (row: Pick<AuditEvent, "reach">, teamId: string): boolean =>
  row.reach !== undefined &&
  [row.reach.from, row.reach.to].some((ref) => ref.kind === "team" && ref.teamId === teamId);
