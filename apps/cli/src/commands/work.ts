/**
 * What the bots are working on, and their tests, from the command line:
 * `tasks` (background work; `show` one in full, `stop` one), `projects`
 * (goals over days), `models` (what
 * `--model` accepts) and `tests` / `tests run`. `tests run` waits for the
 * run and exits 1 when any test fails, so a script or CI can gate a model
 * or prompt change on it. Plain lines on stdout, `--json` for machines.
 */
import type { EvalCase, EvalRun, TaskRow } from "@spriessen/contracts";
import { boolFlag, numberFlag, stringFlag, type Parsed } from "../args.ts";
import type { Api } from "../client/http.ts";
import { ago, clip, paintFor, print, shortId, when } from "../render/out.ts";
import { apiFor, botFilter, findTask, namesOf } from "./context.ts";

const MARK: Record<string, string> = {
  queued: "◦",
  running: "…",
  done: "✓",
  failed: "✗",
  cancelled: "-",
};

/** Live work sorts first: running, then queued. */
const liveRank = (status: string): number =>
  status === "running" ? 2 : status === "queued" ? 1 : 0;

const markOf = (status: string): string => {
  const paint = paintFor();
  const mark = MARK[status] ?? "?";
  return status === "failed"
    ? paint.red(mark)
    : status === "running"
      ? paint.amber(mark)
      : status === "done"
        ? paint.green(mark)
        : paint.dim(mark);
};

const titleOf = (task: TaskRow): string => task.title ?? clip(task.prompt, 40);

const listTasks = async (parsed: Parsed): Promise<void> => {
  const api = apiFor(parsed);
  const [rows, names, bot] = await Promise.all([api.tasks(), namesOf(api), botFilter(api, parsed)]);
  const shown = rows
    .filter((task) => bot === undefined || task.bot?.profileId === bot.id)
    .sort((a, b) => liveRank(b.status) - liveRank(a.status) || b.createdAt - a.createdAt)
    .slice(0, boolFlag(parsed, "all") ? undefined : 20);
  const paint = paintFor();
  print(parsed, shown, () =>
    shown.length === 0
      ? ["No background tasks."]
      : [
          ...shown.map((task) => {
            const who = names.get(task.bot?.profileId ?? "") ?? "";
            const model = task.model !== undefined ? ` · ${task.model}` : "";
            const doing =
              task.status === "queued"
                ? paint.dim(" — queued")
                : task.status === "running" && task.lastStep !== undefined
                  ? paint.dim(` — ${clip(task.lastStep, 40)}`)
                  : "";
            return `${markOf(task.status)} ${paint.dim(shortId(task.id))}  ${clip(titleOf(task), 40).padEnd(40)} ${paint.dim(`${who}${model} · ${ago(task.createdAt)}`)}${doing}`;
          }),
          "",
          paint.dim("Read one: spriessen tasks show <id> · stop one: spriessen tasks stop <id>"),
        ],
  );
};

/** One task in full: what it was asked, where it stands, what it said. */
export const taskLines = (task: TaskRow, bot: string): string[] => {
  const paint = paintFor();
  const lines = [
    `${markOf(task.status)} ${paint.bold(titleOf(task))}`,
    paint.dim(
      `${bot}'s task ${shortId(task.id)} · ${task.status} · started ${when(task.createdAt)}` +
        (task.finishedAt !== null ? ` · ended ${when(task.finishedAt)}` : "") +
        (task.model !== undefined ? ` · ${task.model}` : ""),
    ),
    "",
    paint.dim("Asked:"),
    ...task.prompt.split("\n").map((line) => `  ${line}`),
  ];
  for (const update of task.updates ?? [])
    lines.push(paint.dim(`  · ${when(update.at)} ${update.text}`));
  if (task.status === "running" && task.lastStep !== undefined) {
    lines.push("", paint.amber(`Now: ${task.lastStep}`));
  }
  if (task.waitingApproval !== undefined) {
    lines.push(
      "",
      paint.amber(`Waiting for you: spriessen approve ${shortId(task.waitingApproval.callId)}`),
    );
  }
  if (task.error !== null) lines.push("", paint.red(task.error));
  if (task.result !== null) {
    lines.push("", paint.dim("Result:"), ...task.result.split("\n").map((line) => `  ${line}`));
  }
  return lines;
};

const showTask = async (parsed: Parsed, wanted: string): Promise<void> => {
  const api = apiFor(parsed);
  const [task, names] = await Promise.all([findTask(api, wanted), namesOf(api)]);
  print(parsed, task, () => taskLines(task, names.get(task.bot?.profileId ?? "") ?? "A bot"));
};

const stopTask = async (parsed: Parsed, wanted: string): Promise<number> => {
  const api = apiFor(parsed);
  const task = await findTask(api, wanted);
  if (task.status !== "running" && task.status !== "queued") {
    console.log(`That task already ${task.status === "done" ? "finished" : task.status}.`);
    return 0;
  }
  const { cancelled } = await api.cancelTask(task.id);
  console.log(
    cancelled ? `Stopped "${titleOf(task)}". Its bot is told once.` : "It had already ended.",
  );
  return 0;
};

export const tasksCommand = async (parsed: Parsed): Promise<number | void> => {
  const [, sub, id] = parsed.positionals;
  if (sub === undefined) return listTasks(parsed);
  if ((sub === "show" || sub === "stop") && id === undefined) {
    throw new Error(`usage: spriessen tasks ${sub} <id>  (ids from \`spriessen tasks\`)`);
  }
  if (sub === "show") return showTask(parsed, id as string);
  if (sub === "stop") return stopTask(parsed, id as string);
  throw new Error(
    `\`spriessen tasks ${sub}\` isn't a thing; try: tasks, tasks show <id>, tasks stop <id>`,
  );
};

export const projects = async (parsed: Parsed): Promise<void> => {
  const api = apiFor(parsed);
  const [bot, names] = await Promise.all([botFilter(api, parsed), namesOf(api)]);
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

/** `models default <id>`: the model every chat without its own starts on. */
const setDefault = async (parsed: Parsed): Promise<void> => {
  const api = apiFor(parsed);
  const wanted = parsed.positionals[2];
  const current = (await api.models()).workspaceDefault;
  if (wanted === undefined) {
    console.log(
      current === null
        ? "No workspace default yet, so chats without a model of their own can't answer.\nSet one: spriessen models default <id>"
        : `${current.ref}${current.source === "env" ? " (from SPRIESSEN_MODEL)" : ""}`,
    );
    return;
  }
  const { models: list } = await api.models();
  const model = list.find((candidate) => candidate.id === wanted);
  if (model === undefined) throw new Error(`${wanted} isn't a model here (see: spriessen models)`);
  await api.setDefaultModel(model.id, model.defaultEffort);
  console.log(`New chats now start on ${model.id}.`);
};

export const models = async (parsed: Parsed): Promise<void> => {
  if (parsed.positionals[1] === "default") return setDefault(parsed);
  if (parsed.positionals[1] !== undefined) {
    throw new Error("try: spriessen models, or spriessen models default [<id>]");
  }
  const payload = await apiFor(parsed).models();
  const fallback = payload.workspaceDefault?.ref;
  const paint = paintFor();
  const providers = [...new Set(payload.models.map((model) => model.providerName))];
  print(parsed, payload, () =>
    payload.models.length === 0
      ? ["No models yet: set a provider key in ~/.spriessen/.env (see: spriessen doctor)."]
      : [
          ...providers.flatMap((provider) => [
            paint.bold(provider),
            ...payload.models
              .filter((model) => model.providerName === provider)
              .map((model) => {
                const star = model.id === fallback ? paint.amber("*") : " ";
                const efforts =
                  model.efforts.length > 0 ? paint.dim(`efforts: ${model.efforts.join(", ")}`) : "";
                const image = model.input.includes("image") ? paint.dim(" · images") : "";
                return `${star} ${model.id.padEnd(44)} ${efforts}${image}`;
              }),
            "",
          ]),
          payload.workspaceDefault === null
            ? paint.amber("No workspace default yet: spriessen models default <id>")
            : paint.dim("* the workspace default (change it: spriessen models default <id>)"),
          paint.dim("For one chat: /model <id> in the chat, or --model where a command takes it"),
        ],
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
  const bot = await botFilter(api, parsed);
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
