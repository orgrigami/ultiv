import { describe, expect, it } from "vite-plus/test";
import { adoptLegacyKey } from "./stored-key.ts";

const memory = (seed: Record<string, string>) => {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
};

const OLD = ["spreissen.theme", "ultiv.theme"];

describe("adoptLegacyKey", () => {
  it("copies the pre-rename value once and drops the old key", () => {
    const store = memory({ "ultiv.theme": "light" });
    adoptLegacyKey("spriessen.theme", OLD, store);
    expect(Object.fromEntries(store.data)).toEqual({ "spriessen.theme": "light" });
  });

  it("adopts the misspelt key, preferring it over the older one, and drops both", () => {
    const store = memory({ "spreissen.theme": "dark", "ultiv.theme": "light" });
    adoptLegacyKey("spriessen.theme", OLD, store);
    expect(Object.fromEntries(store.data)).toEqual({ "spriessen.theme": "dark" });
  });

  it("never overwrites a value already under the new key, and clears stale old keys", () => {
    const store = memory({ "spriessen.theme": "dark", "spreissen.theme": "light" });
    adoptLegacyKey("spriessen.theme", OLD, store);
    expect(Object.fromEntries(store.data)).toEqual({ "spriessen.theme": "dark" });
  });

  it("still takes a single legacy key", () => {
    const store = memory({ "ultiv.theme": "light" });
    adoptLegacyKey("spriessen.theme", "ultiv.theme", store);
    expect(store.getItem("spriessen.theme")).toBe("light");
  });

  it("does nothing when there is nothing to adopt", () => {
    const store = memory({});
    adoptLegacyKey("spriessen.theme", OLD, store);
    expect(store.data.size).toBe(0);
  });
});
