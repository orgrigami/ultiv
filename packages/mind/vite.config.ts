import { defineConfig } from "vite-plus";
import { offlineCatalogEnv } from "./test-env.ts";

export default defineConfig({
  test: { env: offlineCatalogEnv },
});
