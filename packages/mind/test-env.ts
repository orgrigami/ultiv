/**
 * Test runs never fetch models.dev nor read the owner's catalog files: every
 * mind a test opens boots on an empty model catalog (validation then accepts
 * any model ref). Bot files (Persona and Instructions) land in a scratch
 * folder, never the repo's var/ — per worker, see test-setup.ts. Loaded by
 * the root and the package vite configs.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

export const offlineCatalogEnv: Record<string, string> = {
  MODELS_DEV_URL: "off",
  MODELS_DEV_CACHE: "var/test-catalog-absent/models-dev.json",
  MODELS_OVERLAY: "var/test-catalog-absent/models.local.json",
  BOT_FILES_DIR: join(tmpdir(), "spriessen-test-bot-files"),
};
