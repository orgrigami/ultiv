/**
 * Test runs never fetch models.dev nor read the owner's catalog files: every
 * mind a test opens boots on an empty model catalog (validation then accepts
 * any model ref). Loaded by the root and the package vite configs.
 */
export const offlineCatalogEnv: Record<string, string> = {
  MODELS_DEV_URL: "off",
  MODELS_DEV_CACHE: "var/test-catalog-absent/models-dev.json",
  MODELS_OVERLAY: "var/test-catalog-absent/models.local.json",
};
