import { render } from "pele";
import { describe, expect, it } from "vite-plus/test";
import { sanitizeSvg } from "./svg-sanitize.ts";

const HOSTILE = [
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" viewBox="0 0 10 10">',
  "<script>alert(2)</script>",
  '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://tracker.invalid/p.png"></div></foreignObject>',
  '<a href="javascript:alert(3)"><text>click</text></a>',
  '<image href="https://tracker.invalid/i.png"/>',
  '<use href="https://evil.invalid/sprite.svg#x"/><use href="#ok"/>',
  '<rect style="fill:url(https://tracker.invalid/f)" width="5" height="5"/>',
  '<rect style="background:u\\72l(https://tracker.invalid/g)" fill="url(#grad)"/>',
  '<path d="M0 0" onclick="x()" ONMOUSEOVER="y()" xlink:href="&#106;avascript:z()"/>',
  "<style>@import url(https://evil.invalid/x.css);</style>",
  '<!-- <script>hidden()</script> --><animate attributeName="href" to="javascript:a()"/>',
  '<set attributeName="onload" to="b()"/><text>2 &lt; 3 &amp; ok</text>',
  "</svg>",
].join("");

describe("sanitizeSvg", () => {
  const clean = sanitizeSvg(HOSTILE);

  it("drops scripts, handlers, foreign content, links (with their text) and animation", () => {
    expect(clean).not.toMatch(/<script|alert|onload|onclick|onmouseover|<foreignObject|<div|<img/i);
    expect(clean).not.toContain("click");
    expect(clean).not.toMatch(/<a\b|<image|<animate|<set|<style|@import|javascript/i);
  });

  it("keeps nothing that loads from outside", () => {
    expect(clean).not.toMatch(/https:|tracker|evil/);
    expect(clean).toContain('<use href="#ok"/>');
    expect(clean).toContain('fill="url(#grad)"');
  });

  it("keeps the drawing and its text", () => {
    expect(clean).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">');
    expect(clean).toContain('<rect width="5" height="5"/>');
    expect(clean).toContain("<text>2 &lt; 3 &amp; ok</text>");
    expect(clean.endsWith("</svg>")).toBe(true);
  });

  it("escapes a stray angle bracket instead of opening a tag", () => {
    expect(sanitizeSvg("<svg><text>a <b c</text></svg>")).toBe("<svg><text>a &lt;b c</text></svg>");
  });

  it("leaves real Pele output intact", () => {
    const sources = [
      "flowchart TD\n  A[Plan] --> B{Ready?}\n  B -->|yes| C[Ship]\n  B -->|no| A",
      "sequenceDiagram\n  Alice->>Bob: hi\n  Bob-->>Alice: hello",
      'pie title Share\n  "A" : 3\n  "B" : 1',
      "classDiagram\n  Animal <|-- Duck\n  Animal : +int age",
    ];
    for (const source of sources) {
      const { svg } = render(source, { links: false, images: false });
      const normal = (markup: string) => markup.replace(/'/g, '"').replace(/&#39;/g, "'");
      const kept = sanitizeSvg(svg);
      expect(kept.length).toBeGreaterThan(svg.length * 0.95);
      expect(kept.match(/<[a-zA-Z]/g)?.length).toBe(svg.match(/<[a-zA-Z]/g)?.length);
      expect(normal(kept)).toContain(normal(svg.slice(0, svg.indexOf(">"))).slice(0, 40));
    }
  });
});
