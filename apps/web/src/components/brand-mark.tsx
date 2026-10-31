/**
 * The mark in the app: the amber gumdrop with two eyes and a sprout, drawn from the
 * brand geometry in theme colors. It blinks once on hover (never on its own,
 * never with reduced motion).
 */
import { BRAND, MARK } from "@/lib/brand";
import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${MARK.viewBox} ${MARK.viewBox}`}
      aria-hidden
      className={cn("brand-mark size-6 shrink-0", className)}
    >
      <path d={MARK.body} className="fill-[var(--brand-amber)]" />
      <path d={MARK.sprout} className="fill-[var(--brand-amber)]" />
      <g className="char-eyes fill-[var(--brand-ink)]">
        {MARK.eyes.map((eye) => (
          <ellipse key={eye.cx} {...eye} />
        ))}
      </g>
    </svg>
  );
}

/** Mark plus the lowercase wordmark: the sidebar's top-left. */
export function BrandLockup({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <BrandMark />
      <span className="font-heading text-[1.0625rem] font-semibold tracking-tight">
        {BRAND.wordmark}
      </span>
    </span>
  );
}
