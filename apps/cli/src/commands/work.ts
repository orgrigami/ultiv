/**
 * What the bots are working on, and their tests, from the command line:
 * `tasks` (background work), `projects` (goals over days), `models` (what
 * `--model` accepts) and `tests` / `tests run`. `tests run` waits for the
 * run and exits 1 when any test fails, so a script or CI can gate a model
 * or prompt change on it. Plain lines on stdout, `--json` for machines.
 */
import type { EvalCase, EvalRun, ProfileInfo } from "@spriessen/contracts";
import { boolFlag, numberFlag, stringFlag, type Parsed } from "../args.ts";
import type { Api } from "../client/http.ts";
import { apiFor, pickBot } from "./context.ts";

const print = (parsed: Parsed, value: unknown, lines: () => string[]): void => {
  if (boolFlag(parsed, "json")) console.log(JSON.stringify(value, null, 2));
  else for (const line of lines()) console.log(line);
};

const day = (at: number): string => new Date(at).toISOString().slice(0, 16).replace("T", " ");

/** The bot `--bot` names, or undefined for every bot. */
const botOf = async (api: Api, parsed: Parsed): Promise<ProfileInfo | undefined> => {
  const name = stringFlag(parsed, "bot");
  return name === undefined ? undefined : pickBot(api, name);
};

const namesOf = async (api: Api): Promise<Map<string, string>> =>
  new Map((await api.profiles()).map((bot) => [bot.id, bot.name]));

const MARK: Record<string, string> = { running: "…", done: "✓", failed: "✗", cancelled: "-" };

export const tasks = async (parsed: Parsed): Promise<void> => {
  const api = apiFor(parsed);
  const [rows, names, bot] = await Promise.all([api.tasks(), namesOf(api), botOf(api, parsed)]);
  const shown = rows
    .filter((task) => bot === undefined || task.bot?.profileId === bot.id)
    .sort(
      (a, b) =>
        Number(b.status === "running") - Number(a.status === "running") ||
        b.createdAt - a.createdAt,
    )
    .slice(0, boolFlag(parsed, "all") ? undefined : 20);
  print(parsed, shown, () =>
    shown.length === 0
      ? ["No background tasks."]
      : shown.map((task) => {
          const who = names.get(task.bot?.profileId ?? "") ?? "";
          const model = task.model !== undefined ? ` · ${task.model}` : "";
          const title = task.title ?? task.prompt.replace(/\s+/g, " ").slice(0, 40);
          return `${MARK[task.status] ?? "?"} ${title.padEnd(40)} ${who}${model} · ${day(task.createdAt)}`;
        }),
  );
};

export const projects = async (parsed: Parsed): Promise<void> => {
  const api = apiFor(parsed);
  const [bot, names] = await Promise.all([botOf(api, parsed), namesOf(api)]);
  const rows = await api.projects(bot?.id);
  print(parsed, rows, () =>
    rows.length === 0
      ? ["No projects yet. Ask a bot to take on something that takes days."]
      : rows.flatMap((project) => {
          const done = project.milestones.filter((step) => step.done).length;
          const next = project.milestones.find((step) => !step.done);
          return [
            `${project.title} [${project.status}] · ${names.get(project.profileId) ?? ""} · ${done}/${project.milestones.length} milestones`,
            ...(next !== undefined ? [`  next: ${next.text}`] : []),
          ];
        }),
  );
};

export const models = async (parsed: Parsed): Promise<void> => {
  const payload = await apiFor(parsed).models();
  const fallback = payload.workspaceDefault?.ref;
  print(parsed, payload, () =>
    payload.models.map(
      (model) =>
        `${model.id === fallback ? "*" : " "} ${model.id.padEnd(44)} ${model.efforts.length > 0 ? `efforts: ${model.efforts.join(", ")}` : ""}`,
    ),
  );
};

export const resultLines = (run: EvalRun, cases: readonly EvalCase[]): string[] => {
  const titleOf = (id: string) => cases.find((item) => item.id === id)?.title ?? id;
  const passed = run.results.filter((result) => result.ok).length;
  return [
    ...run.results.flatMap((result) => [
      `${result.ok ? "✓" : "✗"} ${titleOf(result.caseId)}${result.score !== null ? ` (Jev ${result.score.toFixed(2)})` : ""}`,
      ...(result.error !== null ? [`    ${result.error}`] : []),
      ...result.checks
        .filter((check) => !check.ok)
        .map((check) => `    ${check.name}: ${check.detail}`),
    ]),
    ...(run.error !== null ? [run.error] : []),
    `${passed} of ${run.caseIds.length} passed${run.model !== null ? ` on ${run.model}` : ""}.`,
  ];
};

/** Wait for a run to finish, printing each result as it lands. */
const waitFor = async (api: Api, started: EvalRun, timeoutMs: number): Promise<EvalRun> => {
  const deadline = Date.now() + timeoutMs;
  let run = started;
  let shown = 0;
  while (run.status === "running") {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for the tests (they keep running)");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    run = await api.evalRun(run.id);
    for (; shown < run.results.length; shown++) process.stderr.write(".");
  }
  if (shown > 0) process.stderr.write("\n");
  return run;
};

export const tests = async (parsed: Parsed): Promise<number> => {
  const api = apiFor(parsed);
  const bot = await botOf(api, parsed);
  const cases = await api.evals(bot?.id);
  if (parsed.positionals[1] !== "run") {
    print(parsed, cases, () =>
      cases.length === 0
        ? ["No tests yet. In the chat (spriessen), type /test after one of your messages."]
        : cases.map((item) => `${item.id.slice(0, 8)}  ${item.title}`),
    );
    return 0;
  }
  const model = stringFlag(parsed, "model");
  const started = await api.startEvals({
    ...(bot !== undefined ? { botId: bot.id } : {}),
    ...(model !== undefined ? { model } : {}),
  });
  console.error(`Running ${started.caseIds.length} test(s)…`);
  const run = await waitFor(api, started, (numberFlag(parsed, "timeout") ?? 1_800) * 1000);
  print(parsed, run, () => resultLines(run, cases));
  return run.status === "done" && run.results.every((result) => result.ok) ? 0 : 1;
};
