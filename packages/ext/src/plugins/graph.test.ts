import { describe, expect, it } from "vite-plus/test";
import { GRAPH_MAX_SOURCE } from "@spriessen/contracts";
import { graphTool, renderGraph } from "./graph.ts";

const FLOW = "flowchart TD\n  A[Plan] --> B{Ready?}\n  B -->|yes| C[Ship]\n  B -->|no| A";

const run = async (args: object) => {
  const result = (await graphTool().execute(
    args as never,
    {} as never,
    {} as never,
  )) as unknown as {
    output: { text: string }[];
    isError?: boolean;
    details?: { type: string; width: number; height: number; title: string | null };
  };
  return { ...result, text: result.output.map((part) => part.text).join("") };
};

describe("graph tool (Pele)", () => {
  it("renders a flowchart to SVG and reports what it drew, never the SVG", async () => {
    const outcome = renderGraph(FLOW, "Release");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.svg.startsWith("<svg")).toBe(true);
    expect(outcome.details).toMatchObject({ type: "flowchart", title: "Release" });
    expect(outcome.details.width).toBeGreaterThan(0);
    const result = await run({ source: FLOW });
    expect(result.isError).toBeUndefined();
    expect(result.text).toMatch(/^drew a flowchart diagram \(\d+×\d+\)/);
    expect(result.text).not.toContain("<svg");
    expect(result.details?.type).toBe("flowchart");
  });

  it("draws the other common types", () => {
    const sources = [
      "sequenceDiagram\n  A->>B: hi\n  B-->>A: hello",
      'pie title Share\n  "A" : 3\n  "B" : 1',
      "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy",
    ];
    for (const source of sources) expect(renderGraph(source).ok).toBe(true);
  });

  it("returns a syntax error with its line and column", async () => {
    const result = await run({ source: "flowchart TD\n  A[Start --> B" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^not drawn: syntax error at line 2, column \d+:/);
  });

  it("names the supported types when the first line is not one", async () => {
    const result = await run({ source: "napkinSketch\n  A --> B" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("unsupported diagram");
    expect(result.text).toContain("sequenceDiagram");
  });

  it("refuses oversize and empty input before rendering", () => {
    const big = `flowchart TD\n${"  A --> B\n".repeat(GRAPH_MAX_SOURCE / 10 + 1)}`;
    const outcome = renderGraph(big);
    expect(outcome).toEqual({ ok: false, error: expect.stringContaining("the limit is") });
    expect(renderGraph("   ")).toEqual({ ok: false, error: "the source is empty" });
  });

  it("keeps links, images and markup out of the SVG", () => {
    const outcome = renderGraph(
      'flowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B\n  click A "https://example.invalid" "go"',
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.svg).not.toMatch(/<img|onerror|<a\b|href=|<script/i);
  });
});
