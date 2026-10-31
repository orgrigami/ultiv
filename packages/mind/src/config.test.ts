import { ConfigProvider, Effect, Option } from "effect";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { resetLegacyEnvWarnings } from "@spreissen/core";
import { defaultModel, modelProviders } from "./config.ts";

const parse = <A>(
  config: { parse: (p: ConfigProvider.ConfigProvider) => Effect.Effect<A, unknown> },
  env: Record<string, string>,
) => Effect.runPromise(config.parse(ConfigProvider.fromUnknown(env)));

describe("product env keys", () => {
  beforeEach(() => resetLegacyEnvWarnings());

  it("read SPREISSEN_MODEL", async () => {
    expect(await parse(defaultModel, { SPREISSEN_MODEL: "a/b" })).toEqual(Option.some("a/b"));
  });

  it("still read the deprecated ULTIV_ names", async () => {
    expect(await parse(defaultModel, { ULTIV_MODEL: "old/model" })).toEqual(
      Option.some("old/model"),
    );
    expect(await parse(modelProviders, { ULTIV_PROVIDERS: "kenari" })).toEqual(
      Option.some("kenari"),
    );
  });

  it("prefer the new name, and are none when neither is set", async () => {
    expect(await parse(defaultModel, { SPREISSEN_MODEL: "new/m", ULTIV_MODEL: "old/m" })).toEqual(
      Option.some("new/m"),
    );
    expect(await parse(defaultModel, {})).toEqual(Option.none());
  });
});
