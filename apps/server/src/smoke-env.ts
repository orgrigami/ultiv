// The smoke run's hermetic environment: a throwaway vault, artifact
// workspace, skill and auth stores, audit trail and push dir, and a model
// catalog that never touches the network (one keyless local provider from
// an overlay). Called before the stack boots; returns the dirs to remove.
// smokeSignIn then sets the passcode and signs the run in.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const prepareSmokeEnv = (): { scratchVault: string; scratchArtifacts: string } => {
  process.env.VAULT_KEY = "smoke-vault-key";
  const scratchVault = mkdtempSync(join(tmpdir(), "spriessen-smoke-vault-"));
  const scratchArtifacts = mkdtempSync(join(tmpdir(), "spriessen-smoke-artifacts-"));
  process.env.ARTIFACTS_DIR = scratchArtifacts;
  // Skill stores stay hermetic too.
  process.env.SKILLS_DIR = join(scratchArtifacts, "skills");
  process.env.BOT_FILES_DIR = join(scratchArtifacts, "bot-files");
  // Keep the audit trail hermetic: never append to a real var/audit.jsonl.
  process.env.AUDIT_LOG = join(scratchArtifacts, "audit.jsonl");
  // Connector configs land in the scratch dir too.
  process.env.MCP_DIR = join(scratchArtifacts, "mcp");
  // Sign-in state and per-owner stores stay hermetic: the boot migration must
  // find nothing of the machine's real data.
  process.env.AUTH_DIR = join(scratchArtifacts, "auth");
  process.env.VAULT_DIR = scratchVault;
  process.env.PUSH_DIR = join(scratchArtifacts, "push");
  // The model catalog never touches the network here: no models.dev fetch, a
  // scratch cache, and one keyless local provider from an overlay. The default
  // model stays unregistered, so onboarding turns fail fast as they always have.
  process.env.MODELS_DEV_URL = "off";
  process.env.MODELS_DEV_CACHE = join(scratchArtifacts, "models-dev.json");
  process.env.MODELS_OVERLAY = join(scratchArtifacts, "models.local.json");
  process.env.KENARI_MODELS_CACHE = join(scratchArtifacts, "kenari-models.json");
  process.env.SPRIESSEN_PROVIDERS = "smoke-local";
  process.env.SPRIESSEN_MODEL = "kenari/deepseek-v4-1-flash";
  writeFileSync(
    process.env.MODELS_OVERLAY,
    JSON.stringify({
      "smoke-local": {
        name: "Smoke Local",
        npm: "@ai-sdk/openai-compatible",
        api: "http://127.0.0.1:9/v1",
        env: [],
        models: {
          tiny: {
            id: "tiny",
            name: "Tiny",
            tool_call: true,
            limit: { context: 8192, output: 1024 },
          },
        },
      },
    }),
  );
  return { scratchVault, scratchArtifacts };
};

/**
 * The stack listens on loopback, so the one-time bootstrap can set the
 * passcode; every later call rides the returned session cookie.
 */
export const smokeSignIn = async (base: string): Promise<string> => {
  const signInSmoke = async (): Promise<Response> =>
    fetch(`${base}/api/auth/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: "smoke-passcode-9" }),
    });

  const set = await fetch(`${base}/api/auth/passcode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passcode: "smoke-passcode-9" }),
  });
  // A passcode survives only from an earlier run against this same scratch
  // dir (the scratch is fresh each run); sign in instead, then.
  const signedIn = set.status === 200 ? set : set.status === 409 ? await signInSmoke() : null;
  if (signedIn === null || signedIn.status !== 200) {
    throw new Error(`smoke sign-in failed: set=${set.status}`);
  }
  const smokeCookie = signedIn.headers.get("set-cookie")?.split(";")[0];
  if (smokeCookie === undefined) throw new Error("no session cookie from sign-in");
  return smokeCookie;
};
