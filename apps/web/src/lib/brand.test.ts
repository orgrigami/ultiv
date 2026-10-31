import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { BRAND, MARK, markSvg, pageTitle } from "./brand.ts";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

describe("brand", () => {
  it("names the app once", () => {
    expect(BRAND.name).toBe("Spreissen");
    expect(BRAND.wordmark).toBe(BRAND.name.toLowerCase());
    expect(pageTitle()).toBe("Spreissen");
    expect(pageTitle("  ")).toBe("Spreissen");
    expect(pageTitle("Past chats")).toBe("Past chats · Spreissen");
  });

  it("keeps hype out of the copy", () => {
    for (const line of [BRAND.tagline, BRAND.description])
      expect(line).not.toMatch(/\bAI\b|powerful|seamless|revolution|magic|!/i);
  });

  it("draws the mark the same way every time", () => {
    expect(markSvg()).toBe(markSvg());
    expect(markSvg()).toContain(BRAND.colors.amber);
    expect(markSvg()).toContain('rx="112"');
    expect(markSvg({ rounded: false })).not.toContain('rx="112"');
    expect(markSvg({ background: null })).not.toContain("<rect");
    expect(markSvg().match(/<ellipse/g)).toHaveLength(MARK.eyes.length);
  });

  it("matches the shipped icon, manifest and page shell", () => {
    expect(read("../../public/icons/icon.svg")).toBe(markSvg());
    const manifest = JSON.parse(read("../../public/manifest.webmanifest")) as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({
      name: BRAND.name,
      short_name: BRAND.name,
      description: BRAND.description,
      theme_color: BRAND.colors.ink,
      background_color: BRAND.colors.ink,
    });
    const html = read("../../index.html");
    expect(html).toContain(`<title>${BRAND.name}</title>`);
    expect(html).toContain(BRAND.colors.ink);
    expect(html).toContain(BRAND.description);
  });
});
