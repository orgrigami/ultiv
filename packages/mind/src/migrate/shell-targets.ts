/**
 * Shell-target migration (phase 6): rewrites the stored autoApprove entries
 * the bash merge left behind. `bash_host:=<script>` becomes
 * `bash@host:=<script>` — the owner's exact-script rule keeps approving
 * exactly its script, now through the merged tool's host target. Bare `bash`
 * entries are NOT touched: the matcher's vm-only rule preserves their
 * meaning by definition, not by migration. Inert `bash_host:glob` entries
 * are left alone (patterns never matched the host shell, and a renamed
 * pattern would never match either). Repeatable, runs at boot; counts only —
 * never logs entry contents, which may carry secrets.
 */
import { Effect } from "effect";
import { legacyExactScriptOf, targetExactEntry } from "../auto-approve.ts";
import type { ConverseService } from "../converse/converse.ts";
import { commitProfiles, readProfiles } from "../profiles/docs.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

/** One entry: the legacy host exact form to its target form, everything else untouched. */
export const migrateShellEntry = (entry: string): string => {
  const legacy = legacyExactScriptOf(entry);
  return legacy === undefined ? entry : targetExactEntry({ kind: "host" }, legacy.script);
};

/** Rewrite every profile's stored `bash_host:=` entries; returns the count moved. */
export const migrateShellTargets = async (converse: ConverseService): Promise<number> => {
  let moved = 0;
  await run(
    commitProfiles(converse, (rows) =>
      rows.map((row) => {
        if (!row.policies.autoApprove.some((entry) => legacyExactScriptOf(entry) !== undefined))
          return row;
        const autoApprove = row.policies.autoApprove.map(migrateShellEntry);
        moved += autoApprove.filter((entry, i) => entry !== row.policies.autoApprove[i]).length;
        return { ...row, policies: { ...row.policies, autoApprove } };
      }),
    ),
  );
  return moved;
};

/** Boot read for the migration report (tests and the dry run). */
export const shellTargetsPending = async (converse: ConverseService): Promise<number> => {
  const profiles = await run(readProfiles(converse));
  return profiles.reduce(
    (sum, row) =>
      sum +
      row.policies.autoApprove.filter((entry) => legacyExactScriptOf(entry) !== undefined).length,
    0,
  );
};
