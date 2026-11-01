import { describe, expect, it } from "vite-plus/test";
import { MAX_PAGE_TEXT_CHARS, pageTextOf, pageTitleOf } from "./text.ts";

const PAGE = `<!doctype html><html><head><title>Example &amp; Co</title>
<style>body { color: red }</style></head>
<body><h1>Hello</h1><script>alert("evil")</script>
<p>First&nbsp;line &amp; more &#x2713;</p>
<div>Second<br>line</div></body></html>`;

describe("page text extraction (browser_open)", () => {
  it("keeps visible text, drops scripts, styles and tags, decodes entities", () => {
    const { text, truncated } = pageTextOf(PAGE);
    expect(truncated).toBe(false);
    expect(text).toContain("Hello");
    expect(text).toContain("First line & more ✓");
    expect(text).toContain("Second");
    expect(text).toContain("line");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color: red");
    expect(text).not.toContain("<");
  });

  it("reads the title, decoded and squeezed", () => {
    expect(pageTitleOf(PAGE)).toBe("Example & Co");
    expect(pageTitleOf("<html><body>no title</body></html>")).toBeUndefined();
  });

  it("caps the text and says so instead of silently truncating", () => {
    const big = `<html><body><p>${"word ".repeat(10_000)}</p></body></html>`;
    const { text, truncated } = pageTextOf(big, 500);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThan(600);
    expect(text).toContain("truncated");
    expect(MAX_PAGE_TEXT_CHARS).toBe(20_000);
  });
});
