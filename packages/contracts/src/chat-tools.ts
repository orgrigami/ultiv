/**
 * The two chat-surface tools whose cards the web draws from their real
 * arguments: `checklist` (the bot's short task list for this chat) and
 * `graph` (a Mermaid diagram). The parameter schemas live here so the mind's
 * tools and the web's cards read the SAME names, and the caps are one number.
 */
import { Type, type Static } from "typebox";

export const CHECKLIST_TOOL = "checklist";
export const GRAPH_TOOL = "graph";

/** At most this many items in one list. */
export const CHECKLIST_MAX_ITEMS = 12;
/** One item's text, in characters. */
export const CHECKLIST_MAX_TEXT = 120;
/** The list's optional title, in characters. */
export const CHECKLIST_MAX_TITLE = 60;

export const ChecklistStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("done"),
]);
export type ChecklistStatus = Static<typeof ChecklistStatusSchema>;

export const ChecklistItemSchema = Type.Object({
  text: Type.String({
    minLength: 1,
    maxLength: CHECKLIST_MAX_TEXT,
    description: "One step, short.",
  }),
  status: ChecklistStatusSchema,
});
export type ChecklistItem = Static<typeof ChecklistItemSchema>;

export const ChecklistParamsSchema = Type.Object({
  items: Type.Optional(
    Type.Array(ChecklistItemSchema, {
      minItems: 1,
      maxItems: CHECKLIST_MAX_ITEMS,
      description: "The WHOLE list, replacing the current one. Use it to start or re-plan.",
    }),
  ),
  update: Type.Optional(
    Type.Array(
      Type.Object({
        item: Type.Integer({ minimum: 1, description: "The item's number, from 1." }),
        status: Type.Optional(ChecklistStatusSchema),
        text: Type.Optional(Type.String({ minLength: 1, maxLength: CHECKLIST_MAX_TEXT })),
      }),
      {
        minItems: 1,
        maxItems: CHECKLIST_MAX_ITEMS,
        description: "Changes to items of the current list, by number. Use it to tick steps off.",
      },
    ),
  ),
  title: Type.Optional(
    Type.String({ maxLength: CHECKLIST_MAX_TITLE, description: "A short name for the list." }),
  ),
});
export type ChecklistParams = Static<typeof ChecklistParamsSchema>;

/** The tool's UI channel: the list as it stands after the call (JSON, stored as is). */
export type ChecklistDetails = {
  /** Same id = same card; a fresh list after a finished one gets a new id. */
  listId: string;
  title: string | null;
  items: ChecklistItem[];
};

/** Mermaid source the graph tool accepts, in characters. */
export const GRAPH_MAX_SOURCE = 20_000;
/** The diagram's optional caption, in characters. */
export const GRAPH_MAX_TITLE = 80;

export const GraphParamsSchema = Type.Object({
  source: Type.String({
    minLength: 1,
    maxLength: GRAPH_MAX_SOURCE,
    description: "Mermaid text, starting with the diagram type (flowchart TD, sequenceDiagram, …).",
  }),
  title: Type.Optional(
    Type.String({ maxLength: GRAPH_MAX_TITLE, description: "A short caption for the diagram." }),
  ),
});
export type GraphParams = Static<typeof GraphParamsSchema>;

/** The tool's UI channel on success: what was drawn. */
export type GraphDetails = {
  readonly type: string;
  readonly width: number;
  readonly height: number;
  readonly title: string | null;
};
