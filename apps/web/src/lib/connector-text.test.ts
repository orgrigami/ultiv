import { describe, expect, it } from "vite-plus/test";
import type { McpServerInfo } from "@spreissen/contracts";
import {
  emptyConnectorForm,
  formOfInfo,
  inputOfForm,
  joinCommandLine,
  splitCommandLine,
  statusLine,
  targetOf,
  toolKind,
} from "./connector-text.ts";

const info = (overrides: Partial<McpServerInfo> = {}): McpServerInfo => ({
  name: "GitHub",
  transport: "auto",
  url: "https://api.example.com/mcp",
  command: null,
  auth: { kind: "headers", headers: [{ name: "Authorization", item: "v1", prefix: "Bearer " }] },
  profiles: null,
  enabled: true,
  autoAllowReadOnly: false,
  disabledTools: [],
  id: "github",
  createdAt: 0,
  state: "connected",
  reason: null,
  activeTransport: "http",
  serverName: null,
  tools: [],
  hasResources: false,
  firstUseApproved: false,
  signedIn: false,
  ...overrides,
});

describe("connector text", () => {
  it("splits and rejoins command lines", () => {
    expect(splitCommandLine(`npx -y "@scope/server x" --dir '/tmp/a b' a\\ b ""`)).toEqual([
      "npx",
      "-y",
      "@scope/server x",
      "--dir",
      "/tmp/a b",
      "a b",
      "",
    ]);
    const words = ["node", "server.js", "--name", "two words"];
    expect(splitCommandLine(joinCommandLine(words))).toEqual(words);
  });

  it("builds requests and refuses incomplete forms in plain words", () => {
    expect(() => inputOfForm(emptyConnectorForm())).toThrow(/name/);
    const web = { ...emptyConnectorForm(), name: "Docs", url: "https://x.dev/mcp" };
    expect(inputOfForm(web)).toMatchObject({ transport: "auto", auth: { kind: "none" } });
    expect(() => inputOfForm({ ...web, url: "x.dev" })).toThrow(/web address/);
    expect(() => inputOfForm({ ...web, auth: "headers" })).toThrow(/header/);
    const command = {
      ...emptyConnectorForm(),
      name: "Files",
      kind: "command" as const,
      commandLine: "npx -y pkg",
      env: [
        { name: "TOKEN", item: "v2", prefix: "" },
        { name: "", item: "", prefix: "" },
      ],
    };
    expect(inputOfForm(command)).toMatchObject({
      transport: "stdio",
      url: null,
      command: { command: "npx", args: ["-y", "pkg"], env: [{ name: "TOKEN", item: "v2" }] },
    });
  });

  it("round-trips a saved connector through the form", () => {
    const saved = info();
    const back = inputOfForm(formOfInfo(saved));
    expect(back.auth).toEqual(saved.auth);
    expect(back.url).toBe(saved.url);
    const oauth = info({ auth: { kind: "oauth", scope: "read", clientId: "abc" } });
    expect(inputOfForm(formOfInfo(oauth)).auth).toEqual(oauth.auth);
    const confidential = info({
      auth: {
        kind: "oauth",
        clientId: "abc.apps.googleusercontent.com",
        clientSecretItem: "v9",
        authParams: [{ name: "access_type", value: "offline" }],
      },
    });
    expect(inputOfForm(formOfInfo(confidential)).auth).toEqual(confidential.auth);
  });

  it("maps the oauth secret and drops empty auth params", () => {
    const form = { ...emptyConnectorForm(), name: "Google" };
    expect(
      inputOfForm({
        ...form,
        kind: "web",
        url: "https://x.example/mcp",
        auth: "oauth",
        oauthSecret: [{ name: "client_secret", item: "v1", prefix: "" }],
        oauthAuthParams: [
          { name: "access_type", value: "offline" },
          { name: "", value: "" },
        ],
      }).auth,
    ).toEqual({
      kind: "oauth",
      clientSecretItem: "v1",
      authParams: [{ name: "access_type", value: "offline" }],
    });
  });

  it("describes state, target and tool kinds", () => {
    expect(statusLine(info())).toBe("Connected");
    expect(statusLine(info({ state: "failed", reason: "nothing is listening" }))).toBe(
      "Not working — nothing is listening",
    );
    expect(targetOf(info())).toBe("api.example.com/mcp");
    expect(
      targetOf(
        info({
          url: null,
          transport: "stdio",
          command: { command: "npx", args: ["-y", "a b"], env: [] },
        }),
      ),
    ).toBe('npx -y "a b"');
    expect(toolKind({ readOnly: true, destructive: false })).toBe("read-only");
    expect(toolKind({ readOnly: false, destructive: true })).toMatch(/delete/);
  });
});
