/**
 * The audit contract's reach block (owner decisions, 1 Nov 2026): reach is
 * MESSAGING ONLY. The surface is exactly `message` — there is no
 * shared-folder or command surface, because shared folders and command
 * execution never cross homes.
 */
import { describe, expect, it } from "vite-plus/test";
import { AuditEventSchema } from "./audit.ts";

describe("the reach surface is messaging only", () => {
  it("the surface is exactly the `message` literal — no union, no other surface", () => {
    const reach = AuditEventSchema.properties.reach as {
      properties: { surface: { kind?: string; const?: string; anyOf?: unknown[] } };
    };
    const surface = reach.properties.surface;
    expect(surface.kind).toBe("literal");
    expect(surface.const).toBe("message");
    expect(surface.anyOf).toBeUndefined();
  });
});
