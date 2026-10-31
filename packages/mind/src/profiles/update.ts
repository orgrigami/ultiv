/**
 * Profile edits: the same validation and limits as create, and the refresh
 * of every conversation's profile copy. Each chat of the bot (main, reset
 * mains, sessions, task threads) gets the edited profile from its next turn.
 */
import { InvalidInput } from "@spreissen/core";
import type { ProfileApprovalMode, ProfileCreate, ProfileInfo } from "@spreissen/contracts";
import { validAutoApproveEntry } from "../auto-approve.ts";
import { validTimezone } from "./docs.ts";

/** Field limits, shared with create. */
export const PROFILE_LIMITS = {
  name: 80,
  description: 500,
  persona: 8_000,
  autoApproveEntries: 32,
  autoApproveEntryChars: 200,
} as const;

const APPROVAL_MODES: readonly ProfileApprovalMode[] = ["manual", "jev", "yolo"];

/** Reject a patch with an unknown timezone, model (not in the live catalog), or approval mode. */
export const validatePatch = (
  patch: Partial<ProfileCreate>,
  /** The live catalog check (profiles pass it; pure policy tests need none). */
  knownModel: (ref: string) => boolean = () => true,
): void => {
  if (patch.timezone !== undefined && !validTimezone(patch.timezone)) {
    throw new InvalidInput({ reason: `unknown timezone: ${patch.timezone}` });
  }
  if (patch.model !== undefined && patch.model !== null && !knownModel(patch.model.id)) {
    throw new InvalidInput({ reason: `unknown model: ${patch.model?.id}` });
  }
  const mode = patch.policies?.approvalMode;
  if (mode !== undefined && !APPROVAL_MODES.includes(mode)) {
    throw new InvalidInput({ reason: `unknown approval mode: ${String(mode)}` });
  }
  // autoApprove entries compile into RegExp on every gated call (the hook is
  // synchronous), so the stored list is bounded and each entry is shape- and
  // wildcard-checked: a pathological glob must not stall the gate.
  const autoApprove = patch.policies?.autoApprove;
  if (autoApprove !== undefined) {
    if (autoApprove.length > PROFILE_LIMITS.autoApproveEntries) {
      throw new InvalidInput({
        reason: `too many autoApprove entries: ${autoApprove.length} (max ${PROFILE_LIMITS.autoApproveEntries})`,
      });
    }
    for (const entry of autoApprove) {
      if (entry.length > PROFILE_LIMITS.autoApproveEntryChars) {
        throw new InvalidInput({
          reason: `autoApprove entry too long: ${entry.length} chars (max ${PROFILE_LIMITS.autoApproveEntryChars})`,
        });
      }
      if (!validAutoApproveEntry(entry)) {
        throw new InvalidInput({ reason: `invalid autoApprove entry: ${JSON.stringify(entry)}` });
      }
    }
  }
};

/** The stored profile after a patch; an empty role or persona clears it. */
export const patchedProfile = (
  current: ProfileInfo,
  patch: Partial<ProfileCreate>,
): ProfileInfo => ({
  ...current,
  name: patch.name !== undefined ? patch.name.trim().slice(0, PROFILE_LIMITS.name) : current.name,
  description:
    patch.description !== undefined
      ? patch.description.slice(0, PROFILE_LIMITS.description)
      : current.description,
  persona:
    patch.persona !== undefined ? patch.persona.slice(0, PROFILE_LIMITS.persona) : current.persona,
  timezone: patch.timezone ?? current.timezone,
  model: patch.model !== undefined ? patch.model : current.model,
  toolAllowlist: patch.toolAllowlist !== undefined ? patch.toolAllowlist : current.toolAllowlist,
  policies: { ...current.policies, ...patch.policies },
});

/** Point every conversation that carries this profile at its edited copy. */
export const refreshCopies = (copies: Map<string, ProfileInfo>, next: ProfileInfo): void => {
  for (const [conversationId, copy] of copies) {
    if (copy.owner === next.owner && copy.id === next.id) copies.set(conversationId, next);
  }
};
