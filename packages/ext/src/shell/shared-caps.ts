/**
 * Shared-folder size caps, enforced at the Spriessen tool path (fix 2).
 *
 * The platform has no per-directory quota: the shared folders are virtiofs
 * bind mounts of host directories, and microsandbox exposes no quota knob.
 * So the cap is enforced around every sandboxed `bash` call instead: the
 * backing HOST directory is measured (lstat walk, no symlink follow, stops
 * early once past the cap) before and after the call; over the cap the
 * folder is remounted read-only inside the VM (a bind-on-itself, so the
 * rest of the VM is untouched), and back under it the read-only layer is
 * popped again. Where the remount fails, the call is REFUSED instead while
 * the folder is over its cap. What this does NOT do: stop a single call
 * from overshooting (the measurement is after the fact), or count writes
 * made outside `bash` (the server's own file paths are mediated elsewhere).
 */

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** One capped, writable shared folder of a VM. */
export interface CappedDir {
  /** The folder inside the VM. */
  readonly guest: string;
  /** Its backing host directory (what is measured). */
  readonly host: string;
  readonly capBytes: number;
  /** A short human label for notes and refusals. */
  readonly label: string;
}

/**
 * Total bytes of regular files under `dir`, stopping as soon as the total
 * passes `limit` (the caller only needs "over or not"). Symlinks are never
 * followed; unreadable entries count as zero. A missing dir is 0.
 */
export const usageUpTo = (dir: string, limit: number): number => {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(current, name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) stack.push(path);
      else if (stat.isFile()) {
        total += stat.size;
        if (total > limit) return total;
      }
    }
  }
  return total;
};

const quote = (path: string): string => `'${path.replaceAll("'", "'\\''")}'`;

/**
 * The root script putting one folder read-only (a bind of the folder onto
 * itself, remounted ro) or back read-write (popping every ro layer on it).
 * Idempotent: it reads the folder's current mount state first, so a
 * restarted server converges on whatever the VM already has.
 */
export const capMountScript = (guest: string, readOnly: boolean): string => {
  const dir = quote(guest);
  // The LAST line is the topmost mount on the folder (what access sees).
  const isRo = `findmnt -no OPTIONS --mountpoint ${dir} 2>/dev/null | tail -n1 | grep -q '^ro'`;
  return readOnly
    ? `[ -d ${dir} ] || exit 0\n` +
        `if ${isRo}; then exit 0; fi\n` +
        `mount --bind ${dir} ${dir} && mount -o remount,bind,ro ${dir} || exit 1\n` +
        `${isRo}`
    : `[ -d ${dir} ] || exit 0\n` +
        `n=0; while ${isRo}; do umount ${dir} || exit 1; n=$((n+1)); [ $n -lt 8 ] || exit 1; done\n` +
        `exit 0`;
};

const mib = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MiB`;

/** The note appended to a call's stderr when a folder is (now) over its cap. */
export const overCapNote = (dir: CappedDir, used: number, enforced: boolean): string =>
  `[cap] ${dir.guest} (${dir.label}) is over its size cap: at least ${mib(used)} of ` +
  `${mib(dir.capBytes)}. ` +
  (enforced
    ? "It is read-only until files there are removed or the owner raises the cap."
    : "Bash is paused for bots that can write there until files are removed or the owner raises the cap.");

/** The refusal of a call while a folder is over its cap and the remount failed. */
export const overCapRefusal = (dir: CappedDir, used: number): string =>
  `${overCapNote(dir, used, false)} Ask your owner to free space in ${dir.guest} or raise its cap.`;
