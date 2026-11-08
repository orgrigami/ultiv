/**
 * MCP input schemas are plain JSON Schema from a third party. The harness
 * compiles them with pi-schema to validate arguments; a schema it cannot
 * compile (odd keywords, unresolved refs) falls back to a permissive object
 * so one bad tool never breaks a turn — the server still validates.
 */
import { compile, type Schema } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";

const permissive = (): Schema =>
  ({ type: "object", properties: {}, additionalProperties: true }) as unknown as Schema;

export const toolSchemaOf = (input: unknown): Schema => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return permissive();
  const schema: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  delete schema.$schema;
  schema.type = "object";
  const properties = schema.properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    schema.properties = {};
  }
  try {
    // The same options the harness compiles tool schemas with.
    compile(schema as unknown as Schema, { formats, unresolvedRefs: "reject" });
    return schema as unknown as Schema;
  } catch {
    return permissive();
  }
};
