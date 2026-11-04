/**
 * What a sandbox shell backend is built from (SandboxBackendOptions): the
 * VM's name, image and size, the guest root and shared org/department
 * stores, the bot user, the network allowlist and the shared caps.
 */

import type { SandboxUser, SharedCaps } from "../plugins/vault.ts";

export interface SandboxBackendOptions {
  /** Deterministic sandbox name for this workspace scope. */
  readonly name: string;
  /** OCI image; default "ubuntu". */
  readonly image?: string;
  /**
   * The workspace root inside the VM (default `/home`). With one VM per home
   * this is the bot's own folder (`/home/<bot>`): `prepare` wipes and refills
   * only it — never another bot's folder, never `/home/shared`.
   */
  readonly guestRoot?: string;
  /**
   * Gid of the home's shared-folder group. When set, the VM's `/home/shared`
   * is provisioned on every boot: root:`ultiv-shared`, mode 2770 (setgid),
   * idempotent, and the bot's user joins the group.
   */
  readonly sharedGid?: number;
  /**
   * The org-wide folder (slice 2c): one durable host directory, bind-mounted
   * at `/home/org-shared` into EVERY VM — read-write in the org VM,
   * read-only in a department VM (enforced by the mount). Its group
   * (`ultiv-org`) is the org's own stored gid; every bot's user joins it.
   */
  readonly orgShared?: {
    readonly hostDir: string;
    readonly gid: number;
    readonly readOnly: boolean;
  };
  /**
   * The bot's own Linux user in this VM. When set, every `exec` runs as
   * `uid:gid` (never root) and the user is provisioned idempotently at boot.
   */
  readonly user?: SandboxUser;
  /**
   * The department's own durable store (slice 2d): when set, `/home/shared`
   * is a bind mount of this host directory instead of a writable-layer
   * folder — the same store the org VM sees at
   * `/home/dept-shared/<department id>`.
   */
  readonly sharedStore?: string;
  /**
   * The org VM's department shared folders (slice 2d): the per-org parent
   * directory, bind-mounted at `/home/dept-shared` (its subfolders are the
   * department stores), the stored departments (ids and gids) for
   * provisioning, and every org bot's Linux user for group reconciliation.
   */
  readonly deptShared?: {
    readonly parentDir: string;
    readonly depts: readonly { readonly id: string; readonly gid: number }[];
    readonly users: readonly string[];
  };
  /**
   * The home's network allowlist (slice 3): named hosts the VM may reach.
   * ALWAYS applied — an undefined or empty list boots the VM fully
   * offline (the default). Create-time-only in the SDK: an edited list
   * recreates the VM at its next use (the applied-fingerprint marker).
   */
  readonly netAllowlist?: readonly string[];
  /** Full network access for this home's VM: the allowlist is ignored. */
  readonly netOpen?: boolean;
  /**
   * The home's stored VM size (slice 4): the cpus and memory the VM is
   * CREATED with — the org's or department's stored settings. Undefined
   * reads the defaults (`VM_CPUS` / `VM_MEMORY_MIB`). Create-time-only in
   * the SDK like the policy: an edited size recreates the VM at its next
   * use (the same spec fingerprint).
   */
  readonly vm?: { readonly cpus: number; readonly memoryMiB: number };
  /**
   * Size caps of the writable shared folders (fix 2), in bytes: the org's
   * `/home/org-shared`, a department's own `/home/shared` (its store) and,
   * in the org VM, each `/home/dept-shared/<id>`. Enforced at the tool path
   * (see shell/shared-caps.ts); absent means uncapped.
   */
  readonly caps?: SharedCaps;
}
