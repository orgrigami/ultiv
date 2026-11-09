/**
 * The live picture's hands: pointer and touch on the picture become acts on
 * the bot's page (cast-pointer.ts decides what each gesture means), and the
 * picture's size on screen is measured so frames match it. Moves are
 * coalesced (one per MOVE_MS, the latest wins; swipe deltas add up) so a
 * drag never queues hundreds of POSTs; a tap or a click focuses the hidden
 * keyboard field (a phone opens its keyboard only from a tap).
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  HOLD_MS,
  imagePoint,
  mouseGesture,
  touchGesture,
  type PointerAct,
} from "./cast-pointer.ts";
import type { TakeoverCast } from "./takeover-cast.ts";

const MOVE_MS = 60;
const HOVER_MS = 150;
const DOUBLE_MS = 350;

type Point = { x: number; y: number };

/** The element's size in device pixels, re-measured as it changes; null until first measured. */
export function useBoxSize(box: RefObject<HTMLElement | null>): { w: number; h: number } | null {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = box.current;
    if (el === null || typeof ResizeObserver === "undefined") {
      setSize({ w: 1280, h: 800 });
      return;
    }
    const measure = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(el.clientWidth * dpr);
      const h = Math.round((el.clientHeight || (el.clientWidth * 10) / 16) * dpr);
      if (w > 0) setSize((before) => (before?.w === w && before.h === h ? before : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [box]);
  return size;
}

/** Coalesce pointer moves and swipe scrolls into at most one act per MOVE_MS. */
const coalescer = (send: (act: PointerAct) => void) => {
  let pending: PointerAct | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    timer = null;
    if (pending !== null) send(pending);
    pending = null;
  };
  return {
    push: (act: PointerAct): void => {
      if (act.a === "scroll" && pending?.a === "scroll") {
        pending = { ...act, dx: pending.dx + act.dx, dy: pending.dy + act.dy };
      } else {
        if (pending !== null && pending.a !== act.a) send(pending);
        pending = act;
      }
      timer ??= setTimeout(flush, MOVE_MS);
    },
    now: (act: PointerAct): void => {
      if (timer !== null) clearTimeout(timer);
      flush();
      send(act);
    },
  };
};

/** Mouse, pen and finger on the picture, sent to the page while `drive` is on. */
export function useCastInput(
  box: RefObject<HTMLDivElement | null>,
  cast: TakeoverCast,
  onTap: () => void,
  drive: boolean,
): void {
  const latest = useRef({ cast, onTap });
  latest.current = { cast, onTap };
  useEffect(() => {
    const el = box.current;
    if (el === null || !drive) return;
    const local = (event: PointerEvent): Point => {
      const rect = el.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const to = (at: Point): Point => {
      const frame = latest.current.cast.frame;
      return frame === null ? at : imagePoint(frame, el.getBoundingClientRect().width, at);
    };
    const frameId = (): string => latest.current.cast.frame?.id ?? "";
    const moves = coalescer((act) => latest.current.cast.send(act));
    const sendAll = (acts: readonly PointerAct[]): void => {
      for (const act of acts) {
        if (act.a === "move" || act.a === "scroll" || act.a === "hover") moves.push(act);
        else moves.now(act);
      }
    };
    let mouse: ReturnType<typeof mouseGesture> | null = null;
    let finger: ReturnType<typeof touchGesture> | null = null;
    let hold: ReturnType<typeof setTimeout> | null = null;
    let lastTap: { at: number; point: Point } | null = null;
    let lastHover = 0;
    const clearHold = (): void => {
      if (hold !== null) clearTimeout(hold);
      hold = null;
    };
    const onDown = (event: PointerEvent): void => {
      if (latest.current.cast.frame === null || event.button > 0) return;
      el.setPointerCapture(event.pointerId);
      const at = local(event);
      if (event.pointerType === "touch") {
        const frame = latest.current.cast.frame;
        const scale = frame.w / Math.max(1, el.getBoundingClientRect().width);
        const gesture = touchGesture(at, frameId(), to, scale, lastTap);
        finger = gesture;
        hold = setTimeout(() => sendAll(gesture.hold()), HOLD_MS);
      } else mouse = mouseGesture(at, frameId(), to);
    };
    const onMove = (event: PointerEvent): void => {
      const at = local(event);
      if (finger !== null) {
        const acts = finger.move(at);
        if (acts.length > 0 && acts[0]?.a === "scroll") clearHold();
        sendAll(acts);
      } else if (mouse !== null) sendAll(mouse.move(at));
      else if (event.pointerType === "mouse" && event.timeStamp - lastHover > HOVER_MS) {
        lastHover = event.timeStamp;
        sendAll([{ a: "hover", ...to(at), id: frameId() }]);
      }
    };
    const onUp = (event: PointerEvent): void => {
      const at = local(event);
      clearHold();
      if (finger !== null) {
        const ended = finger.end(at, event.timeStamp);
        sendAll(ended.acts);
        if (ended.tap) {
          lastTap = { at: event.timeStamp, point: at };
          latest.current.onTap();
        }
      } else if (mouse !== null) {
        const double = lastTap !== null && event.timeStamp - lastTap.at < DOUBLE_MS;
        sendAll(mouse.up(at, double ? 2 : 1));
        lastTap = { at: event.timeStamp, point: at };
        latest.current.onTap();
      }
      finger = null;
      mouse = null;
    };
    const onWheel = (event: WheelEvent): void => {
      // The wheel must not scroll the app behind the picture.
      event.preventDefault();
      moves.push({
        a: "scroll",
        dx: Math.max(-3000, Math.min(3000, event.deltaX)),
        dy: Math.max(-3000, Math.min(3000, event.deltaY)),
        ...to({ x: event.offsetX, y: event.offsetY }),
        id: frameId(),
      });
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      clearHold();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
    };
  }, [box, drive]);
}
