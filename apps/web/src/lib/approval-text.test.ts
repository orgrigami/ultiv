import { describe, expect, it } from "vite-plus/test";
import {
  alwaysAllowText,
  canAlwaysAllow,
  describeAllowEntry,
  describeTool,
  hintOf,
} from "./approval-text.ts";

describe("describeTool", () => {
  it("words known tools plainly", () => {
    expect(describeTool("bash")).toMatchObject({
      action: "run a script in its workspace",
      risky: true,
    });
    expect(describeTool("email_send").action).toBe("send an email");
    expect(describeTool("schedule_set")).toMatchObject({
      action: "set up a schedule",
      risky: false,
    });
  });

  it("words the credential broker's cards", () => {
    expect(describeTool("http_request")).toMatchObject({ risky: true });
    expect(describeTool("http_request (first use of a credential)").action).toBe(
      "use a saved credential on a site for the first time",
    );
    expect(canAlwaysAllow("http_request")).toBe(true);
    expect(canAlwaysAllow("http_request (first use of a credential)")).toBe(false);
    for (const name of [
      "connector_add",
      "connector_remove",
      "secret_request",
      "mcp (first use of fake)",
    ])
      expect(canAlwaysAllow(name)).toBe(false);
    expect(canAlwaysAllow("connector_list")).toBe(true);
    expect(hintOf({ method: "POST", url: "https://api.x.com/v1", credential: "Stripe" })).toBe(
      "https://api.x.com/v1",
    );
  });

  it("falls back to the humanized name", () => {
    expect(describeTool("weatherLookup")).toMatchObject({
      action: "use weather lookup",
      risky: false,
    });
    expect(describeTool("tweet_post").risky).toBe(true);
  });
});

describe("hintOf", () => {
  it("quotes scripts and joins recipient lists", () => {
    expect(hintOf({ script: "ls -la\n  pwd" })).toBe("ls -la pwd");
    expect(hintOf({ to: ["a@x.com", "b@x.com"], subject: "Hi" })).toBe("a@x.com, b@x.com");
  });

  it("truncates long values and ignores non-objects", () => {
    expect(hintOf({ text: "x".repeat(80) })).toBe(`${"x".repeat(57)}…`);
    expect(hintOf("nope")).toBeNull();
  });
});

describe("always allow for bash beyond the VM", () => {
  it("offers the exact-command rule on host and node cards, plain allow on vm cards", () => {
    expect(canAlwaysAllow("bash")).toBe(true);
    expect(alwaysAllowText("bash", { script: "ls", target: "host" }).title).toBe(
      "Always allow this exact command on this computer",
    );
    expect(alwaysAllowText("bash", { script: "ls", target: "node" }).title).toBe(
      "Always allow this exact command on that node",
    );
    expect(alwaysAllowText("bash", { script: "ls" }).title).toBe("Always allow");
  });

  it("lists an exact target rule by its script in the Access tab", () => {
    expect(describeAllowEntry("bash@host:=git status")).toEqual({
      label: "on this computer, exactly: git status",
      full: "on this computer, exactly:\ngit status",
    });
    expect(describeAllowEntry("bash@node:node-x:=make test")).toEqual({
      label: "on node node-x, exactly: make test",
      full: "on node node-x, exactly:\nmake test",
    });
    expect(describeAllowEntry("bash:git *").label).toBe("bash:git *");
    expect(describeAllowEntry("bash").label).toBe("bash");
  });
});
