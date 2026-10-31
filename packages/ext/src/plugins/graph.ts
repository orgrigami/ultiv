/**
 * The `graph` tool: Mermaid text rendered to SVG with Pele (MIT, zero
 * dependencies), here on the server, so the bot learns at once whether its
 * diagram draws — and, when it does not, gets Pele's line, column and caret
 * to fix it. The SVG itself never enters the model's context; the web draws
 * the same source as a themed, sanitized card. Links and images are off.
 */
import { PeleError, render } from "pele";
import {
  GRAPH_MAX_SOURCE,
  GRAPH_TOOL,
  GraphParamsSchema,
  type GraphDetails,
} from "@spriessen/contracts";
import { definePlugin, toolCapability, type Plugin } from "../plugin.ts";
import { defineTool, type Tool } from "../tool.ts";

/** Types worth naming when the first line is not a diagram type. */
const COMMON_TYPES =
  "flowchart TD, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, pie, " +
  "mindmap, timeline, journey or gitGraph";

export type GraphOutcome =
  | { readonly ok: true; readonly details: GraphDetails; readonly svg: string }
  | { readonly ok: false; readonly error: string };

/** Pele's error, in words a model can act on. */
const errorText = (error: unknown): string => {
  if (!(error instanceof PeleError)) {
    return `could not draw the diagram: ${error instanceof Error ? error.message : String(error)}`;
  }
  switch (error.code) {
    case "unsupported-diagram":
      return `unsupported diagram: the first line must name a Mermaid diagram type, such as ${COMMON_TYPES}`;
    case "syntax":
      return `syntax error at line ${error.line}, column ${error.column}: ${error.message}`;
    case "limit":
      return `the diagram is too large to draw: ${error.message}; split it into smaller diagrams`;
    default:
      return `the diagram does not make sense: ${error.message}`;
  }
};

/** Render one source; the outcome the tool reports and the tests read. */
export const renderGraph = (source: string, title?: string): GraphOutcome => {
  if (source.trim() === "") return { ok: false, error: "the source is empty" };
  if (source.length > GRAPH_MAX_SOURCE) {
    return {
      ok: false,
      error: `the source is ${source.length} characters; the limit is ${GRAPH_MAX_SOURCE}. Split it into smaller diagrams`,
    };
  }
  try {
    const drawn = render(source, { links: false, images: false, limit: GRAPH_MAX_SOURCE });
    const caption = title?.trim();
    return {
      ok: true,
      svg: drawn.svg,
      details: {
        type: drawn.type,
        width: Math.round(drawn.width),
        height: Math.round(drawn.height),
        title: caption === undefined || caption === "" ? null : caption,
      },
    };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
};

export const GRAPH_DESCRIPTION =
  "Draw a diagram for the owner from Mermaid text (flowchart, sequence, class, state, ER, " +
  "gantt, pie, mindmap, timeline, …). It shows in the chat as a diagram card, so do not " +
  "repeat the source in your reply. Use it when a picture explains structure or flow " +
  "better than prose. A syntax error comes back with its line and column: fix and call again.";

export const graphTool = (): Tool =>
  defineTool({
    name: GRAPH_TOOL,
    description: GRAPH_DESCRIPTION,
    parameters: GraphParamsSchema,
    replay: "safe",
    execute: (args) => {
      const outcome = renderGraph(args.source, args.title);
      if (!outcome.ok) {
        return Promise.resolve({
          output: [{ type: "text" as const, text: `not drawn: ${outcome.error}` }],
          isError: true as const,
        });
      }
      const { type, width, height } = outcome.details;
      return Promise.resolve({
        output: [
          {
            type: "text" as const,
            text: `drew a ${type} diagram (${width}×${height}); the owner sees it in the chat`,
          },
        ],
        details: outcome.details,
      });
    },
  });

/** Diagrams as an installable plugin; needs no key, always on. */
export const graphPlugin = (): Plugin =>
  definePlugin({
    id: "ultiv.graph",
    version: "1.0.0",
    description: "Mermaid diagrams rendered to SVG with Pele: the `graph` tool.",
    capabilities: [toolCapability(graphTool())],
  });
