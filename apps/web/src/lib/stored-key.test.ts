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

describe("adoptLegacyKey", () => {
  it("copies the old value once and drops the old key", () => {
    const store = memory({ "ultiv.theme": "light" });
    adoptLegacyKey("spreissen.theme", "ultiv.theme", store);
    expect(Object.fromEntries(store.data)).toEqual({ "spreissen.theme": "light" });
  });

  it("never overwrites a value already under the new key", () => {
    const store = memory({ "spreissen.theme": "dark", "ultiv.theme": "light" });
    adoptLegacyKey("spreissen.theme", "ultiv.theme", store);
    expect(store.getItem("spreissen.theme")).toBe("dark");
  });

  it("does nothing when there is nothing to adopt", () => {
    const store = memory({});
    adoptLegacyKey("spreissen.theme", "ultiv.theme", store);
    expect(store.data.size).toBe(0);
  });
});
