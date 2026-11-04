import { defineConfig } from "vite-plus";

// `vp -C apps/cli build`: one ESM file for the `spriessen` bin, so plain Node
// runs the TSX terminal UI. Every package import stays external — the
// workspace packages load from their sources (Node strips their types) and
// OpenTUI's native library from its platform package.
export default defineConfig({
  build: {
    ssr: "src/main.ts",
    outDir: "dist",
    target: "node26",
    emptyOutDir: true,
    rollupOptions: {
      external: (id) => !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0"),
      // The UI stays its own chunk, so `bots` or `ask` never load OpenTUI.
      output: { entryFileNames: "spriessen.mjs", chunkFileNames: "[name]-[hash].mjs" },
    },
  },
  oxc: { jsx: { runtime: "automatic", importSource: "@opentui/react" } },
});
