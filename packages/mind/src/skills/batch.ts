/**
 * The batch engine: several skill ops over one profile applied
 * ALL-OR-NOTHING. Phase A validates every op against the store and the
 * content rules before touching disk; any refusal aborts the whole batch
 * with the failing op's index. Phase B snapshots every affected skill
 * (index row, body, reference files, version history) in memory, then
 * applies; if a write fails mid-batch the snapshots are restored, so the
 * caller never observes a half-applied batch and no orphan versions are
 * left behind. Each applied op still appends its own version entry (same
 * discipline as skill_write): atomic means all-or-nothing, not one merged
 * version. `remove` is a legal store op (the consolidation accept path is
 * its only caller); the bot-facing skill_edit tool refuses it.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Data } from "effect";
import { resolveInside } from "@spriessen/core";
import type { SkillOrigin } from "@spriessen/contracts";
import {
  MAX_DESCRIPTION_CHARS,
  MAX_SKILL_CHARS,
  secretIn,
  skillFilesRefusal,
  slugOk,
} from "./guard.ts";
import { parseSkillDoc } from "./frontmatter.ts";
import type { Version, VersionAuthor } from "../versions/store.ts";
import {
  type BuiltinSkill,
  type ProfileIndex,
  type SkillFileIn,
  readIndex,
  readSkill,
  readSkillFile,
  removeSkill,
  skillVersions,
  skillsOf,
  versionsOf,
  writeIndex,
  writeSkill,
} from "./store.ts";

/** Ops in one batch, and the per-op ceiling. */
export const MAX_SKILL_OPS = 8;

export type SkillOp =
  | {
      readonly op: "create";
      readonly name: string;
      readonly body: string;
      readonly files?: readonly SkillFileIn[];
    }
  | {
      readonly op: "update";
      readonly name: string;
      readonly body: string;
      readonly files?: readonly SkillFileIn[];
      /** Names merged into this skill (consolidation accept); recorded on the index row. */
      readonly absorbed?: readonly string[];
    }
  | { readonly op: "remove"; readonly name: string };

/** The whole batch is refused: the failing op's index (0-based) and why. */
export class SkillBatchRefused extends Data.TaggedError("spriessen/SkillBatchRefused")<{
  readonly op: number;
  readonly reason: string;
}> {}

/** One applied op, for tool output (JsonValue-compatible type alias). */
export type SkillOpOutcome = {
  readonly op: string;
  readonly name: string;
  readonly version?: number;
  readonly removed?: boolean;
};

export interface ApplyOpsOptions {
  readonly builtins: readonly BuiltinSkill[];
  /** Who saves, for the history; defaults by origin (owner, else bot). */
  readonly by?: VersionAuthor;
  /** The turn a bot's batch came from (conversation and call). */
  readonly turn?: string;
  /** Origin for created skills; updates keep the stored origin. Defaults "self". */
  readonly origin?: SkillOrigin;
  /** authorProfile for created skills; defaults to the profile itself. */
  readonly authorProfile?: string | null;
  /** Marker in each applied op's version reason; defaults to "batch". */
  readonly note?: string;
  /**
   * Per-op content gate (skill_edit passes the shared skill gate). A
   * refusal at any op aborts the batch before anything is written.
   */
  readonly gate?: (
    input: {
      readonly name: string;
      readonly body: string;
      readonly files?: readonly SkillFileIn[];
    },
    index: number,
  ) => Promise<string | undefined>;
}

const refuse = (op: number, reason: string): SkillBatchRefused =>
  new SkillBatchRefused({ op, reason });

/** One op's body-level refusals (same rules as skill_write's store checks). */
const bodyRefusal = (op: number, name: string, body: string): void => {
  if (body.length > MAX_SKILL_CHARS) {
    throw refuse(op, `the body of "${name}" exceeds ${MAX_SKILL_CHARS} chars`);
  }
  const secret = secretIn(body);
  if (secret !== null) {
    throw refuse(op, `the body of "${name}" looks like it contains ${secret}`);
  }
  const doc = parseSkillDoc(body);
  if (doc === undefined) {
    throw refuse(op, `"${name}" needs frontmatter (---\nname: …\ndescription: …\n---)`);
  }
  if (doc.description.length > MAX_DESCRIPTION_CHARS) {
    throw refuse(op, `the description of "${name}" exceeds ${MAX_DESCRIPTION_CHARS} chars`);
  }
};

/** Phase A: validate every op before touching disk; any refusal kills the batch. */
const validateBatch = (
  root: string,
  owner: string,
  profile: string,
  ops: readonly SkillOp[],
  builtins: readonly BuiltinSkill[],
): void => {
  if (ops.length === 0) throw refuse(0, "the batch carries no ops");
  if (ops.length > MAX_SKILL_OPS) {
    throw refuse(0, `a batch carries at most ${MAX_SKILL_OPS} ops (got ${ops.length})`);
  }
  const seen = new Set<string>();
  for (const [index, item] of ops.entries()) {
    if (item.op !== "create" && item.op !== "update" && item.op !== "remove") {
      throw refuse(index, `op ${index + 1} has an unknown kind`);
    }
    if (!slugOk(item.name)) {
      throw refuse(index, `"${item.name}" is not a skill name (lowercase-and-hyphens, at most 64)`);
    }
    if (seen.has(item.name)) {
      throw refuse(index, `"${item.name}" appears twice in this batch`);
    }
    seen.add(item.name);
    if (builtins.some((skill) => skill.name === item.name)) {
      throw refuse(index, `"${item.name}" is a built-in skill: read-only, it updates with the app`);
    }
    const existing = readSkill(root, owner, profile, item.name, builtins) !== undefined;
    if (item.op === "create" && existing) {
      throw refuse(index, `"${item.name}" already exists: use update`);
    }
    if (item.op !== "create" && !existing) {
      throw refuse(index, `no skill named "${item.name}" to ${item.op}`);
    }
    if (item.op !== "remove") {
      bodyRefusal(index, item.name, item.body);
      const files = skillFilesRefusal(item.files ?? []);
      if (files !== null) throw refuse(index, files);
    }
  }
};

/** A skill's full current state, snapshotted before Phase B touches anything. */
interface SkillSnapshot {
  readonly row: ProfileIndex["skills"][string] | undefined;
  readonly body: string | undefined;
  readonly files: Record<string, string>;
  readonly versions: Version[];
}

const snapshotOf = (
  root: string,
  owner: string,
  profile: string,
  name: string,
  builtins: readonly BuiltinSkill[],
): SkillSnapshot => {
  const found = readSkill(root, owner, profile, name, builtins);
  const files: Record<string, string> = {};
  if (found !== undefined) {
    for (const rel of found.meta.files) {
      files[rel] = readSkillFile(root, owner, profile, name, rel, builtins) ?? "";
    }
  }
  return {
    row: readIndex(root, owner, profile).skills[name],
    body: found?.body,
    files,
    versions: skillVersions(root, owner, profile, name),
  };
};

/** Put one snapshotted skill back on disk exactly as it was. */
const restoreSkill = (
  root: string,
  owner: string,
  profile: string,
  name: string,
  snap: SkillSnapshot,
): void => {
  rmSync(resolveInside(skillsOf(root, owner, profile), name), { recursive: true, force: true });
  if (snap.row === undefined) {
    rmSync(resolveInside(versionsOf(root, owner, profile), `${name}.versions.json`), {
      force: true,
    });
    const index = readIndex(root, owner, profile);
    delete index.skills[name];
    writeIndex(root, owner, profile, index);
    return;
  }
  const dir = resolveInside(skillsOf(root, owner, profile), name);
  mkdirSync(dir, { recursive: true });
  if (snap.body !== undefined) {
    writeFileSync(resolveInside(dir, "SKILL.md"), snap.body, "utf8");
  }
  for (const [rel, content] of Object.entries(snap.files)) {
    const target = resolveInside(dir, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  writeFileSync(
    resolveInside(versionsOf(root, owner, profile), `${name}.versions.json`),
    `${JSON.stringify({ versions: snap.versions }, null, 1)}\n`,
    "utf8",
  );
  const index = readIndex(root, owner, profile);
  index.skills[name] = snap.row;
  writeIndex(root, owner, profile, index);
};

/** Undo every op in the batch (best effort); returns per-skill failure lines. */
const restoreAll = (
  root: string,
  owner: string,
  profile: string,
  snaps: ReadonlyMap<string, SkillSnapshot>,
): string[] => {
  const failures: string[] = [];
  for (const [name, snap] of snaps) {
    try {
      restoreSkill(root, owner, profile, name, snap);
    } catch (cause) {
      failures.push(`${name}: ${String(cause)}`);
    }
  }
  return failures;
};

/**
 * Validate all ops, then apply them in order behind snapshots: a failure
 * anywhere restores every affected skill to its pre-batch state and
 * surfaces the original refusal. Each applied write appends its own
 * version entry with the batch marker and the op kind as its reason.
 */
export const applyOps = async (
  root: string,
  owner: string,
  profile: string,
  ops: readonly SkillOp[],
  options: ApplyOpsOptions,
): Promise<SkillOpOutcome[]> => {
  const { builtins } = options;
  validateBatch(root, owner, profile, ops, builtins);
  if (options.gate !== undefined) {
    for (const [index, item] of ops.entries()) {
      if (item.op === "remove") continue;
      const refused = await options.gate(
        {
          name: item.name,
          body: item.body,
          ...(item.files !== undefined ? { files: item.files } : {}),
        },
        index,
      );
      if (refused !== undefined) throw refuse(index, refused);
    }
  }
  const snaps = new Map<string, SkillSnapshot>();
  for (const item of ops) {
    if (!snaps.has(item.name))
      snaps.set(item.name, snapshotOf(root, owner, profile, item.name, builtins));
  }
  const outcomes: SkillOpOutcome[] = [];
  try {
    for (const item of ops) {
      if (item.op === "remove") {
        removeSkill(root, owner, profile, item.name, builtins);
        outcomes.push({ op: "remove", name: item.name, removed: true });
        continue;
      }
      const existing = readSkill(root, owner, profile, item.name, builtins);
      const meta = writeSkill(
        root,
        owner,
        profile,
        {
          name: item.name,
          body: item.body,
          ...(item.files !== undefined ? { files: item.files } : {}),
          ...(item.op === "update" && item.absorbed !== undefined
            ? { absorbed: item.absorbed }
            : {}),
          origin: existing === undefined ? (options.origin ?? "self") : existing.meta.origin,
          authorProfile:
            existing === undefined
              ? (options.authorProfile ?? profile)
              : existing.meta.authorProfile,
          by: options.by ?? (options.origin === "owner" ? "owner" : "bot"),
          ...(options.turn !== undefined ? { turn: options.turn } : {}),
          note: `${options.note ?? "batch"} ${item.op}`,
        },
        builtins,
      );
      outcomes.push({ op: item.op, name: meta.name, version: meta.version });
    }
  } catch (cause) {
    const failures = restoreAll(root, owner, profile, snaps);
    const detail = failures.length > 0 ? `; restore also failed: ${failures.join("; ")}` : "";
    if (cause instanceof Error && failures.length === 0) throw cause;
    throw new Error(`batch failed and was rolled back: ${String(cause)}${detail}`);
  }
  if (outcomes.length !== ops.length) {
    throw refuse(ops.length - 1, "the batch stopped early");
  }
  return outcomes;
};
