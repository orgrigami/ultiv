/**
 * The approval mode in words: the chat chip's short label and tone, and the
 * rule that turning approvals off (YOLO) always asks first. The floors listed
 * here mirror the server's (packages/mind entity-parts: isApprovalFloor
 * outranks every mode).
 */
import type { ProfileApprovalMode } from "@spreissen/contracts";

export const APPROVAL_MODES: readonly ProfileApprovalMode[] = ["manual", "jev", "yolo"];

export interface ModeChip {
  label: string;
  /** neutral = you or Jev decide; warning = nobody asks. */
  tone: "neutral" | "warning";
  /** One line for the menu. */
  hint: string;
}

export const MODE_CHIP: Record<ProfileApprovalMode, ModeChip> = {
  manual: { label: "Manual", tone: "neutral", hint: "You approve each step that needs it." },
  jev: {
    label: "Jev",
    tone: "neutral",
    hint: "Jev approves low-risk steps and asks you about the rest.",
  },
  yolo: { label: "YOLO", tone: "warning", hint: "Steps run without asking." },
};

/** What still asks the owner in YOLO mode. */
export const YOLO_STILL_ASKS: readonly string[] = [
  "The first time a saved login is used on a site",
  "The first time a connector is used, and any change to connectors",
  "A bot asking you for a secret",
];

/** Switching into YOLO needs a confirmation; every other switch is immediate. */
export function needsConfirm(from: ProfileApprovalMode, to: ProfileApprovalMode): boolean {
  return to === "yolo" && from !== "yolo";
}

export function isApprovalMode(value: unknown): value is ProfileApprovalMode {
  return APPROVAL_MODES.includes(value as ProfileApprovalMode);
}
