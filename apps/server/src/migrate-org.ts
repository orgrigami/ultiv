/**
 * The org migration dry run: reports what a boot would create and stamp,
 * changing nothing.
 *
 *   vpr @spriessen/server#org:dry-run
 *
 * Run it while the server is STOPPED (the boot runs the real migration
 * itself; this is the pre-flight look). The rollback note lives in
 * docs/SECURITY.md.
 */
import { openMind, migrateOrg } from "@spriessen/mind";
import { OWNER_ID } from "./identity.ts";

const handle = await openMind();
const report = await migrateOrg(handle.mind.converse, { owner: OWNER_ID, dryRun: true });
console.log(JSON.stringify(report, null, 2));
await handle.close();
