/** autoApprove entry matching: bare names approve every call, `tool:glob` approves matching sub-actions. */
import { describe, expect, it } from "vite-plus/test";
import {
  autoApproves,
  actionTextsOf,
  globToRegExp,
  parseAutoApproveEntry,
} from "./auto-approve.ts";

const call = (name: string, input: unknown) => ({ callId: "c1", name, input });

describe("parseAutoApproveEntry", () => {
  it("reads a bare name as whole-tool", () => {
    expect(parseAutoApproveEntry("bash")).toEqual({ tool: "bash" });
  });

  it("splits on the first colon only", () => {
    expect(parseAutoApproveEntry("sql:SELECT *; *")).toEqual({
      tool: "sql",
      pattern: "SELECT *; *",
    });
  });
});

describe("globToRegExp", () => {
  it("anchors and translates wildcards", () => {
    expect(globToRegExp("git *").test("git status")).toBe(true);
    expect(globToRegExp("git *").test("xgit status")).toBe(false);
    expect(globToRegExp("git ?tatus").test("git status")).toBe(true);
    expect(globToRegExp("git ?tatus").test("git ttatus")).toBe(true); // ? = exactly one char
    expect(globToRegExp("git ?tatus").test("git statuss")).toBe(false);
  });

  it("treats regex metacharacters literally", () => {
    expect(globToRegExp("a.c").test("a.c")).toBe(true);
    expect(globToRegExp("a.c").test("axc")).toBe(false);
    expect(globToRegExp("(rm) [a-z]+").test("(rm) [a-z]+")).toBe(true);
    expect(globToRegExp("a+b").test("a+b")).toBe(true);
    expect(globToRegExp("a+b").test("aaab")).toBe(false);
  });
});

describe("actionTextsOf", () => {
  it("collects command fields at depth", () => {
    expect(actionTextsOf({ nested: { command: "git status" } })).toEqual(["git status"]);
    expect(actionTextsOf({ command: "ls", script: "echo hi" })).toEqual(["ls", "echo hi"]);
  });

  it("falls back to string values when no command field exists", () => {
    expect(actionTextsOf({ to: "bob", body: "hello" })).toEqual(["bob", "hello"]);
    expect(actionTextsOf({ nested: { body: "hello" } })).toEqual(["hello"]);
  });

  it("a non-string command field is no command; string values are still candidates", () => {
    expect(actionTextsOf({ command: 5, to: "bob" })).toEqual(["bob"]);
  });

  it("an input with no strings at all falls back to the serialised JSON", () => {
    expect(actionTextsOf({ count: 5 })).toEqual([JSON.stringify({ count: 5 })]);
  });
});

describe("autoApproves", () => {
  it("a bare name approves every call of the tool", () => {
    expect(autoApproves(["bash"], call("bash", { command: "rm -rf /" }))).toBe(true);
  });

  it("a bare name does not approve other tools", () => {
    expect(autoApproves(["bash"], call("bash_host", { command: "ls" }))).toBe(false);
  });

  it("a pattern approves matching commands only", () => {
    const entries = ["bash:git *"];
    expect(autoApproves(entries, call("bash", { command: "git status" }))).toBe(true);
    expect(autoApproves(entries, call("bash", { command: "rm -rf /" }))).toBe(false);
  });

  it("a pattern on another tool never matches", () => {
    expect(autoApproves(["sql:SELECT *"], call("bash", { command: "SELECT *" }))).toBe(false);
  });

  it("a pattern without command fields matches a string value of the input", () => {
    expect(
      autoApproves(["send_message:Hello*"], call("send_message", { body: "Hello there" })),
    ).toBe(true);
    expect(autoApproves(["send_message:Hello*"], call("send_message", { body: "bye" }))).toBe(
      false,
    );
  });

  it("a nested command field matches a tool:pattern", () => {
    expect(autoApproves(["bash:git *"], call("bash", { run: { command: "git push" } }))).toBe(true);
  });

  it("any matching entry wins", () => {
    const entries = ["bash:npm test*", "bash:git status"];
    expect(autoApproves(entries, call("bash", { command: "git status" }))).toBe(true);
    expect(autoApproves(entries, call("bash", { command: "npm test" }))).toBe(true);
    expect(autoApproves(entries, call("bash", { command: "git push" }))).toBe(false);
  });

  it("an empty pattern approves nothing", () => {
    expect(autoApproves(["bash:"], call("bash", { command: "ls" }))).toBe(false);
  });

  it("matching is case-sensitive", () => {
    expect(autoApproves(["bash:git *"], call("bash", { command: "GIT status" }))).toBe(false);
  });

  it("the empty list approves nothing", () => {
    expect(autoApproves([], call("bash", { command: "ls" }))).toBe(false);
  });
});
