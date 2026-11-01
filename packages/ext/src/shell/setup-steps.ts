/**
 * Root setup steps that are never silent (Phase 4 fix): a failed non-fatal
 * step prints a `SETUP_WARN` line on stderr, which the sandbox backend logs;
 * a fatal step (hidepid) exits `SETUP_FATAL_CODE`, failing the VM boot.
 */

/** Marker on stderr for a non-fatal setup step that failed (logged by the backend). */
export const SETUP_WARN = "spriessen-setup-warn:";
/** Marker on stderr for a FATAL step. */
export const SETUP_FATAL = "spriessen-setup-fatal:";
/** Exit code of a FATAL setup step (hidepid): the VM boot fails. */
export const SETUP_FATAL_CODE = 97;

/** Run `cmd` as root; on failure print a `SETUP_WARN` line naming `what` (never silent). */
export const warnOnFail = (cmd: string, what: string): string =>
  `${cmd} 2>/dev/null || echo '${SETUP_WARN} ${what.replaceAll("'", "")}' >&2`;

/**
 * The default ACL step (best effort by nature: POSIX ACLs do not cross a
 * macOS virtiofs mount) — a missing tool or a refused ACL is a logged
 * warning; the umask normalization on the tool path is the real mechanism.
 */
export const setfaclStep = (group: string, dir: string): string =>
  `if command -v setfacl >/dev/null 2>&1; then ${warnOnFail(
    `setfacl -d -m g:${group}:rwX '${dir}'`,
    `setfacl ${dir}`,
  )}; else echo '${SETUP_WARN} setfacl missing' >&2; fi`;
