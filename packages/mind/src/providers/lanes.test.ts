import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { converseService } from "../converse/converse.ts";
import { gateModels } from "./gate.ts";
import { lanesExtension, modelLanes, type ModelLanes } from "./lanes.ts";

describe("modelLanes", () => {
  it("reads the lane a request was marked with, by signal or by provider session", () => {
    const lanes = modelLanes();
    const signal = new AbortController().signal;
    lanes.mark(signal, undefined, "background");
    lanes.mark(undefined, "provider-1", "background");
    expect(lanes.laneOf({ signal })).toBe("background");
    expect(lanes.laneOf({ sessionId: "provider-1" })).toBe("background");
  });

  it("puts anything unmarked on the owner lane", () => {
    const lanes = modelLanes();
    expect(lanes.laneOf(undefined)).toBe("owner");
    expect(lanes.laneOf({ sessionId: "never-seen" })).toBe("owner");
    expect(lanes.laneOf({ signal: new AbortController().signal })).toBe("owner");
  });

  it("a later mark of the same conversation wins", () => {
    const lanes = modelLanes();
    lanes.mark(undefined, "p", "background");
    lanes.mark(undefined, "p", "owner");
    expect(lanes.laneOf({ sessionId: "p" })).toBe("owner");
  });
});

describe("lanesExtension (real harness, faux model)", () => {
  it("marks each request with its conversation's lane before it reaches the gate", async () => {
    const faux = fauxProvider();
    const raw = createModels();
    raw.setProvider(faux.provider);
    const lanes = modelLanes();
    const seen: string[] = [];
    const spy: ModelLanes = {
      ...lanes,
      laneOf: (options) => {
        const lane = lanes.laneOf(options);
        seen.push(lane);
        return lane;
      },
    };
    const models = gateModels(raw, 2, spy);
    faux.setResponses([fauxAssistantMessage(fauxText("a")), fauxAssistantMessage(fauxText("b"))]);
    const registry = createRegistry();
    let background = "";
    registry.install(lanesExtension(lanes, (id) => (id === background ? "background" : "owner")));
    const model = faux.getModel();
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry },
      BACKGROUND_CONTEXT,
    );
    const converse = converseService(harness, {
      model: { provider: model.provider, modelId: model.id },
    });
    const task = await Effect.runPromise(converse.ensure("task:x"));
    background = String(task.id);
    await Effect.runPromise(converse.turn(task, "work"));
    const chat = await Effect.runPromise(converse.ensure("chat"));
    await Effect.runPromise(converse.turn(chat, "hello"));
    expect(seen).toEqual(["background", "owner"]);
    await harness.close(BACKGROUND_CONTEXT);
  });
});
