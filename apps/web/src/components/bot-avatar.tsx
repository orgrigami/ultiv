/** The bot's face and the chat link's state, shared by the header and lists. */
import { memo } from "react";
import { CHARACTER_PATHS, characterOf, seedOf, type Character } from "@/lib/avatar";
import { cn } from "@/lib/utils";

export type LinkState = "connecting" | "live" | "lost";

export const linkLabel = {
  connecting: "Connecting…",
  live: "Connected",
  lost: "Disconnected",
} as const;

/** Who the chat is with — names the header, the composer and the empty state. */
export interface ChatBot {
  id?: string;
  name: string;
  description: string;
}

/** idle: still. thinking: looks around while its bot works. alert: hops when it needs you. */
export type AvatarMood = "idle" | "thinking" | "alert";

const sizes = {
  sm: "size-6",
  md: "size-7",
  xl: "size-10",
  lg: "size-14",
  hero: "size-24 sm:size-28",
} as const;

const INK = "var(--char-ink)";

function Eyes({ kind }: { kind: Character["eyes"] }) {
  if (kind === 3)
    return (
      <g className="char-eyes" fill="none" stroke={INK} strokeWidth={2.4} strokeLinecap="round">
        <path d={CHARACTER_PATHS.happyEye(26)} />
        <path d={CHARACTER_PATHS.happyEye(38)} />
      </g>
    );
  const [left, right] = kind === 2 ? [24.5, 39.5] : [26, 38];
  const [rx, ry] = kind === 1 ? [2.8, 2.8] : [2.6, 3.6];
  return (
    <g className="char-eyes" fill={INK}>
      <ellipse cx={left} cy={36} rx={rx} ry={ry} />
      <ellipse cx={right} cy={36} rx={rx} ry={ry} />
    </g>
  );
}

function Mouth({ kind }: { kind: Character["mouth"] }) {
  if (kind === 1)
    return (
      <path
        d={CHARACTER_PATHS.smile}
        fill="none"
        stroke={INK}
        strokeWidth={2}
        strokeLinecap="round"
      />
    );
  if (kind === 2) return <circle cx={32} cy={44} r={1.7} fill={INK} />;
  if (kind === 3)
    return (
      <g fill="var(--char-2)" opacity={0.55}>
        <circle cx={21.5} cy={42} r={2.6} />
        <circle cx={42.5} cy={42} r={2.6} />
      </g>
    );
  return null;
}

function Top({ kind, fill }: { kind: Character["top"]; fill: string }) {
  if (kind === 1) return <path d={CHARACTER_PATHS.sprout} fill={fill} />;
  if (kind === 2)
    return (
      <g>
        <path d="M32 20V12.5" stroke={fill} strokeWidth={2.2} strokeLinecap="round" />
        <circle cx={32} cy={11} r={2.8} fill={fill} />
      </g>
    );
  if (kind === 3)
    return (
      <g fill={fill}>
        <circle cx={20} cy={23} r={5} />
        <circle cx={44} cy={23} r={5} />
      </g>
    );
  return null;
}

/** The creature itself, on a soft plate tinted with its own color. */
const Creature = memo(function Creature({ seed }: { seed: string }) {
  const character = characterOf(seed);
  const fill = `var(--char-${character.hue})`;
  return (
    <>
      <circle cx={32} cy={32} r={32} fill={`color-mix(in oklab, ${fill} 28%, var(--card))`} />
      <Top kind={character.top} fill={fill} />
      <path d={CHARACTER_PATHS.body[character.body]} fill={fill} />
      <Eyes kind={character.eyes} />
      <Mouth kind={character.mouth} />
    </>
  );
});

/**
 * A bot's character avatar, drawn from its id (else its name). Decorative:
 * the name always sits beside it. Moves only on hover or focus, or when a
 * mood is set, and never with reduced motion.
 */
export function BotAvatar({
  id,
  name,
  size = "md",
  mood = "idle",
  className,
}: {
  /** The bot's id: the seed for its character (falls back to the name). */
  id?: string | undefined;
  name: string;
  size?: keyof typeof sizes;
  mood?: AvatarMood;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden
      data-mood={mood === "idle" ? undefined : mood}
      className={cn("char shrink-0 overflow-visible rounded-full", sizes[size], className)}
    >
      <Creature seed={seedOf(id, name)} />
    </svg>
  );
}
