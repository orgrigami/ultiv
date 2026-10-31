import { describe, expect, it } from "vite-plus/test";
import { CHARACTER_HUES, characterOf, hashSeed, seedOf } from "./avatar.ts";

describe("bot characters", () => {
  it("are the same for the same seed, every time", () => {
    expect(characterOf("bot-123")).toEqual(characterOf("bot-123"));
    expect(hashSeed("atlas")).toBe(hashSeed("atlas"));
    // Pinned, so a refactor that reshuffles every face is caught.
    expect(hashSeed("atlas")).toBe(540_299_299);
  });

  it("ignore case and stray spaces in a name seed", () => {
    expect(characterOf(" Atlas ")).toEqual(characterOf("atlas"));
  });

  it("survive an empty seed", () => {
    expect(characterOf("")).toEqual(characterOf("?"));
  });

  it("spread across shapes and colors", () => {
    const crew = Array.from({ length: 60 }, (_, index) => characterOf(`bot-${index}`));
    expect(new Set(crew.map((c) => c.hue)).size).toBe(CHARACTER_HUES);
    expect(new Set(crew.map((c) => c.body)).size).toBe(4);
    expect(new Set(crew.map((c) => c.eyes)).size).toBe(4);
    for (const c of crew) {
      expect(c.hue).toBeGreaterThanOrEqual(1);
      expect(c.hue).toBeLessThanOrEqual(CHARACTER_HUES);
    }
  });

  it("differ for ids one character apart", () => {
    const a = characterOf("bot-1");
    const b = characterOf("bot-2");
    expect(a).not.toEqual(b);
  });

  it("seed from the id, falling back to the name", () => {
    expect(seedOf("id-1", "Atlas")).toBe("id-1");
    expect(seedOf(undefined, "Atlas")).toBe("Atlas");
    expect(seedOf("", "Atlas")).toBe("Atlas");
  });
});
