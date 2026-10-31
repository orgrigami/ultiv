/**
 * A bot's two plain-text files, Persona and Instructions (docs/BOT-FILES.md),
 * kept with full version history in the version store under
 * {BOT_FILES_DIR}/{owner}/{profile}/. The Persona file supersedes the old
 * `persona` field; every Persona save also writes that field (profiles
 * update), so the field stays readable for one release and a rollback loses
 * nothing but Instructions.
 */
import type { ProfileInfo } from "@spriessen/contracts";
import { resolveInside } from "@spriessen/core";
import {
  appendVersion,
  currentOf,
  historyOf,
  saveIfChanged,
  type SaveMeta,
  type Version,
} from "../versions/store.ts";

export const BOT_FILES = ["persona", "instructions"] as const;
export type BotFile = (typeof BOT_FILES)[number];

export const isBotFile = (value: unknown): value is BotFile =>
  typeof value === "string" && (BOT_FILES as readonly string[]).includes(value);

export const BOT_FILE_LIMITS: Readonly<Record<BotFile, number>> = {
  persona: 8_000,
  instructions: 16_000,
};

/** The folder root (relative to the server's cwd, like ARTIFACTS_DIR). */
export const botFilesDir = (): string => {
  const configured = process.env.BOT_FILES_DIR?.trim();
  return configured !== undefined && configured !== "" ? configured : "var/bot-files";
};

const SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;

export interface BotFileState {
  readonly text: string;
  readonly version: number;
}

export interface BotFilesService {
  /** Create the missing files from the old field (repeatable); returns how many were written. */
  readonly ensure: (profile: ProfileInfo) => number;
  /** Run ensure for every bot; returns the files written. */
  readonly migrate: (profiles: readonly ProfileInfo[]) => number;
  /** The current text (created on first read). */
  readonly read: (profile: ProfileInfo, file: BotFile) => BotFileState;
  readonly history: (profile: ProfileInfo, file: BotFile) => Version[];
  /** Save a version unless nothing changed; a restore always saves. */
  readonly save: (
    profile: ProfileInfo,
    file: BotFile,
    text: string,
    meta: SaveMeta,
  ) => Version | undefined;
}

export const botFiles = (root: string = botFilesDir()): BotFilesService => {
  const dirOf = (profile: ProfileInfo): string => {
    if (!SEGMENT.test(profile.owner) || !SEGMENT.test(profile.id)) {
      throw new Error("bad bot scope");
    }
    return resolveInside(root, profile.owner, profile.id);
  };
  const ensure = (profile: ProfileInfo): number => {
    const dir = dirOf(profile);
    let written = 0;
    if (currentOf(dir, "persona") === undefined) {
      appendVersion(dir, "persona", profile.persona.slice(0, BOT_FILE_LIMITS.persona), {
        by: "migration",
        reason: "Copied from the old persona field",
      });
      written += 1;
    }
    if (currentOf(dir, "instructions") === undefined) {
      appendVersion(dir, "instructions", "", { by: "migration", reason: "Starts empty" });
      written += 1;
    }
    return written;
  };
  return {
    ensure,
    migrate: (profiles) => profiles.reduce((sum, profile) => sum + ensure(profile), 0),
    read: (profile, file) => {
      ensure(profile);
      const current = currentOf(dirOf(profile), file);
      return { text: current?.text ?? "", version: current?.n ?? 0 };
    },
    history: (profile, file) => {
      ensure(profile);
      return historyOf(dirOf(profile), file);
    },
    save: (profile, file, text, meta) => {
      ensure(profile);
      const clipped = text.slice(0, BOT_FILE_LIMITS[file]);
      return meta.restoredFrom !== undefined
        ? appendVersion(dirOf(profile), file, clipped, meta)
        : saveIfChanged(dirOf(profile), file, clipped, meta);
    },
  };
};
