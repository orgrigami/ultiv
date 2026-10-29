/**
 * Skill content rules, enforced wherever skill text enters the store: slugs
 * are filesystem-and-tool safe, bodies are bounded, and secret-shaped text
 * is refused outright (the memory guard's rule, one tier up: a skill is
 * instructions, and instructions never carry credentials). The scan is
 * deliberately high-precision: a few token shapes, not a keyword fog.
 */

export const SKILL_SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const MAX_SKILL_CHARS = 20_000;
export const MAX_SKILL_FILE_CHARS = 100_000;

export const slugOk = (name: string): boolean => SKILL_SLUG.test(name);

/** "invoice-workflow" from "Invoice Workflow!" when an install omits a name. */
export const slugify = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");

const SECRET_PATTERNS: readonly { readonly kind: string; readonly re: RegExp }[] = [
  { kind: "a private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "an AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "an sk- shaped API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { kind: "a Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "a GitHub token", re: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { kind: "a Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "a bearer credential", re: /\bBearer [A-Za-z0-9._~+/=-]{28,}\b/ },
];

/** The first secret-shaped match, for the refusal line; null when clean. */
export const secretIn = (text: string): string | null => {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(text)) return pattern.kind;
  }
  return null;
};

/** Relative paths a skill's extra files may take (no traversal, no absolute). */
export const relativePathOk = (rel: string): boolean =>
  rel.length > 0 &&
  rel.length <= 200 &&
  !rel.startsWith("/") &&
  !rel.split("/").includes("..") &&
  !rel.includes("\\") &&
  /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(rel);
