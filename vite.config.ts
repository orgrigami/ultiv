import { defineConfig } from "vite-plus";
import { offlineCatalogEnv } from "./packages/mind/test-env.ts";

export default defineConfig({
  fmt: {
    ignorePatterns: ["apps/web/src/routeTree.gen.ts"],
  },
  test: { env: offlineCatalogEnv },
});
