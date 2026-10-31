/**
 * Tool calls as the transcript tells them: a human line while a call runs
 * and after it lands, the call's index in the run,
 * bespoke bodies for the calls that have them, and raw
 * receipts one click away. Every tool renders in owner words; a tool no lens
 * knows takes a humanized title and raw receipts as its body.
 */
import { memo, useState, type ReactNode } from "react";
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
  SparklesIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import type { ToolStep } from "@spriessen/contracts";
import { FileCard } from "@/components/file-card";
import { ErrorNote, FoldText, Receipts, ToolBody, TypedOutput } from "@/components/tool-bodies";
import { Mark } from "@/components/state-mark";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import { undoActionOf, undoStateOf, type LearnedRef } from "@/lib/learned";
import type { JevNotice } from "@/lib/jev-text";
import {
  DURATION_FLOOR_MS,
  errorTextOf,
  humanizeMs,
  outputBesidesError,
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
  skill: <SparklesIcon />,
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
      <TraceTitle className="max-w-[75%] shrink-0">{title}</TraceTitle>
      {detail !== undefined && (
        // The detail gives way first, so a narrow screen keeps the title whole.
        <span className="text-muted-foreground/70 min-w-0 shrink-[8] truncate">{detail}</span>
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

/** The quoted body of a social call: the memory kept, the mail sent. Long
 * letters fold instead of truncating. */
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
      <FoldText
        text={view.body ?? ""}
        className="border-border text-muted-foreground border-l pl-3 text-sm leading-relaxed italic [&>button]:ml-[-1px]"
      />
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

type UndoStep = "idle" | "busy" | "undone" | "changed" | "failed";

const UNDO_NOTES: Record<Exclude<UndoStep, "idle" | "busy">, string> = {
  undone: "Undone",
  changed: "Changed since; restore a version from the bot's Skills",
  failed: "Couldn't undo; try the bot's Skills",
};

/** One-tap undo for a skill the bot learned on its own: only while it's still current. */
function LearnedUndo({ learned }: { learned: LearnedRef }) {
  const [step, setStep] = useState<UndoStep>("idle");
  const undo = async (): Promise<void> => {
    setStep("busy");
    try {
      const history = await api.skillVersions(learned.profile, learned.skill);
      const state = undoStateOf(history, learned.version);
      if (state === "undo") {
        await (undoActionOf(history, learned.version) === "remove"
          ? api.skillRemove(learned.profile, learned.skill)
          : api.skillRevert(learned.profile, learned.skill));
      }
      setStep(state === "undo" ? "undone" : state);
    } catch {
      setStep("failed");
    }
  };
  return (
    <div className="text-muted-foreground/80 mb-1 ml-[3.75rem] pl-3 text-xs">
      {step === "idle" || step === "busy" ? (
        <button
          type="button"
          disabled={step === "busy"}
          onClick={() => void undo()}
          className="hover:text-foreground inline-flex min-h-6 cursor-pointer items-center underline-offset-2 hover:underline disabled:cursor-default disabled:opacity-60"
        >
          {step === "busy" ? "Undoing…" : "Undo"}
        </button>
      ) : (
        <span role="status">{UNDO_NOTES[step]}</span>
      )}
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
  const human = presentation.view;
  const title = step.status === "running" ? human.live : human.done;
  const error = errorTextOf(step);
  // The output minus the error line above it: one sentence never shows twice.
  const output = outputBesidesError(step);
  const body =
    human.structured !== undefined && human.structured.t !== "json"
      ? "structured"
      : human.lines !== undefined
        ? "lines"
        : undefined;
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <Line
          step={step}
          icon={FAMILY_ICONS[human.family]}
          index={index}
          title={title}
          detail={human.detail}
        />
      </TraceCollapsibleTrigger>
      {human?.body !== undefined && <Body view={human} onOpenMemory={onOpenMemory} />}
      {human?.learned !== undefined && <LearnedUndo learned={human.learned} />}
      {human?.artifact !== undefined && (
        <FileCard file={human.artifact} className="mt-1 mb-1 ml-[3.75rem] max-w-prose" />
      )}
      <TraceCollapsibleContent>
        <div className="flex flex-col gap-2">
          {error !== undefined && <ErrorNote message={error} />}
          {body === "structured" && human?.structured !== undefined && (
            <ToolBody data={human.structured} />
          )}
          {human?.structured?.t === "record" && output !== undefined && (
            <TypedOutput output={output} />
          )}
          {body === "lines" && <Lines lines={human?.lines ?? []} />}
          {body === undefined && (
            <Receipts input={step.input} {...(output !== undefined ? { output } : {})} />
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
