/**
 * The slim chat bar: a round back button, the bot as a centred avatar+name
 * pill that switches bots, and a round "…" that opens the session details
 * (model, effort, spend, connection). Details live in the popover so the
 * messages get the room.
 */
import { Popover } from "@base-ui/react/popover";
import { ChevronLeftIcon, EllipsisIcon } from "lucide-react";
import type { ModelInfo, ProfileApprovalMode, ThinkingLevel, UsageSummary } from "@ultiv/contracts";
import { linkLabel, type ChatBot, type LinkState } from "@/components/bot-avatar";
import { APPROVAL_MODE_OPTIONS } from "@/components/bot-dialog";
import { BotSwitcher } from "@/components/bot-switcher";
import { ModelOptions } from "@/components/model-options";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

export { BotAvatar, type ChatBot, type LinkState } from "@/components/bot-avatar";

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Model, effort, approvals, this session's spend and the link state. */
function SessionDetails({
  link,
  usage,
  model,
  effort,
  models,
  approvalMode,
  onConfigure,
  onApprovalMode,
}: {
  link: LinkState;
  usage: UsageSummary | null;
  model: string | null;
  effort: ThinkingLevel | null;
  models: ModelInfo[];
  approvalMode: ProfileApprovalMode;
  onConfigure: (model: string | null, effort: ThinkingLevel | null) => void;
  onApprovalMode: (mode: ProfileApprovalMode) => void;
}) {
  const selected = models.find((candidate) => candidate.id === model);
  const efforts = selected?.efforts ?? (["off", "low", "high", "max"] as const);
  return (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">Model</span>
        <Select
          className="w-full"
          value={model ?? ""}
          onChange={(event) =>
            onConfigure(event.target.value === "" ? null : event.target.value, null)
          }
        >
          <option value="">Default model</option>
          <ModelOptions models={models} />
        </Select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">Effort</span>
        <Select
          className="w-full"
          value={effort ?? ""}
          onChange={(event) =>
            onConfigure(
              model,
              event.target.value === "" ? null : (event.target.value as ThinkingLevel),
            )
          }
        >
          <option value="">Default effort</option>
          {efforts.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">Approvals</span>
        <Select
          className="w-full"
          value={approvalMode}
          onChange={(event) => onApprovalMode(event.target.value as ProfileApprovalMode)}
        >
          {APPROVAL_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </label>
      {usage !== null && (
        <p className="text-muted-foreground text-xs">
          {formatTokens(usage.totalTokens)} tokens · {formatTokens(usage.input)} in ·{" "}
          {formatTokens(usage.output)} out
        </p>
      )}
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <span
          className={`size-2 rounded-full ${link === "live" ? "bg-emerald-500" : link === "lost" ? "bg-destructive" : "bg-muted-foreground"}`}
        />
        {linkLabel[link]}
      </p>
    </div>
  );
}

export function ChatHeader({
  bot,
  link,
  onBack,
  usage,
  model,
  effort,
  models,
  approvalMode,
  onConfigure,
  onApprovalMode,
  onMemory,
}: {
  bot?: ChatBot | undefined;
  link: LinkState;
  onBack?: (() => void) | undefined;
  usage: UsageSummary | null;
  model: string | null;
  effort: ThinkingLevel | null;
  models: ModelInfo[];
  approvalMode: ProfileApprovalMode;
  onConfigure: (model: string | null, effort: ThinkingLevel | null) => void;
  onApprovalMode: (mode: ProfileApprovalMode) => void;
  /** Opens this chat's bot Memory panel (absent when there is no bot). */
  onMemory?: (() => void) | undefined;
}) {
  const name = bot?.name !== undefined && bot.name !== "" ? bot.name : "Chat";
  // Floating chips: translucent + blurred so the transcript shows through.
  const round =
    "bg-background/60 hover:bg-muted/80 border-border/60 rounded-full border shadow-sm backdrop-blur-md pointer-coarse:size-11";
  return (
    // Only the chips take taps; the rest of the row lets the transcript scroll.
    <header className="pointer-events-none grid grid-cols-[2.5rem_1fr_2.5rem] items-center pointer-coarse:grid-cols-[2.75rem_1fr_2.75rem] gap-2 [&_button]:pointer-events-auto">
      {onBack !== undefined ? (
        <Button variant="ghost" size="icon-lg" className={round} aria-label="Back" onClick={onBack}>
          <ChevronLeftIcon />
        </Button>
      ) : (
        <span />
      )}
      <div className="flex min-w-0 justify-center">
        <BotSwitcher name={name} currentId={bot?.id} link={link} onMemory={onMemory} />
      </div>
      <Popover.Root>
        <Popover.Trigger
          render={
            <Button variant="ghost" size="icon-lg" className={round} aria-label="Chat details">
              <EllipsisIcon />
            </Button>
          }
        />
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
            <Popover.Popup className="bg-popover text-popover-foreground w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border p-4 shadow-lg outline-none">
              <SessionDetails
                link={link}
                usage={usage}
                model={model}
                effort={effort}
                models={models}
                approvalMode={approvalMode}
                onConfigure={onConfigure}
                onApprovalMode={onApprovalMode}
              />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </header>
  );
}
