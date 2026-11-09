/**
 * The live picture's gestures and the phone keyboard's hidden field, pure:
 * a mouse click is a tap with its click count, a mouse drag is down/move/up,
 * a finger swipe scrolls the page against the finger, a held finger presses
 * and drags, two quick taps count 2; and the hidden field reads back typed
 * text, a Backspace on its "empty" value, and line breaks as Enter.
 */
import { describe, expect, it } from "vite-plus/test";
import { mouseGesture, touchGesture } from "./cast-pointer.ts";
import { catcherActs, KEY_SENTINEL, textActs } from "./cast-keys.ts";

const same = (at: { x: number; y: number }) => ({ x: at.x * 2, y: at.y * 2 });

describe("mouseGesture", () => {
  it("a still press is one tap with the browser's click count", () => {
    const press = mouseGesture({ x: 10, y: 10 }, "f1", same);
    expect(press.move({ x: 12, y: 11 })).toEqual([]);
    expect(press.up({ x: 12, y: 11 }, 2)).toEqual([{ a: "tap", x: 20, y: 20, id: "f1", count: 2 }]);
  });

  it("a moving press is a drag: down where it began, held moves, up where it ends", () => {
    const press = mouseGesture({ x: 10, y: 10 }, "f1", same);
    expect(press.move({ x: 30, y: 10 })).toEqual([
      { a: "down", x: 20, y: 20, id: "f1" },
      { a: "move", x: 60, y: 20, id: "f1", held: true },
    ]);
    expect(press.move({ x: 40, y: 10 })).toEqual([
      { a: "move", x: 80, y: 20, id: "f1", held: true },
    ]);
    expect(press.up({ x: 40, y: 10 }, 1)).toEqual([{ a: "up", x: 80, y: 20, id: "f1" }]);
  });
});

describe("touchGesture", () => {
  it("a swipe scrolls against the finger, in frame pixels", () => {
    const finger = touchGesture({ x: 50, y: 100 }, "f1", same, 2, null);
    expect(finger.move({ x: 50, y: 80 })).toEqual([
      { a: "scroll", dx: 0, dy: 40, x: 100, y: 160, id: "f1" },
    ]);
    expect(finger.end({ x: 50, y: 80 }, 200)).toEqual({ acts: [], tap: false });
  });

  it("a still finger taps; a second quick tap in the same spot counts 2", () => {
    const first = touchGesture({ x: 5, y: 5 }, "f1", same, 2, null);
    expect(first.end({ x: 5, y: 5 }, 80)).toEqual({
      acts: [{ a: "tap", x: 10, y: 10, id: "f1" }],
      tap: true,
    });
    const second = touchGesture({ x: 6, y: 5 }, "f1", same, 2, { at: 80, point: { x: 5, y: 5 } });
    expect(second.end({ x: 6, y: 5 }, 200).acts).toEqual([
      { a: "tap", x: 12, y: 10, id: "f1", count: 2 },
    ]);
  });

  it("a held finger presses, drags and lifts", () => {
    const finger = touchGesture({ x: 5, y: 5 }, "f1", same, 2, null);
    expect(finger.hold()).toEqual([{ a: "down", x: 10, y: 10, id: "f1" }]);
    expect(finger.move({ x: 40, y: 5 })).toEqual([
      { a: "move", x: 80, y: 10, id: "f1", held: true },
    ]);
    expect(finger.end({ x: 40, y: 5 }, 900)).toEqual({
      acts: [{ a: "up", x: 80, y: 10, id: "f1" }],
      tap: false,
    });
  });
});

describe("the phone keyboard's hidden field", () => {
  it("reads typed text after the sentinel, nothing when only it is left", () => {
    expect(catcherActs(`${KEY_SENTINEL}hello `)).toEqual([{ a: "type", text: "hello " }]);
    expect(catcherActs(KEY_SENTINEL)).toEqual([]);
  });

  it("reads a deleted sentinel as Backspace and line breaks as Enter", () => {
    expect(catcherActs("")).toEqual([{ a: "key", key: "Backspace" }]);
    expect(catcherActs(`${KEY_SENTINEL}123456\n`)).toEqual([
      { a: "type", text: "123456" },
      { a: "key", key: "Enter" },
    ]);
  });

  it("keeps text typed before the sentinel or after a rewrite; pastes split on lines", () => {
    expect(catcherActs(`x${KEY_SENTINEL}`)).toEqual([{ a: "type", text: "x" }]);
    expect(catcherActs("Hello")).toEqual([{ a: "type", text: "Hello" }]);
    expect(textActs("a\r\nb")).toEqual([
      { a: "type", text: "a" },
      { a: "key", key: "Enter" },
      { a: "type", text: "b" },
    ]);
  });
});
