#!/usr/bin/env node
// The `spriessen` command. The built bundle (vp -C apps/cli build) runs
// everything, the terminal UI included; without it the source entry runs
// every command except the UI (plain Node cannot load TSX — use `vpx
// apps/cli/src/main.ts` there).
import { existsSync } from "node:fs";

// OpenTUI draws through Node's FFI, which still warns as experimental on
// every start; that one line is noise in a terminal UI. Every other warning stays.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) =>
  String(warning).includes("FFI is an experimental") ? undefined : emitWarning(warning, ...rest);

const bundle = new URL("../dist/spriessen.mjs", import.meta.url);
const entry = existsSync(bundle) ? bundle : new URL("../src/main.ts", import.meta.url);
const { main } = await import(entry.href);
process.exitCode = await main(process.argv.slice(2));
