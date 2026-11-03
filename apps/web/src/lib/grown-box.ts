/**
 * One-line pill vs grown squircle, measured not inferred: the bare textarea
 * auto-grows (field-sizing), so the rendered height is the truth in every
 * engine. Growth sticks while a draft exists (deleting text back down to one
 * line mid-edit must not snap the box back) — the box collapses only when the
 * draft clears (send or wipe), never mid-typing.
 */
import * as React from "react";

export function useGrownBox(draft: string): {
  boxRef: React.RefObject<HTMLDivElement | null>;
  grown: boolean;
} {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const [grown, setGrown] = React.useState(false);
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  // watch() must also run when the draft changes, not only on resize: while
  // growth is sticky the box can already be at one-line height when the draft
  // clears, so clearing produces NO resize event to collapse from.
  const watchRef = React.useRef<() => void>(() => {});
  React.useLayoutEffect(() => {
    const el = boxRef.current;
    if (el === null) return;
    // One line tops out at 56px (6px padding + 44px touch-min textarea); a
    // second line clears 60. Observe, so font-size media changes also apply.
    const watch = () =>
      setGrown((was) =>
        draftRef.current !== "" ? was || el.offsetHeight > 60 : el.offsetHeight > 60,
      );
    watch();
    watchRef.current = watch;
    const observer = new ResizeObserver(watch);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  React.useEffect(() => {
    watchRef.current();
  }, [draft]);
  return { boxRef, grown };
}

/** The box's shape: a pill at one line, a 3xl squircle once grown — a stadium cap on a tall box eats the layout. */
export const grownBoxStyle = (grown: boolean): React.CSSProperties =>
  ({
    borderRadius: grown ? "var(--radius-3xl)" : "9999px",
    cornerShape: "squircle",
  }) as React.CSSProperties;
