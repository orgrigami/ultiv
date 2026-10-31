import { describe, expect, it } from "vite-plus/test";
import { Effect, Exit } from "effect";
import { Type } from "typebox";
import { defineAction, defineConnector, invoke, resolveAuth } from "./connector.ts";
import { httpConnector } from "./plugins/http.ts";

// Effect 4's default env provider snapshots process.env at first use, so test
// keys are set at module load — never mid-test.
process.env.SPREISSEN_TEST_TOKEN = "abcd";

const secretFetcher = defineConnector({
  id: "secret",
  name: "Secret",
  description: "Env-auth test connector.",
  auth: { kind: "env", env: "SPREISSEN_TEST_TOKEN", displayName: "Test" },
  actions: [
    defineAction({
      name: "peek",
      description: "Returns the key length.",
      input: Type.Object({}),
      output: Type.Object({ length: Type.Number() }),
      perform: (_input, context) => Effect.succeed({ length: (context.apiKey ?? "").length }),
    }),
  ],
});

const absentFetcher = defineConnector({
  id: "absent",
  name: "Absent",
  description: "Connector whose key is never set.",
  auth: { kind: "env", env: "SPREISSEN_TEST_ABSENT", displayName: "Absent" },
  actions: [],
});

describe("connector runtime", () => {
  it("fails unknown actions and schema-invalid input", async () => {
    const missing = await Effect.runPromiseExit(invoke(httpConnector, "nope", {}));
    expect(Exit.isSuccess(missing)).toBe(false);
    const invalid = await Effect.runPromiseExit(invoke(httpConnector, "request", { url: 1 }));
    expect(Exit.isSuccess(invalid)).toBe(false);
  });

  it("counts a never-set env key as absent", async () => {
    const exit = await Effect.runPromiseExit(resolveAuth(absentFetcher));
    expect(Exit.isSuccess(exit)).toBe(false);
  });

  it("resolves env auth and performs with the key", async () => {
    const result = await Effect.runPromise(invoke(secretFetcher, "peek", {}));
    expect(result).toEqual({ length: 4 });
  });

  it("performs HTTP requests through the reference connector", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("created", { status: 201 })) as typeof fetch;
    try {
      const result = await Effect.runPromise(
        invoke(httpConnector, "request", {
          method: "POST",
          url: "https://unit.test/x",
          body: "hi",
        }),
      );
      expect(result).toEqual({ status: 201, body: "created" });
    } finally {
      globalThis.fetch = original;
    }
  });
});
