/**
 * An incoming webhook: "Webhook received", its event name, where it came
 * from and when; the payload stays collapsed and pretty-prints on expand
 * (secret-looking fields masked). The webhook's token is never shown.
 */
import { useEffect, useId, useState } from "react";
import { WebhookIcon } from "lucide-react";
import { api } from "@/lib/api";
import { prettyPayload, type SystemMessage } from "@/lib/system-text";
import { CardShell, ShowMore } from "./card-shell";

type WebhookMessage = Extract<SystemMessage, { kind: "webhook" }>;

let names: Promise<Map<string, string>> | null = null;

/** Webhook names, fetched once per page load (only names leave the cache). */
function useWebhookName(id: string): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    names ??= api
      .webhooks()
      .then((list) => new Map(list.map((hook) => [hook.id, hook.name ?? ""])))
      .catch(() => new Map<string, string>());
    let live = true;
    void names.then((map) => {
      const found = map.get(id);
      if (live && found !== undefined && found !== "") setName(found);
    });
    return () => {
      live = false;
    };
  }, [id]);
  return name;
}

export function WebhookCard({ message, at }: { message: WebhookMessage; at: number }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const name = useWebhookName(message.webhookId);
  return (
    <CardShell
      icon={<WebhookIcon className="text-primary" />}
      title={
        <>
          Webhook received
          {message.event !== null && (
            <span className="text-muted-foreground font-normal"> · {message.event}</span>
          )}
        </>
      }
      at={at}
    >
      <div className="flex flex-col items-start">
        <span className="text-muted-foreground flex flex-wrap items-center gap-x-1.5">
          <span>From {name ?? "a webhook"}</span>
          {message.contextOnly && (
            <span title="The sender is not on this webhook's allow list: the bot reads it as context and does not act on it.">
              · context only
            </span>
          )}
          {message.payload === "" ? (
            <span>· no payload</span>
          ) : (
            <ShowMore
              open={open}
              onToggle={() => setOpen((v) => !v)}
              more="Show payload"
              less="Hide payload"
              controls={id}
            />
          )}
        </span>
        {open && (
          <pre
            id={id}
            className="bg-muted/60 mt-1 max-h-64 w-full overflow-auto rounded-lg p-2.5 font-mono text-xs leading-relaxed"
          >
            {prettyPayload(message)}
          </pre>
        )}
      </div>
    </CardShell>
  );
}
