/**
 * `spriessen doctor`: the path a first run takes, checked in order — the
 * server answers, it has a passcode, you are signed in, a model provider
 * key is set, there is a bot — with the command that fixes each problem.
 * Optional extras (Jev, web search, push, the microVM) are listed as what
 * they would turn on, never as failures. Key NAMES only, never values
 * (the server's check reports set/unset). Exits 1 when a step fails.
 */
import { existsSync } from "node:fs";
import { nodeVersionProblem } from "@spriessen/core";
import { stringFlag, type Parsed } from "../args.ts";
import type { Api, ServerCheck } from "../client/http.ts";
import { serverOf } from "../config.ts";
import { paintFor } from "../render/out.ts";
import { apiFor, liveBots } from "./context.ts";

type Verdict = "ok" | "fail" | "info";

export interface Step {
  readonly verdict: Verdict;
  readonly text: string;
  /** The command or action that fixes it. */
  readonly fix?: string;
}

const ok = (text: string): Step => ({ verdict: "ok", text });
const fail = (text: string, fix: string): Step => ({ verdict: "fail", text, fix });
const info = (text: string, fix?: string): Step => ({
  verdict: "info",
  text,
  ...(fix !== undefined ? { fix } : {}),
});

const isLocal = (server: string): boolean =>
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(server);

/** Node 26 is the one supported line, here and on the server. */
export const nodeStep = (where: string, version: string): Step => {
  const problem = nodeVersionProblem(version);
  if (problem === undefined) return ok(`${where} runs on Node ${version}`);
  const fix = "run it through vp (it reads .node-version), or reinstall: sh scripts/install-cli.sh";
  return problem.fatal ? fail(`${where}: ${problem.text}`, fix) : info(`${where}: ${problem.text}`);
};

/** What the server's own check says: Node, models, then the extras. */
export const checkSteps = (check: ServerCheck): Step[] => {
  const steps: Step[] = check.node !== undefined ? [nodeStep("The server", check.node)] : [];
  if (check.models.count > 0) {
    steps.push(ok(`${check.models.count} models from ${check.models.providers.join(", ")}`));
  } else {
    steps.push(
      fail(
        "No model provider key is set, so no bot can answer",
        "add one to ~/.spriessen/.env (e.g. KENARI_API_KEY=… or ANTHROPIC_API_KEY=…), then: spriessen daemon restart",
      ),
    );
  }
  const missing = check.keys.filter((key) => key.group === "features" && !key.set);
  steps.push(
    ...missing.map((key) => info(`${key.enables}: off`, `set ${key.names.join(" + ")} in .env`)),
  );
  steps.push(
    check.microvm.available
      ? ok("Bots' bash runs in a microVM here")
      : info(`No microVM here, so bots have no bash: ${check.microvm.detail}`),
  );
  return steps;
};

/** Everything that needs the server, in order; stops at the first step later ones depend on. */
const serverSteps = async (api: Api): Promise<Step[]> => {
  let status;
  try {
    status = await api.authStatus();
  } catch {
    return [
      fail(
        `The server at ${api.server} doesn't answer`,
        isLocal(api.server)
          ? "start it: spriessen daemon install (kept running) or spriessen serve"
          : "check the address, or pick another with --server <url>",
      ),
    ];
  }
  const steps = [ok(`The server at ${api.server} answers`)];
  if (!status.passcodeSet) {
    return [
      ...steps,
      fail("It has no passcode yet", "run on the server's machine: spriessen login"),
    ];
  }
  if (api.cookie === undefined || !status.session) {
    return [...steps, fail("You're not signed in", "spriessen login")];
  }
  steps.push(ok("You're signed in"));
  const [check, models] = await Promise.all([api.serverCheck(), api.models()]);
  steps.push(...checkSteps(check));
  if (models.models.length > 0) {
    steps.push(
      models.workspaceDefault !== null
        ? ok(`New chats start on ${models.workspaceDefault.ref}`)
        : fail(
            "No workspace default model, so chats without their own model can't answer",
            `spriessen models default ${check.models.default} (or pick from: spriessen models)`,
          ),
    );
  }
  const [bots, main, waiting] = await Promise.all([liveBots(api), api.main(), api.approvals()]);
  const mainBot = bots.find((bot) => bot.id === main.profileId);
  steps.push(
    bots.length === 0
      ? fail("There are no bots yet", "spriessen bots new <name>")
      : ok(`${bots.length} bot(s); the main one is ${mainBot?.name ?? bots[0]?.name}`),
  );
  if (waiting.length > 0)
    steps.push(info(`${waiting.length} card(s) wait for you`, "spriessen needs"));
  return steps;
};

const localSteps = async (server: string): Promise<Step[]> => {
  if (!isLocal(server)) return [];
  const { unitPath } = await import("./daemon.ts");
  return existsSync(unitPath("server"))
    ? [ok("The server daemon is installed (spriessen daemon status)")]
    : [info("No daemon: the server stops when you close its terminal", "spriessen daemon install")];
};

export const doctor = async (parsed: Parsed): Promise<number> => {
  const api = apiFor(parsed);
  const steps = [
    nodeStep("This command", process.versions.node),
    ...(await serverSteps(api)),
    ...(await localSteps(serverOf(stringFlag(parsed, "server")))),
  ];
  if (parsed.flags.get("json") === true) {
    console.log(JSON.stringify(steps, null, 2));
  } else {
    const paint = paintFor();
    for (const step of steps) {
      const mark =
        step.verdict === "ok"
          ? paint.green("✓")
          : step.verdict === "fail"
            ? paint.red("✗")
            : paint.dim("·");
      const text = step.verdict === "info" ? paint.dim(step.text) : step.text;
      console.log(`${mark} ${text}`);
      if (step.fix !== undefined) console.log(`    ${paint.dim("→")} ${step.fix}`);
    }
    const failed = steps.filter((step) => step.verdict === "fail").length;
    console.log(
      failed === 0
        ? `\nAll set. Open the chat: spriessen`
        : `\n${failed} thing(s) to fix, in the order above.`,
    );
  }
  return steps.some((step) => step.verdict === "fail") ? 1 : 0;
};
