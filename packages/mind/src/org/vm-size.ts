/**
 * The slice 4 VM-size validation for the org service: sane bounds first
 * (the dialog's words), then the host-capacity rule — with the candidate
 * applied, the CONFIGURED memory of all homes' VMs (the org's plus every
 * department's) must stay within half the host's RAM. This is a
 * configured-sum heuristic over STORED settings, never a live measurement
 * of the host (docs/SECURITY.md).
 */
import { totalmem } from "node:os";
import { InvalidInput } from "@spriessen/core";
import type { OrgState, VmSettings } from "@spriessen/contracts";
import { totalVmMemoryMiB, vmCapacityProblem, vmSettingsProblem } from "@spriessen/contracts";

/** The injectable host figure: tests shrink the host; live code does not. */
export interface VmSizeOptions {
  /** The host's physical RAM in bytes. Defaults to `os.totalmem()`. */
  readonly hostMemoryBytes?: number;
}

/**
 * Refuse a bad VM size or a set of home sizes the host cannot hold. Pure
 * over `state`: the candidate is not yet applied, so `homesWithCandidate`
 * supplies every home's size AS IT WOULD BE after the change.
 */
export const refuseBadVm = (
  state: OrgState,
  candidate: VmSettings | undefined,
  homesWithCandidate: () => readonly VmSettings[],
  options: VmSizeOptions,
): void => {
  if (candidate !== undefined) {
    const problem = vmSettingsProblem(candidate);
    if (problem !== null) throw new InvalidInput({ reason: problem });
  }
  const capacity = vmCapacityProblem(
    totalVmMemoryMiB(homesWithCandidate()),
    options.hostMemoryBytes ?? totalmem(),
  );
  if (capacity !== null) throw new InvalidInput({ reason: capacity });
};
