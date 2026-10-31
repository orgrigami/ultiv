/**
 * An empty screen with a face: the bot's own character (or the Ultiv mark
 * when the screen is the whole crew's), a short title and one plain line
 * on how something gets here. Still unless hovered; nothing loops.
 */
import { BotAvatar } from "@/components/bot-avatar";
import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/utils";

export function CharacterEmpty({
  title,
  children,
  bot,
  className,
}: {
  title: string;
  children?: React.ReactNode;
  /** Whose face to show; the mark when omitted. */
  bot?: { id?: string | undefined; name: string } | undefined;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bg-card flex flex-col items-center gap-1.5 rounded-3xl border px-4 py-8 text-center",
        className,
      )}
    >
      {bot === undefined ? (
        <BrandMark className="mb-1 size-12" />
      ) : (
        <BotAvatar id={bot.id} name={bot.name} size="lg" className="mb-1" />
      )}
      <p className="text-sm font-medium">{title}</p>
      {children !== undefined && (
        <p className="text-muted-foreground max-w-xs text-sm">{children}</p>
      )}
    </div>
  );
}
