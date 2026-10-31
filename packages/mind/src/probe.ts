// Live verification for the mind's faculties (network + keys required).
// LLM calls go through the pi-durable harness — the same path the app uses.
// Run: vp node --env-file=.env packages/mind/src/probe.ts
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { openMind } from "./entity.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect);

// 1) Converse: the default model (SPREISSEN_MODEL) through the durable harness (turn = submit -> wait -> commit).
const handle = await openMind({ storage: new MemoryStorage() });
const mind = handle.mind;
const started = Date.now();
const root = await run(mind.converse.root());
const first = await run(
  mind.converse.turn(
    root,
    'Reply with strict JSON only, no prose: {"ok":true,"model_used":string} where model_used is your model id.',
  ),
);
const text = first.text.trim().replace(/^```json\s*|```$/g, "");
console.log(`${mind.models.defaultRef()} (harness): latency=${Date.now() - started}ms`);
console.log("converse:", text.slice(0, 200));
JSON.parse(text); // throws if the model wrapped or truncated the JSON

// 1b) Act: Jev as a native tool of the agent loop (jev_score).
const toolTurn = await run(
  mind.converse.turn(
    root,
    'Use the jev_score tool on the statement "The sky is typically blue." with the instruction "Is the statement true?" Then reply with just the probability as a bare number.',
  ),
);
const toolText = toolTurn.text.trim();
const match = toolText.match(/(\d+(?:\.\d+)?)/);
const probability = match === null ? Number.NaN : Number.parseFloat(match[1] ?? "");
console.log(`jev via jev_score tool: reply="${toolText.slice(0, 80)}" -> ${probability}`);
if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
  throw new Error("jev tool path failed: no probability in reply");
}

// 1c) Act: temporal awareness + the live-web tools (TinyFish, TINYFISH_API_KEY).
const now = mind.act.tools().find((tool) => tool.name === "now");
if (now === undefined) throw new Error("now tool missing");
const nowResult = await now.execute({}, {} as never, {} as never);
console.log("now:", JSON.stringify(nowResult.structuredOutput));
const search = mind.act.tools().find((tool) => tool.name === "web_search");
if (search === undefined) throw new Error("web_search missing: is TINYFISH_API_KEY set?");
const searchResult = await search.execute(
  { query: "TinyFish web toolkit" },
  {} as never,
  {} as never,
);
const found = searchResult.structuredOutput as { results?: unknown[] };
if (found.results === undefined || found.results.length === 0) {
  throw new Error("web_search returned no results");
}
console.log(
  `web_search: ${found.results.length} results, first: ${JSON.stringify(found.results[0]).slice(0, 140)}`,
);

// 2) Decide: the independent faculty — no conversation involved.
const yes = await run(
  mind.decide.yesNo("A clear-sky day typically has a blue sky.", "Is the statement true?"),
);
console.log(`jev yes-probability: ${yes}`);
if (!(yes > 0.5)) throw new Error("jev sanity check failed");
await handle.close();
console.log("probe ok");
