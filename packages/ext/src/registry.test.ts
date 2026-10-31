import { describe, expect, it } from "vite-plus/test";
import { Effect, Exit } from "effect";
import { Type } from "typebox";
import { Duplicate } from "@spreissen/core";
import {
  connectorCapability,
  defineConnector,
  definePlugin,
  defineTool,
  makeRegistry,
  toolCapability,
  type Plugin,
} from "./index.ts";

const echo = defineTool({
  name: "echo",
  description: "Echo the input.",
  parameters: Type.Object({ text: Type.String() }),
  execute: async () => ({ output: [{ type: "text", text: "echo" }] }),
});

const notes = defineConnector({
  id: "notes",
  name: "Notes",
  description: "Test connector.",
  auth: { kind: "none" },
  actions: [],
});

const pluginA = definePlugin({
  id: "test.a",
  version: "1.0.0",
  description: "Tools.",
  capabilities: [toolCapability(echo)],
});

const pluginB = definePlugin({
  id: "test.b",
  version: "1.0.0",
  description: "Connectors.",
  capabilities: [connectorCapability(notes)],
});

const failureOf = (effect: Effect.Effect<unknown, Duplicate>): Duplicate =>
  Effect.runSync(
    Effect.match(effect, {
      onFailure: (failure) => failure,
      onSuccess: () => {
        throw new Error("expected a Duplicate failure");
      },
    }),
  );

describe("Registry", () => {
  it("indexes capabilities across plugins", async () => {
    const registry = await Effect.runPromise(makeRegistry([pluginA, pluginB]));
    expect(registry.plugins().map((plugin) => plugin.id)).toEqual(["test.a", "test.b"]);
    expect(registry.tools().map((tool) => tool.name)).toEqual(["echo"]);
    expect(registry.connector("notes")?.actions).toEqual([]);
    expect(registry.connector("nope")).toBeUndefined();
  });

  it("rejects duplicate plugin ids, tool names, and connector ids", async () => {
    const registry = await Effect.runPromise(makeRegistry([pluginA, pluginB]));
    const sameId = definePlugin({ ...pluginB, id: "test.a" });
    expect(failureOf(registry.register(sameId))).toMatchObject({ kind: "plugin", id: "test.a" });
    const sameTool = definePlugin({
      id: "test.c",
      version: "1.0.0",
      description: "",
      capabilities: [toolCapability(echo)],
    });
    expect(failureOf(registry.register(sameTool))).toMatchObject({ kind: "tool", id: "echo" });
    const sameConnector = definePlugin({
      id: "test.d",
      version: "1.0.0",
      description: "",
      capabilities: [connectorCapability(notes)],
    });
    expect(failureOf(registry.register(sameConnector))).toMatchObject({
      kind: "connector",
      id: "notes",
    });
  });

  it("fails the build on duplicate identities in the seed list", async () => {
    const plugins: Plugin[] = [pluginA, pluginA];
    const exit = Effect.runSync(Effect.exit(makeRegistry(plugins)));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
