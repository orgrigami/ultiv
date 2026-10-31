/** The bot's face and the chat link's state, shared by the header and lists. */
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

/** A round initials avatar on a neutral plate (no images are stored). */
export function BotAvatar({
  name,
  size = "md",
}: {
  /** The bot's id: the seed for its character (falls back to the name). */
  id?: string | undefined;
  name: string;
  size?: keyof typeof sizes;
}) {
  return (
    <span
      aria-hidden
      className={`bg-secondary text-secondary-foreground ring-border inline-flex shrink-0 items-center justify-center rounded-full font-semibold ring-1 ${sizes[size]}`}
    >
      {initialsOf(name)}
    </span>
  );
}
