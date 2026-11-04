/**
 * Per-worker scratch for bot files. Test files run in parallel workers, and
 * every server test boots a stack whose storage migration MOVES folders
 * under BOT_FILES_DIR — one shared folder let one worker's migration pull
 * entries out from under another's listing (ENOENT, a flaky suite). The
 * folder is read at call time, so setting it here (before any test module
 * loads) is enough. Loaded by the root and the package vite configs.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BOT_FILES_DIR = join(
  tmpdir(),
  `spriessen-test-bot-files-${process.env.VITEST_POOL_ID ?? "0"}-${process.pid}`,
);

/**
 * Every test file gets its own audit trail. Without one the audit lands in
 * the repo's var/audit.jsonl, shared by every run: a test reading the
 * tail (topic.test.ts counts its refusals in the last 50 events) then saw
 * earlier runs' events and failed when run twice in a row. A file that sets
 * AUDIT_LOG itself (at module load, after this) keeps its own.
 */
process.env.AUDIT_LOG = join(
  tmpdir(),
  `spriessen-test-audit-${process.env.VITEST_POOL_ID ?? "0"}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`,
);
