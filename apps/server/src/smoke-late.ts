// The later slices of the smoke run, on the running stack: vault sealing,
// the approvals inbox and owner memory, connectors (smoke-mcp.ts), skills,
// the tool catalog and the workspace default model.
import { smokeMcp } from "./smoke-mcp.ts";

type Call = (
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<{ status: number; json: any }>;

export const smokeLate = async (
  call: Call,
  headers: Record<string, string>,
  expect: (name: string, ok: boolean) => void,
  botId: string,
): Promise<void> => {
  // Vault: secrets seal; responses carry masks only.
  const login = await call(
    "POST",
    "/api/vault",
    {
      kind: "login",
      name: "Gmail",
      login: { url: "https://mail.google.com", username: "smoker@gmail.com", password: "hunter2" },
    },
    headers,
  );
  expect(
    "vault seals and masks",
    login.status === 200 &&
      login.json.masked.includes("smoker@gmail.com") &&
      !JSON.stringify(login.json).includes("hunter2"),
  );
  const vaultList = await call("GET", "/api/vault", undefined, headers);
  expect("vault list metadata only", vaultList.status === 200 && vaultList.json.length === 1);

  // Approvals inbox + memory.
  const approvals = await call("GET", "/api/approvals", undefined, headers);
  expect("approval inbox empty", approvals.status === 200 && approvals.json.length === 0);
  const memoryWrite = await call(
    "POST",
    "/api/memory",
    { text: "smoker prefers brevity" },
    headers,
  );
  expect("owner memory write", memoryWrite.status === 200);
  const memoryRead = await call("GET", "/api/memory", undefined, headers);
  expect("owner memory read", memoryRead.json.length === 1);

  // Connectors: added, used and removed on the running stack.
  await smokeMcp(call, headers, expect);

  // Skills: the built-in library lists for every bot; the owner can write,
  // toggle, reread and remove one; sections pick it up on the next render.
  const skillsOverview = await call("GET", "/api/skills", undefined, headers);
  expect(
    "skills overview lists built-ins per bot",
    skillsOverview.status === 200 &&
      skillsOverview.json.builtins.length === 1 &&
      skillsOverview.json.profiles.length >= 1 &&
      skillsOverview.json.profiles[0].skills.length === 1,
  );
  const smokeSkillBody =
    "---\nname: smoke-skill\ndescription: A skill the smoke run wrote\n---\n\n# steps";
  const skillPut = await call(
    "PUT",
    `/api/skills/${botId}/smoke-skill`,
    { body: smokeSkillBody },
    headers,
  );
  expect("owner skill write", skillPut.status === 200 && skillPut.json.version === 1);
  const skillRead = await call("GET", `/api/skills/${botId}/smoke-skill`, undefined, headers);
  expect("owner skill reread", skillRead.status === 200 && skillRead.json.body.includes("# steps"));
  const skillToggle = await call(
    "PUT",
    `/api/skills/${botId}/smoke-skill`,
    { enabled: false },
    headers,
  );
  expect("owner skill disable", skillToggle.status === 200 && skillToggle.json.enabled === false);
  const skillDelete = await call("DELETE", `/api/skills/${botId}/smoke-skill`, undefined, headers);
  expect("owner skill delete", skillDelete.status === 200 && skillDelete.json.ok === true);

  // The tool catalog (allowlist editor's payload): names + one-line descriptions.
  const toolCatalog = await call("GET", "/api/tools", undefined, headers);
  expect(
    "tool catalog lists bot_create with a description",
    toolCatalog.status === 200 &&
      Array.isArray(toolCatalog.json) &&
      toolCatalog.json.some(
        (tool: { name: string; description: string }) =>
          tool.name === "bot_create" && tool.description.length > 0,
      ),
  );

  // Workspace default model: the env default first, then a stored one over it,
  // then cleared. The catalog here is the offline overlay.
  const settingsModel = async (): Promise<any> => (await call("GET", "/api/settings/model")).json;
  expect(
    "workspace default reads the environment",
    (await settingsModel()).defaultModel?.source === "env" &&
      (await settingsModel()).defaultModel?.ref === "kenari/deepseek-v4-1-flash",
  );
  const putDefault = await call("PUT", "/api/settings/model", {
    ref: "smoke-local/tiny",
    effort: "",
  });
  expect(
    "workspace default PUT stores over the env",
    putDefault.status === 200 &&
      putDefault.json.defaultModel?.source === "db" &&
      putDefault.json.defaultModel?.ref === "smoke-local/tiny",
  );
  const putUnknown = await call("PUT", "/api/settings/model", { ref: "nowhere/nothing" });
  expect(
    "workspace default PUT refuses an unknown ref",
    putUnknown.status === 409 && (await settingsModel()).defaultModel?.ref === "smoke-local/tiny",
  );
  const clearDefault = await call("PUT", "/api/settings/model", null);
  expect(
    "workspace default PUT null clears",
    clearDefault.status === 200 && (await settingsModel()).defaultModel?.source === "env",
  );
};
