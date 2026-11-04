import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import { offlineCatalogEnv } from "./packages/mind/test-env.ts";

export default defineConfig({
  fmt: {
    ignorePatterns: ["apps/web/src/routeTree.gen.ts"],
  },
  // apps/web's `@/*` alias, so its component tests also run from the root.
  resolve: { alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) } },
  test: { env: offlineCatalogEnv, setupFiles: ["./packages/mind/test-setup.ts"] },
});
