/**
 * Pointing at the live picture, as acts on the page. Pure, so the gestures
 * are tested without a DOM:
 *
 * - A MOUSE click is one `tap` carrying the browser's click count (double
 *   clicks select words); a press that moves past a few pixels becomes a
 *   drag — `down` where it started, `move` (held) while it moves, `up` where
 *   it ends — so text selection and sliders work. Moving without a press is
 *   `hover` (menus that open on hover), throttled by the caller.
 * - A FINGER tap is a `tap` (two quick taps in one spot count 2); a finger
 *   that moves is a SWIPE — the page scrolls with it (`scroll`, the finger's
 *   motion inverted, in frame pixels); a finger held still for half a second
 *   presses and holds (`down`, then `move` held as it drags, `up` on lift):
 *   what a long-press selects or drags on a phone.
 */

/** A point on the DISPLAYED image, in its own pixels. */
export const imagePoint = (
  frame: { readonly w: number; readonly h: number },
  displayWidth: number,
  at: { readonly x: number; readonly y: number },
): { x: number; y: number } => {
  const scale = displayWidth > 0 ? frame.w / displayWidth : 1;
  return {
    x: Math.max(0, Math.min(frame.w - 1, Math.round(at.x * scale))),
    y: Math.max(0, Math.min(frame.h - 1, Math.round(at.y * scale))),
  };
};

export type PointerAct =
  | { a: "tap"; x: number; y: number; id: string; count?: number }
  | { a: "down" | "up" | "hover"; x: number; y: number; id: string }
  | { a: "move"; x: number; y: number; id: string; held: boolean }
  | { a: "scroll"; dx: number; dy: number; x: number; y: number; id: string };

type Point = { readonly x: number; readonly y: number };

/** Display pixels a press may wander before it is a drag (or a swipe). */
export const DRAG_SLOP = 6;
/** How long a still finger waits before it presses and holds. */
export const HOLD_MS = 500;
const DOUBLE_TAP_MS = 350;

const far = (a: Point, b: Point): boolean => Math.hypot(a.x - b.x, a.y - b.y) > DRAG_SLOP;

/** One mouse press, from down to up. `to` maps a display point to frame pixels. */
export const mouseGesture = (start: Point, frameId: string, to: (at: Point) => Point) => {
  let dragging = false;
  const at = (point: Point) => ({ ...to(point), id: frameId });
  return {
    move: (point: Point): PointerAct[] => {
      if (!dragging && !far(start, point)) return [];
      const acts: PointerAct[] = dragging ? [] : [{ a: "down", ...at(start) }];
      dragging = true;
      acts.push({ a: "move", ...at(point), held: true });
      return acts;
    },
    up: (point: Point, clicks: number): PointerAct[] =>
      dragging
        ? [{ a: "up", ...at(point) }]
        : [{ a: "tap", ...at(start), ...(clicks > 1 ? { count: Math.min(3, clicks) } : {}) }],
  };
};

/** A finger on the picture, from touch to lift. `scale` is frame px per display px. */
export const touchGesture = (
  start: Point,
  frameId: string,
  to: (at: Point) => Point,
  scale: number,
  lastTap: { readonly at: number; readonly point: Point } | null,
) => {
  let mode: "pending" | "swipe" | "hold" = "pending";
  let last = start;
  const at = (point: Point) => ({ ...to(point), id: frameId });
  return {
    /** The hold timer fired: press here and keep holding. */
    hold: (): PointerAct[] => {
      if (mode !== "pending") return [];
      mode = "hold";
      return [{ a: "down", ...at(start) }];
    },
    move: (point: Point): PointerAct[] => {
      if (mode === "hold") return [{ a: "move", ...at(point), held: true }];
      if (mode === "pending" && !far(start, point)) return [];
      mode = "swipe";
      const dx = (last.x - point.x) * scale;
      const dy = (last.y - point.y) * scale;
      last = point;
      return [{ a: "scroll", dx: Math.round(dx), dy: Math.round(dy), ...at(point) }];
    },
    end: (point: Point, endedAt: number): { acts: PointerAct[]; tap: boolean } => {
      if (mode === "hold") return { acts: [{ a: "up", ...at(point) }], tap: false };
      if (mode === "swipe") return { acts: [], tap: false };
      const double =
        lastTap !== null && endedAt - lastTap.at < DOUBLE_TAP_MS && !far(lastTap.point, start);
      return { acts: [{ a: "tap", ...at(start), ...(double ? { count: 2 } : {}) }], tap: true };
    },
  };
};
