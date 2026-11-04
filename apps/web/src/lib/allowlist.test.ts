import { describe, expect, it } from "vite-plus/test";
import { allowlistMatches, notOnList } from "./allowlist.ts";

const catalog = [
  { name: "bash", description: "Run a command in the bot's VM" },
  { name: "web_search", description: "Search the web for pages" },
  { name: "web_fetch", description: "Fetch one web page's text" },
  { name: "message", description: "Send a message to another bot" },
];

describe("allowlistMatches", () => {
  it("passes everything through on an empty query", () => {
    expect(allowlistMatches(catalog, "").map((tool) => tool.name)).toEqual([
      "bash",
      "web_search",
      "web_fetch",
      "message",
    ]);
    expect(allowlistMatches(catalog, "   ")).toHaveLength(4);
  });

  it("matches the name or the description, case-insensitively", () => {
    expect(allowlistMatches(catalog, "WEB").map((tool) => tool.name)).toEqual([
      "web_search",
      "web_fetch",
    ]);
    expect(allowlistMatches(catalog, "command").map((tool) => tool.name)).toEqual(["bash"]);
    expect(allowlistMatches(catalog, "zzz")).toEqual([]);
  });
});

describe("notOnList", () => {
  it("counts the installed tools a curated list omits", () => {
    expect(notOnList(catalog, ["bash"])).toBe(3);
    expect(notOnList(catalog, ["bash", "message", "ghost"])).toBe(2);
    expect(notOnList(catalog, [])).toBe(4);
  });
});
