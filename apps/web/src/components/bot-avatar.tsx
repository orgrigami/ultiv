/** The bot's face and the chat link's state, shared by the header and lists. */
import { spectralClass } from "@/lib/spectral";

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

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";

const sizes = {
  sm: "size-6 text-[0.625rem]",
  md: "size-7 text-[0.6875rem]",
  xl: "size-10 text-[0.8125rem]",
  lg: "size-14 text-lg",
} as const;

/** A round initials avatar in the bot's spectral tint (no images are stored). */
export function BotAvatar({
  name,
  id,
  size = "md",
}: {
  name: string;
  id?: string | undefined;
  size?: keyof typeof sizes;
}) {
  return (
    <span
      aria-hidden
      className={`${spectralClass(id ?? name)} spec inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${sizes[size]}`}
      style={{
        background: "var(--spec-soft, color-mix(in oklch, var(--primary) 14%, transparent))",
        color: "color-mix(in oklch, var(--spec) 62%, var(--foreground))",
        boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--spec) 30%, transparent)",
      }}
    >
      {initialsOf(name)}
    </span>
  );
}
