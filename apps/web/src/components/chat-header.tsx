/**
 * The slim chat bar: a round back button, the bot as a centred avatar+name
 * pill that switches bots at every width with the approval-mode chip beside
 * it, and a round "…" that opens the
 * session details (new chat, past chats, model, effort, spend, connection).
 * Details live in the popover so the messages get the room.
 */
import { Popover } from "@base-ui/react/popover";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon, EllipsisIcon, HistoryIcon, SquarePenIcon } from "lucide-react";
import type { ModelInfo, ProfileApprovalMode, ThinkingLevel, UsageSummary } from "@ultiv/contracts";
import { linkLabel, type ChatBot, type LinkState } from "@/components/bot-avatar";
import { Mark } from "@/components/state-mark";
import { ApprovalModeChip } from "@/components/approval-mode-control";
import { BotSwitcher } from "@/components/bot-switcher";
import { ModelOptions } from "@/components/model-options";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useApp } from "@/lib/app-state";

export { BotAvatar, type ChatBot, type LinkState } from "@/components/bot-avatar";

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const actionRow =
  "hover:bg-muted focus-visible:ring-ring/50 flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 text-left text-sm outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:text-muted-foreground [&_svg]:size-4";

/** New chat with this bot and the way to past chats (out of the main nav). */
function ChatActions({ botId }: { botId: string | undefined }) {
  const { sessions } = useApp();
  const navigate = useNavigate();
  const ready = sessions.phase === "live" && sessions.profiles.length > 0;
  const create = async (): Promise<void> => {
    const created = await sessions.create(null, botId);
    if (created !== undefined) {
      void navigate({ to: "/c/$sessionId", params: { sessionId: created.id } });
    }
  };
  return (
    <div className="-mx-1.5 -mt-1.5 flex flex-col border-b pb-1.5">
      <Popover.Close
        className={actionRow}
        disabled={!ready}
        title={ready ? undefined : "Waiting for the server"}
        onClick={() => void create()}
      >
        <SquarePenIcon /> New chat
      </Popover.Close>
      <Popover.Close className={actionRow} onClick={() => void navigate({ to: "/history" })}>
        <HistoryIcon /> Past chats
      </Popover.Close>
    </div>
  );
}

/** Model, effort, this session's spend and the link state. */
function SessionDetails({
  link,
  usage,
  model,
  effort,
  models,
  onConfigure,
}: {
  link: LinkState;
  usage: UsageSummary | null;
  model: string | null;
  effort: ThinkingLevel | null;
  models: ModelInfo[];
  onConfigure: (model: string | null, effort: ThinkingLevel | null) => void;
}) {
  const selected = models.find((candidate) => candidate.id === model);
  const efforts = selected?.efforts ?? (["off", "low", "high", "max"] as const);
  return (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="section-label">Model</span>
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
        <span className="section-label">Effort</span>
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
      {usage !== null && (
        <p className="readout text-muted-foreground flex items-center justify-between gap-3">
          <span>{formatTokens(usage.totalTokens)} tokens</span>
          <span>
            {formatTokens(usage.input)} in · {formatTokens(usage.output)} out
          </span>
        </p>
      )}
      <p className="text-muted-foreground readout flex items-center gap-1.5">
        <Mark
          kind={link === "live" ? "done" : link === "lost" ? "error" : "pending"}
          tone={link === "live" ? "ok" : link === "lost" ? "signal" : "muted"}
          className="size-2.5"
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
      <div className="flex min-w-0 items-center justify-center gap-1.5">
        <BotSwitcher name={name} currentId={bot?.id} onMemory={onMemory} />
        {bot !== undefined && (
          <ApprovalModeChip
            botName={name}
            mode={approvalMode}
            onChange={async (next) => {
              onApprovalMode(next);
            }}
          />
        )}
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
            <Popover.Popup className="bg-popover text-popover-foreground flex w-72 max-w-[calc(100vw-1.5rem)] flex-col gap-3 rounded-xl border p-4 shadow-lg outline-none">
              <ChatActions botId={bot?.id} />
              <SessionDetails
                link={link}
                usage={usage}
                model={model}
                effort={effort}
                models={models}
                onConfigure={onConfigure}
              />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </header>
  );
}
