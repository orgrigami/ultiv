/**
 * Tool calls as the transcript tells them: a human line while a call runs
 * and after it lands, the call's index in the run (the course overlay over
 * the prose terrain), bespoke bodies for the calls that have them, and raw
 * receipts one click away. Unknown tools keep the classic receipt view.
 */
import { memo, type ReactNode } from "react";
import {
  BrainIcon,
  CalendarClockIcon,
  FolderIcon,
  GlobeIcon,
  KeyRoundIcon,
  ListTodoIcon,
  MailIcon,
  PlugIcon,
  ScissorsIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldXIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import type { ToolStep } from "@ultiv/contracts";
import { FileCard } from "@/components/file-card";
import { ErrorNote, Receipts, ToolBody } from "@/components/tool-bodies";
import { Mark } from "@/components/state-mark";
import { useApp } from "@/lib/app-state";
import type { JevNotice } from "@/lib/jev-text";
import {
  DURATION_FLOOR_MS,
  errorTextOf,
  humanizeMs,
  presentationOf,
  type ToolFamily,
  type ToolView,
} from "@/lib/tool-text";
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";

const FAMILY_ICONS: Record<ToolFamily, ReactNode> = {
  memory: <BrainIcon />,
  social: <MailIcon />,
  web: <GlobeIcon />,
  task: <ListTodoIcon />,
  routine: <CalendarClockIcon />,
  artifact: <FolderIcon />,
  code: <TerminalIcon />,
  credentials: <KeyRoundIcon />,
  connectors: <PlugIcon />,
  generic: <WrenchIcon />,
};

/** The leading slot: the run's state first, the family as the quiet default. */
function LeadMark({ step, icon }: { step: ToolStep; icon: ReactNode }) {
  if (step.status === "running") {
    return <Mark kind="working" tone="live" />;
  }
  if (step.status === "error") {
    return <Mark kind="error" tone="signal" />;
  }
  return (
    <span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">{icon}</span>
  );
}

/** The line's state mark, index, title, detail and tabular duration. */
function Line({
  step,
  icon,
  index,
  title,
  detail,
}: {
  step: ToolStep;
  icon: ReactNode;
  index: number;
  title: string;
  detail?: string | undefined;
}) {
  const status = step.status === "running" || step.status === "error" ? step.status : undefined;
  const duration =
    step.durationMs !== null && step.durationMs >= DURATION_FLOOR_MS
      ? humanizeMs(step.durationMs)
      : null;
  return (
    <TraceLine {...(status !== undefined ? { status } : {})}>
      <LeadMark step={step} icon={icon} />
      <span className="readout text-muted-foreground/50 w-5 text-right select-none">
        {String(index).padStart(2, "0")}
      </span>
      <TraceTitle>{title}</TraceTitle>
      {detail !== undefined && (
        <span className="text-muted-foreground/70 min-w-0 truncate">{detail}</span>
      )}
      {duration !== null && <TraceDescription>{duration}</TraceDescription>}
    </TraceLine>
  );
}

/** A Memory-panel search fragment: flat, whole words, clean punctuation. */
const clipFor = (text: string): string | undefined => {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return undefined;
  const clipped = flat.length > 40 ? flat.slice(0, 40) : flat;
  const whole = clipped.lastIndexOf(" ");
  const clean = (whole > 12 ? clipped.slice(0, whole) : clipped).replace(/[,.;:!?…]+$/, "").trim();
  return clean === "" ? undefined : clean;
};

/** The quoted body of a social call: the memory kept, the mail sent. */
function Body({
  view,
  onOpenMemory,
}: {
  view: ToolView;
  onOpenMemory?: ((query: string) => void) | undefined;
}) {
  const fragment = view.lookup !== undefined ? clipFor(view.lookup) : undefined;
  return (
    <div className="mt-1 mb-1 ml-[3.75rem] max-w-prose">
      <p className="border-border text-muted-foreground border-l pl-3 text-sm leading-relaxed italic">
        {view.body}
      </p>
      <div className="text-muted-foreground/80 mt-1 flex flex-wrap items-center gap-x-2 pl-3 text-xs">
        {view.tags?.map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
        {view.lookup !== undefined && onOpenMemory !== undefined && fragment !== undefined && (
          <button
            type="button"
            onClick={() => onOpenMemory(fragment)}
            className="hover:text-foreground inline-flex cursor-pointer items-center gap-0.5 underline-offset-2 hover:underline"
          >
            Open in Memory
          </button>
        )}
      </div>
    </div>
  );
}

/** A recalled list (facts, a room transcript) as plain rows, not JSON. */
function Lines({ lines }: { lines: readonly string[] }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static rendered rows
        <li key={index} className="text-sm break-words whitespace-pre-wrap">
          {line}
        </li>
      ))}
    </ul>
  );
}

/** One tool call. `notice` is Jev's gate decision for this exact call. */
export const ToolTrace = memo(function ToolTrace({
  step,
  index = 1,
  onOpenMemory,
  notice,
}: {
  step: ToolStep;
  index?: number | undefined;
  onOpenMemory?: ((query: string) => void) | undefined;
  notice?: JevNotice | undefined;
}) {
  const { sessions } = useApp();
  const presentation = presentationOf(
    step,
    (id) => sessions.profiles.find((bot) => bot.id === id)?.name,
  );
  if (presentation.kind === "hidden") {
    return notice === undefined ? null : <JevLine notice={notice} />;
  }
  const human = presentation.kind === "human" ? presentation.view : undefined;
  const title =
    human === undefined ? step.name : step.status === "running" ? human.live : human.done;
  const error = errorTextOf(step);
  const body =
    human === undefined
      ? undefined
      : human.structured !== undefined && human.structured.t !== "json"
        ? "structured"
        : human.lines !== undefined
          ? "lines"
          : undefined;
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <Line
          step={step}
          icon={human === undefined ? <WrenchIcon /> : FAMILY_ICONS[human.family]}
          index={index}
          title={title}
          detail={human?.detail}
        />
      </TraceCollapsibleTrigger>
      {human?.body !== undefined && <Body view={human} onOpenMemory={onOpenMemory} />}
      {human?.artifact !== undefined && (
        <FileCard file={human.artifact} className="mt-1 mb-1 ml-[3.75rem] max-w-prose" />
      )}
      <TraceCollapsibleContent>
        <div className="flex flex-col gap-2">
          {error !== undefined && <ErrorNote message={error} />}
          {body === "structured" && human?.structured !== undefined && (
            <ToolBody data={human.structured} />
          )}
          {body === "lines" && <Lines lines={human?.lines ?? []} />}
          {body === undefined && (
            <Receipts
              input={JSON.stringify(step.input, null, 2)}
              {...(step.output !== null && step.output !== "" ? { output: step.output } : {})}
            />
          )}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
});

/** A run of tool calls; long runs fold their exploration, keep their tail. */
const GROUP_MAX = 8;
const GROUP_TAIL = 3;

export function ToolGroup({
  tools,
  onOpenMemory,
  jevNotices,
}: {
  tools: readonly ToolStep[];
  onOpenMemory?: ((query: string) => void) | undefined;
  jevNotices?: ReadonlyMap<string, JevNotice> | undefined;
}) {
  const render = (step: ToolStep, index: number) => (
    <ToolTrace
      key={step.callId}
      step={step}
      index={index}
      onOpenMemory={onOpenMemory}
      notice={jevNotices?.get(step.callId)}
    />
  );
  if (tools.length <= GROUP_MAX) {
    return <>{tools.map((step, index) => render(step, index + 1))}</>;
  }
  const head = tools.slice(0, tools.length - GROUP_TAIL);
  const tail = tools.slice(-GROUP_TAIL);
  return (
    <>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceTitle className="readout">Show {head.length} earlier steps</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          {head.map((step, index) => render(step, index + 1))}
        </TraceCollapsibleContent>
      </TraceCollapsible>
      {tail.map((step, index) => render(step, head.length + index + 1))}
    </>
  );
}

const JEV_ICONS: Record<JevNotice["kind"], ReactNode> = {
  approved: <ShieldCheckIcon className="mt-0.5 size-3 shrink-0" aria-hidden />,
  denied: <ShieldXIcon className="text-destructive mt-0.5 size-3 shrink-0" aria-hidden />,
  split: <ScissorsIcon className="mt-0.5 size-3 shrink-0" aria-hidden />,
  destructive: <ShieldAlertIcon className="text-destructive mt-0.5 size-3 shrink-0" aria-hidden />,
};

/** Jev answered this call's gate on its own: say so, with its reason. */
export function JevLine({ notice }: { notice: JevNotice }) {
  return (
    <p className="text-muted-foreground -mt-1 flex items-start gap-1 px-1 text-xs break-words">
      {JEV_ICONS[notice.kind]}
      <span className="min-w-0">
        <span className="text-foreground/80 font-medium">{notice.title}</span>
        {notice.reason !== "" && <span> · {notice.reason}</span>}
      </span>
    </p>
  );
}
