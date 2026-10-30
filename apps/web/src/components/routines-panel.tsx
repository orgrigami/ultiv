/**
 * The Routines manager: everything that wakes a bot, with the receipts that
 * prove it did. Schedules (fire counts + failures), webhooks (reject
 * counters, recent rejected bodies, test-fire, URL+token for the OWNER —
 * the entity never sees the token), watches (calendar / feed / page), and
 * the shared receipt tail. The counterpart of docs/ROUTINES.md for humans.
 */
import { describeTool } from "@/lib/approval-text";
import { useCallback, useEffect, useState } from "react";
import type {
  AuditEvent,
  CronJobInfo,
  ProfileInfo,
  RoutineEvent,
  SensorInfo,
  WebhookInfo,
} from "@ultiv/contracts";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { Spinner } from "@/components/ui/spinner";
import { ScheduleRow, SensorRow } from "@/components/routine-rows";
import { CreateWebhook, WebhookRow } from "@/components/webhook-row";
import { Mark } from "@/components/state-mark";
import { api } from "@/lib/api";
import { formatFull, formatWhen } from "@/lib/format";

const SOURCE_LABEL: Record<string, string> = {
  cron: "Schedule",
  webhook: "Webhook",
  sensor: "Watch",
  test: "Test",
};

const STATUS_VARIANT: Record<string, "secondary" | "destructive" | "outline"> = {
  delivered: "secondary",
  failed: "destructive",
  rejected: "destructive",
};

interface Routines {
  cron: CronJobInfo[];
  webhooks: WebhookInfo[];
  sensors: SensorInfo[];
  events: RoutineEvent[];
  escalations: AuditEvent[];
}

async function loadRoutines(): Promise<Routines> {
  const [cron, webhooks, sensors, events, audit] = await Promise.all([
    api.cron(),
    api.webhooks(),
    api.sensors(),
    api.routineEvents(30),
    api.audit(200),
  ]);
  const escalations = audit
    .filter((event) => event.kind === "escalation")
    .slice(-8)
    .reverse();
  return { cron, webhooks, sensors, events, escalations };
}

/** The routines content, shown on the /routines page. */
export function RoutinesContent({ profiles }: { profiles: ProfileInfo[] }) {
  const [data, setData] = useState<Routines | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await loadRoutines());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const active = profiles.filter((profile) => profile.archivedAt === null);
  const bot = (id: string | null): string =>
    profiles.find((profile) => profile.id === id)?.name ?? "A removed bot";
  const remove = (action: () => Promise<unknown>) => async () => {
    await action();
    await load();
  };

  if (error !== null && data === null) {
    return <ErrorState message={`Couldn't load routines: ${error}`} onRetry={() => void load()} />;
  }
  if (data === null) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner /> Loading routines…
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {error !== null && <ErrorState message={error} onRetry={() => void load()} />}
      <Section
        title="Schedules"
        empty="No schedules yet. Ask a bot to remind you or to do something regularly."
      >
        {data.cron.map((job) => (
          <ScheduleRow
            key={job.id}
            job={job}
            bot={bot(job.profile)}
            onDelete={remove(() => api.removeCron(job.id))}
          />
        ))}
      </Section>
      <Section
        title="Webhooks"
        action={<CreateWebhook profiles={active} onCreated={load} />}
        empty="No webhooks yet. A webhook lets another app wake a bot."
      >
        {data.webhooks.map((hook) => (
          <WebhookRow
            key={hook.id}
            hook={hook}
            bot={bot(hook.profile)}
            onDelete={remove(() => api.removeWebhook(hook.id))}
          />
        ))}
      </Section>
      <Section
        title="Watching"
        empty="Nothing watched yet. Ask a bot to keep an eye on a calendar, a feed or a web page."
      >
        {data.sensors.map((sensor) => (
          <SensorRow
            key={sensor.id}
            sensor={sensor}
            bot={bot(sensor.profile)}
            onDelete={remove(() => api.removeSensor(sensor.id))}
          />
        ))}
      </Section>
      <Section
        title="Needs attention"
        empty="All good. Routines that keep failing or get switched off show up here."
      >
        {data.escalations.map((event, index) => (
          <EscalationRow key={`${event.at}-${index}`} event={event} bot={bot(event.profile)} />
        ))}
      </Section>
      <Section title="Recent activity" empty="Nothing has run yet.">
        {data.events.map((event) => (
          <EventRow key={event.id} event={event} />
        ))}
      </Section>
    </div>
  );
}

function EscalationRow({ event, bot }: { event: AuditEvent; bot: string }) {
  return (
    <li className="flex items-start gap-2 px-3 py-2 text-sm">
      <Mark kind="attention" tone="signal" label="Needs your attention" className="mt-1 size-3.5" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-signal break-words first-letter:uppercase">
          {event.error ?? "Something went wrong"}
        </span>
        <span className="text-muted-foreground text-xs">
          {[
            bot,
            event.name === null ? null : `wanted to ${describeTool(event.name).action}`,
            formatWhen(event.at),
          ]
            .filter((part) => part !== null)
            .join(" · ")}
        </span>
      </span>
    </li>
  );
}

function EventRow({ event }: { event: RoutineEvent }) {
  return (
    <li className="flex flex-wrap items-center gap-1.5 px-3 py-2 text-sm">
      <time
        className="text-muted-foreground shrink-0 text-xs whitespace-nowrap"
        title={formatFull(event.at)}
      >
        {formatWhen(event.at)}
      </time>
      <span>{SOURCE_LABEL[event.source] ?? event.source}</span>
      <Badge variant={STATUS_VARIANT[event.status] ?? "outline"}>
        {event.status.charAt(0).toUpperCase() + event.status.slice(1)}
      </Badge>
      {event.reason !== null && (
        <span className="text-muted-foreground min-w-0 text-xs break-words">{event.reason}</span>
      )}
    </li>
  );
}

/** A titled, bordered list; the empty text shows when it has no rows. */
function Section({
  title,
  action,
  empty,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <section className="flex flex-col gap-2">
      <SectionHeader title={title} action={action} />
      {children.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <ul className="divide-border/70 divide-y rounded-[14px] border">{children}</ul>
      )}
    </section>
  );
}
