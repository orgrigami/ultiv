/**
 * How a skill's origin reads on its badge: built in, the bot's own, the
 * owner's, or installed from a URL.
 */

import type { SkillOrigin } from "@spriessen/contracts";

export const ORIGIN_LABEL: Record<SkillOrigin, string> = {
  builtin: "built-in",
  self: "self-written",
  owner: "owner",
  url: "installed",
};

export const ORIGIN_VARIANT: Record<SkillOrigin, "secondary" | "default" | "outline"> = {
  builtin: "secondary",
  self: "default",
  owner: "outline",
  url: "outline",
};
