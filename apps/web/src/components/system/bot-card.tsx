/**
 * Bot-to-bot mail in the chat: a quiet centered pill — who, which way, what
 * about — that opens the conversation in the work pane (beside the chat on
 * desktop, full-height sheet on phones). The body lives in the room's
 * timeline, never inline in the transcript; a message that never arrived
 * (a nack) says why on the pill.
 */
import { useState } from "react";
import { ArrowLeftIcon, ArrowRightIcon, CircleAlertIcon } from "lucide-react";
import { BotAvatar } from "@/components/bot-avatar";
import { RowButton } from "@/components/ui/row-button";
import { useApp } from "@/lib/app-state";
import { api } from "@/lib/api";
import { formatClock, formatFull } from "@/lib/format";
import { useOpenWork } from "@/lib/work-pane";
import type { SystemMessage } from "@/lib/system-text";
import { cn } from "@/lib/utils";
import { enter } from "./card-shell";

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

/** The pill frame: centered, quiet, opens the conversation when clickable. */
function MailPill({
  icon,
  label,
  detail,
  at,
  envelopeId,
  tone = "plain",
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  detail?: string | undefined;
  at: number;
  envelopeId: string | null;
  tone?: "plain" | "muted";
}) {
  const [busy, setBusy] = useState(false);
  const openWork = useOpenWork();
  const clickable = envelopeId !== null && openWork !== null;
  const openRoom = (): void => {
    if (envelopeId === null || openWork === null || busy) return;
    setBusy(true);
    void api
      .roomByEnvelope(envelopeId)
      .then((detail_) =>
        openWork({
          kind: "room",
          roomId: detail_.room.id,
          title: detail_.participants.map((participant) => participant.name).join(" ↔ "),
          topic: detail_.room.topic === "" ? null : detail_.room.topic,
        }),
      )
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  return (
    <div className={cn("flex w-full justify-center", enter)}>
      <RowButton
        title={detail ?? undefined}
        disabled={!clickable}
        onClick={openRoom}
        className={cn(
          "inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors",
          clickable
            ? "border-border/60 bg-muted/30 hover:bg-muted/60 active:scale-[0.98] motion-reduce:active:scale-100"
            : tone === "muted"
              ? "cursor-default border-border border-dashed"
              : "cursor-default border-border/60 bg-muted/30",
        )}
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
        <time
          className="text-muted-foreground readout shrink-0"
          dateTime={new Date(at).toISOString()}
          title={formatFull(at)}
        >
          {formatClock(at)}
        </time>
      </RowButton>
    </div>
  );
}

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
    <MailPill
      icon={
        <>
          <BotAvatar id={id} name={name} size="sm" />
          <Arrow aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
        </>
      }
      label={
        <>
          {head}
          {extra !== "" && <span className="text-muted-foreground font-normal"> · {extra}</span>}
        </>
      }
      detail={message.body !== "" ? message.body : undefined}
      at={at}
      envelopeId={message.envelopeId}
    />
  );
}

export function NackCard({ message, at }: { message: NackMessage; at: number }) {
  const name = useBotName(message.who);
  return (
    <MailPill
      icon={<CircleAlertIcon className="text-destructive size-3.5 shrink-0" />}
      label={
        <>
          Message to {name}
          <span className="text-muted-foreground font-normal"> · {message.reason}</span>
        </>
      }
      detail={message.detail}
      at={at}
      envelopeId={message.envelopeId}
      tone="muted"
    />
  );
}
