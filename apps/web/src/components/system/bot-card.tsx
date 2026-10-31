/**
 * Bot-to-bot mail in the chat: the other bot's avatar and name, which way the
 * message went, and its body. A message that never arrived (a nack) says why
 * in plain words.
 */
import { ArrowLeftIcon, ArrowRightIcon, CircleAlertIcon } from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import { LazyMarkdown } from "@/components/lazy-markdown";
import { useApp } from "@/lib/app-state";
import type { SystemMessage } from "@/lib/system-text";
import { CardShell } from "./card-shell";

type BotMessage = Extract<SystemMessage, { kind: "bot" }>;
type NackMessage = Extract<SystemMessage, { kind: "nack" }>;

/** A bot id (outgoing mail) or name (incoming) as the bot, when it is known. */
function useBot(who: string): { id: string | undefined; name: string } {
  const { sessions } = useApp();
  const bot = sessions.profiles.find((row) => row.id === who || row.name === who);
  return {
    id: bot?.id,
    name: bot?.name ?? (/^[0-9a-f-]{36}$/i.test(who) ? "another bot" : who),
  };
}

const useBotName = (who: string): string => useBot(who).name;

export function BotCard({ message, at }: { message: BotMessage; at: number }) {
  const { id, name } = useBot(message.who);
  const Arrow = message.direction === "in" ? ArrowLeftIcon : ArrowRightIcon;
  const head =
    message.direction === "out"
      ? `To ${name}`
      : message.reply
        ? `Reply from ${name}`
        : `From ${name}`;
  const extra = [message.asks ? "asks for a reply" : null, message.topic]
    .filter(Boolean)
    .join(" · ");
  return (
    <CardShell
      icon={<BotAvatar id={id} name={name} size="sm" />}
      title={
        <span className="inline-flex max-w-full items-center gap-1.5">
          <Arrow aria-hidden className="text-muted-foreground size-3.5! shrink-0" />
          <span className="truncate">
            {head}
            {extra !== "" && <span className="text-muted-foreground font-normal"> · {extra}</span>}
          </span>
        </span>
      }
      at={at}
    >
      {message.body !== "" && (
        <div className="prose prose-sm dark:prose-invert max-w-none break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <LazyMarkdown text={message.body} />
        </div>
      )}
    </CardShell>
  );
}

export function NackCard({ message, at }: { message: NackMessage; at: number }) {
  const name = useBotName(message.who);
  return (
    <CardShell
      icon={<CircleAlertIcon className="text-destructive" />}
      title={
        <>
          Message to {name}
          <span className="text-muted-foreground font-normal"> · {message.reason}</span>
        </>
      }
      at={at}
      tone="muted"
    />
  );
}
