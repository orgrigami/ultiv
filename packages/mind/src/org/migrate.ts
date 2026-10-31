/**
 * The org migration: today's single workspace becomes the org. Repeatable
 * like `migrateOwners` (which runs just before it at boot): the first run
 * creates the org "Personal" owned by the signed-in account, stamps every
 * existing bot as an org bot (`departmentId: null`) with host access on
 * (today's behaviour — F1), and creates no department rows. Later runs
 * change nothing: once the org exists the bot rows are the owner's to
 * change (a moved bot or a switch turned off must survive a restart, since
 * this runs at every boot). The bots are stamped before the org row is
 * written, so a run cut short between the two simply stamps again next
 * boot. Dry-run mode reports what would change without writing.
 *
 * Rollback: rolling the code back leaves an `ultiv.org` document and
 * `departmentId`/`hostAccess` fields older code ignores; bots keep their
 * behaviour (the fields default to today's readings). Nothing is moved or
 * deleted: bot-owned resources (memory, files, skills, vault, routines,
 * sandbox) stay exactly where they are and follow their bot.
 */
import { Effect } from "effect";
import type { ProfileInfo } from "@spriessen/contracts";
import type { ConverseService } from "../converse/converse.ts";
import { commitProfiles, readProfiles } from "../profiles/docs.ts";
import { OrgDoc } from "./model.ts";
import { readOrgState } from "./service.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

export interface OrgMigrationReport {
  /** Whether this run created the org (false: it already existed, or a dry run found it). */
  createdOrg: boolean;
  /** Existing bot rows stamped with `departmentId: null` and `hostAccess: true`. */
  botsStamped: number;
  /** Department rows created — always 0 today (the brief: none are created). */
  departments: number;
}

export interface MigrateOrgOptions {
  /** The signed-in account that owns the org. */
  readonly owner: string;
  readonly dryRun?: boolean;
}

export const migrateOrg = async (
  converse: ConverseService,
  options: MigrateOrgOptions,
): Promise<OrgMigrationReport> => {
  const state = await readOrgState(converse);
  const existing = await run(readProfiles(converse));
  const needsStamp = (profile: ProfileInfo): boolean =>
    profile.departmentId !== null || profile.hostAccess !== true;
  const firstRun = state.org === null;
  const report: OrgMigrationReport = {
    createdOrg: firstRun,
    botsStamped: firstRun ? existing.filter(needsStamp).length : 0,
    departments: 0,
  };
  if (options.dryRun === true) return report;
  if (report.botsStamped > 0) {
    await run(
      commitProfiles(converse, (rows) =>
        rows.map((row) =>
          needsStamp(row) ? { ...row, departmentId: null, hostAccess: true } : row,
        ),
      ),
    );
  }
  if (report.createdOrg) {
    await run(
      converse.docs.commit(async (tx) => {
        const draft = await tx.doc(OrgDoc);
        if (draft.org === undefined || draft.org === null) {
          // ensureOrg's exact shape, inline so the whole migration is one
          // pass; the member row makes the account the org owner.
          draft.org = {
            id: "org",
            name: "Personal",
            owner: options.owner,
            createdAt: Date.now(),
            vm: { cpus: 1, memoryMiB: 512 },
            hostAccess: true,
          };
          draft.members = [
            ...(draft.members ?? []).filter(
              (member) => !(member.accountId === options.owner && member.departmentId === null),
            ),
            { accountId: options.owner, role: "owner", departmentId: null },
          ];
        }
      }),
    );
  }
  return report;
};
