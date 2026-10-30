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
  sm: "size-6 text-xs",
  md: "size-7 text-xs",
  xl: "size-10 text-sm",
  lg: "size-14 text-lg",
} as const;

/** A round initials avatar (no images are stored for bots). */
export function BotAvatar({ name, size = "md" }: { name: string; size?: keyof typeof sizes }) {
  return (
    <span
      aria-hidden
      className={`bg-primary text-primary-foreground inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${sizes[size]}`}
    >
      {initialsOf(name)}
    </span>
  );
}
