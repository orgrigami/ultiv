/**
 * The home scope seam (phase 4 slice 2): one VM per home. The org and each
 * department get their own microVM; a bot's `bash` runs in its home's VM,
 * inside the bot's own folder. The scope dir is a stable string under the
 * artifacts root — `{root}/{owner}/_home/org` or `.../_home/dept-<id>` —
 * that ext consumes verbatim (`sandboxNameOf` on it names the VM, keeping
 * the `ultiv-` prefix); ext never learns org concepts. Bots running in a VM
 * as their own Linux user, and group membership of `/home/shared`, are
 * slice 2b.
 */
import { join } from "node:path";
import type { HomeRef, ProfileInfo } from "@spriessen/contracts";
import { artifactsDir, destroySandbox, sandboxNameOf, type HomeScope } from "@spriessen/ext";
import type { ConverseService } from "../converse/converse.ts";
import { homeOf } from "./model.ts";
import { readOrgState } from "./service.ts";

/** The stable scope dir naming one home's VM: {root}/{owner}/_home/{org|<departmentId>}. */
export const homeScopeDir = (root: string, owner: string, home: HomeRef): string =>
  join(root, owner, "_home", home.kind === "org" ? "org" : home.departmentId);

/**
 * The home scope of one bot: its home's scope dir plus the home's
 * shared-folder gid. Undefined before the org exists (a pre-migration
 * install keeps the per-bot VMs of older embedders).
 */
export const homeScopeOfProfile =
  (converse: ConverseService, root: string) =>
  async (
    owner: string,
    profile: Pick<ProfileInfo, "departmentId">,
  ): Promise<HomeScope | undefined> => {
    const state = await readOrgState(converse);
    if (state.org === null) return undefined;
    const home = homeOf(profile);
    const sharedGid =
      home.kind === "org"
        ? state.org.sharedGid
        : state.departments.find((row) => row.id === home.departmentId)?.sharedGid;
    return {
      dir: homeScopeDir(root, owner, home),
      ...(sharedGid === undefined ? {} : { sharedGid }),
    };
  };

/**
 * The default home-VM teardown: stop, then remove, the home's VM — best
 * effort (a missing VM or a stuck runtime never fails the removal) and
 * bounded at 8 s. `openMind`'s `destroyHomeVm` defaults to this; tests
 * inject a recorder so no VM runtime is touched.
 */
export const defaultDestroyHomeVm = (): ((owner: string, home: HomeRef) => Promise<void>) => {
  const root = artifactsDir();
  return async (owner, home) => {
    const name = sandboxNameOf(homeScopeDir(root, owner, home));
    await Promise.race([
      destroySandbox(name).then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 8_000)),
    ]);
  };
};
