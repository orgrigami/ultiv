/**
 * The migration dry run: reports what a boot would move, changing nothing.
 *
 *   vpr @spriessen/server#owners:dry-run
 *
 * Run it while the server is STOPPED (the boot runs the real migration
 * itself; this is the pre-flight look). The rollback note lives in
 * docs/SECURITY.md.
 */
import { openMind, migrateOwners } from "@spriessen/mind";
import { migrateStorage } from "./auth/migrate-storage.ts";
import { OWNER_ID } from "./identity.ts";

const handle = await openMind();
const report = await migrateOwners(handle.mind.converse, { to: OWNER_ID, dryRun: true });
const storage = migrateStorage({ to: OWNER_ID, from: report.movedFrom, dryRun: true });
console.log(JSON.stringify({ docs: report, storage }, null, 2));
await handle.close();
