/**
 * The pure halves of the live takeover view: where a click on the DISPLAYED
 * picture lands in the frame's own pixels (the server maps those to the
 * page), and which keystrokes belong to the bot's page rather than the app.
 */
import { describe, expect, it } from "vite-plus/test";
import { actQueue, imagePoint, keyDecision } from "./takeover-cast.ts";

describe("imagePoint", () => {
  it("maps display pixels to frame pixels at any display width", () => {
    const frame = { w: 1280, h: 800 };
    expect(imagePoint(frame, 640, { x: 320, y: 200 })).toEqual({ x: 640, y: 400 });
    expect(imagePoint(frame, 1280, { x: 320, y: 200 })).toEqual({ x: 320, y: 200 });
    expect(imagePoint(frame, 400, { x: 100, y: 50 })).toEqual({ x: 320, y: 160 });
  });

  it("clamps to the frame, never outside it", () => {
    const frame = { w: 1280, h: 800 };
    expect(imagePoint(frame, 640, { x: -20, y: -20 })).toEqual({ x: 0, y: 0 });
    expect(imagePoint(frame, 640, { x: 700, y: 500 })).toEqual({ x: 1279, y: 799 });
  });

  it("survives a zero-width box without dividing by it", () => {
    expect(imagePoint({ w: 1280, h: 800 }, 0, { x: 100, y: 50 })).toEqual({ x: 100, y: 50 });
  });
});

describe("keyDecision", () => {
  const bare = (key: string) => ({ key, ctrlKey: false, metaKey: false, altKey: false });

  it("sends printable characters as typing and named keys as keys", () => {
    expect(keyDecision(bare("a"))).toEqual({ send: "type", text: "a" });
    expect(keyDecision(bare(" "))).toEqual({ send: "type", text: " " });
    expect(keyDecision(bare("7"))).toEqual({ send: "type", text: "7" });
    expect(keyDecision(bare("Enter"))).toEqual({ send: "key", key: "Enter" });
    expect(keyDecision(bare("Backspace"))).toEqual({ send: "key", key: "Backspace" });
    expect(keyDecision(bare("ArrowLeft"))).toEqual({ send: "key", key: "ArrowLeft" });
  });

  it("Escape releases focus; modifiers and bare modifier keys stay with the app", () => {
    expect(keyDecision(bare("Escape"))).toEqual({ send: "escape" });
    expect(keyDecision({ ...bare("a"), metaKey: true })).toEqual({ send: "passthrough" });
    expect(keyDecision({ ...bare("c"), ctrlKey: true })).toEqual({ send: "passthrough" });
    expect(keyDecision({ ...bare("e"), altKey: true })).toEqual({ send: "passthrough" });
    expect(keyDecision(bare("Shift"))).toEqual({ send: "passthrough" });
    expect(keyDecision(bare("CapsLock"))).toEqual({ send: "passthrough" });
  });
});

describe("actQueue", () => {
  it("sends acts one at a time, in order — typed text lands before the Enter after it", async () => {
    const seen: string[] = [];
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = actQueue(async (act) => {
      if (act.a === "type") await slow;
      seen.push(act.a);
    });
    const typed = send({ a: "type", text: "hunter2" });
    const entered = send({ a: "key", key: "Enter" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual([]);
    release();
    await Promise.all([typed, entered]);
    expect(seen).toEqual(["type", "key"]);
  });

  it("a failed act does not block the ones after it", async () => {
    const seen: string[] = [];
    const send = actQueue(async (act) => {
      if (act.a === "reload") throw new Error("gone");
      seen.push(act.a);
    });
    await expect(send({ a: "reload" })).rejects.toThrow("gone");
    await send({ a: "key", key: "Tab" });
    expect(seen).toEqual(["key"]);
  });
});
