/**
 * Writes the app icons from the brand geometry (src/lib/brand.ts):
 * public/icons/icon.svg (favicon and any-size icon), maskable.svg, and the
 * PNG sizes the manifest, the favicon fallback and iOS need.
 *
 *   node --experimental-strip-types scripts/brand-icons.ts
 *
 * PNGs render with headless Chromium through Playwright, which is not a
 * dependency of this repo: point PLAYWRIGHT_FROM at a directory whose
 * node_modules has it (an npx cache works). Without it only the SVGs change.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { markSvg } from "../src/lib/brand.ts";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(out, { recursive: true });

const icon = markSvg();
const maskable = markSvg({ pad: 0.26, rounded: false });
const touch = markSvg({ pad: 0.18, rounded: false });
writeFileSync(join(out, "icon.svg"), icon);
writeFileSync(join(out, "maskable.svg"), maskable);

const pngs: readonly { file: string; svg: string; size: number }[] = [
  { file: "icon-192.png", svg: icon, size: 192 },
  { file: "icon-512.png", svg: icon, size: 512 },
  { file: "maskable-512.png", svg: maskable, size: 512 },
  { file: "apple-touch-icon.png", svg: touch, size: 180 },
  { file: "favicon-32.png", svg: icon, size: 32 },
];

interface Shot {
  setContent: (html: string) => Promise<void>;
  screenshot: (options: { omitBackground: boolean }) => Promise<Uint8Array>;
  close: () => Promise<void>;
}
interface Browser {
  newPage: (options: { viewport: { width: number; height: number } }) => Promise<Shot>;
  close: () => Promise<void>;
}

const from = process.env["PLAYWRIGHT_FROM"];
if (from === undefined) {
  console.log("Wrote icon.svg and maskable.svg. Set PLAYWRIGHT_FROM to render the PNGs.");
} else {
  const { chromium } = createRequire(join(from, "noop.js"))("playwright") as {
    chromium: { launch: () => Promise<Browser> };
  };
  const browser = await chromium.launch();
  for (const { file, svg, size } of pngs) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    writeFileSync(join(out, file), await page.screenshot({ omitBackground: true }));
    await page.close();
  }
  await browser.close();
  console.log(`Wrote the SVGs and ${pngs.length} PNGs to public/icons.`);
}
