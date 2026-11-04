/**
 * The one approval card: a tool call waiting on the owner, shown inline in the
 * chat (and in a background task's activity). A plain one-line summary, the
 * risk as icon + words, the raw input behind "Details", and Deny / Approve as
 * the main choices; "Always allow" and "Take over" sit in the overflow menu.
 * Buttons lock while a decision is in flight; a failed one can be retried.
 */
import { Menu } from "@base-ui/react/menu";
import { ChevronRightIcon, EllipsisIcon, ShieldAlertIcon, ShieldCheckIcon } from "lucide-react";
import { useState } from "react";
import type { ModelInfo } from "@spriessen/contracts";
import { BotCreateCard } from "@/components/bot-create-card";
import { InputRecord } from "@/components/tool-receipts";
import { DevDetails } from "@/components/ui/dev-details";
import { Mark } from "@/components/state-mark";
import { Button } from "@/components/ui/button";
import { MenuPopup } from "@/components/ui/menu-popup";
import {
  MenuSheetBackdrop,
  SheetHeading,
  sheetHint,
  sheetPositioner,
  sheetRowStacked,
} from "@/components/ui/menu-sheet";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import { ChangeDetails, connectorChangeOf } from "@/components/connectors/change-details";
import { QuestionCard } from "@/components/question-card";
import { SecretCard, secretAskOf } from "@/components/secure/secret-card";
import { alwaysAllowText, canAlwaysAllow, describeTool, hintOf } from "@/lib/approval-text";
import { ASK_USER_QUESTION, questionOf } from "@/lib/question";
import { cn } from "@/lib/utils";
import { Tile } from "@/components/ui/tile";

export interface DecideOutcome {
  /** The autoApprove entries "always allow" stored; 0 = the call stays gated by its pattern. */
  stored?: number | null;
}

export type Decide = (
  callId: string,
  approved: boolean,
  always?: boolean,
  takeover?: boolean,
  input?: unknown,
) => Promise<DecideOutcome | void>;

export function ApprovalCard(props: {
  /** The tool's name. */
  name: string;
  input: unknown;
  /** Why the owner is being asked (Jev's read, or the bot's own one-liner). */
  reason?: string | null | undefined;
  who?: string | undefined;
  /** The waiting call; secure inputs post to it directly. */
  callId?: string | undefined;
  /** Model catalog for editable cards (the bot_create form's dropdowns). */
  models?: ModelInfo[] | undefined;
  onDecide: (
    approved: boolean,
    always?: boolean,
    takeover?: boolean,
    input?: unknown,
  ) => Promise<DecideOutcome | void>;
}) {
  const ask = props.name === "secret_request" ? secretAskOf(props.input) : null;
  if (ask !== null && props.callId !== undefined)
    return <SecretCard key={props.callId} callId={props.callId} who={props.who} ask={ask} />;
  const question = props.name === ASK_USER_QUESTION ? questionOf(props.input) : null;
  if (question !== null)
    return (
      <QuestionCard key={props.callId} ask={question} who={props.who} onDecide={props.onDecide} />
    );
  if (props.name === "bot_create" && props.callId !== undefined)
    return (
      <BotCreateCard
        key={props.callId}
        input={props.input}
        reason={props.reason}
        who={props.who}
        models={props.models ?? []}
        onDecide={props.onDecide}
      />
    );
  return <DecisionCard {...props} />;
}

function DecisionCard({
  name,
  input,
  reason,
  who,
  onDecide,
}: {
  name: string;
  input: unknown;
  reason?: string | null | undefined;
  /** Who is asking ("Eve"); defaults to "Your bot". */
  who?: string | undefined;
  onDecide: (
    approved: boolean,
    always?: boolean,
    takeover?: boolean,
  ) => Promise<DecideOutcome | void>;
}) {
  const [deciding, setDeciding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  // What "Always allow" actually did: 0 stored = the call stays gated by its
  // pattern, and the owner is told instead of the click vanishing.
  const [alwaysNote, setAlwaysNote] = useState<string | null>(null);
  const change = connectorChangeOf(input);
  const described = describeTool(name);
  const { action, risk } = described;
  const risky = described.risky || change?.runsOnMac === true;
  const hint = change !== null ? change.server : hintOf(input);
  const RiskIcon = risky ? ShieldAlertIcon : ShieldCheckIcon;

  const decide = async (label: string, run: () => Promise<DecideOutcome | void>): Promise<void> => {
    setDeciding(label);
    setError(null);
    try {
      const outcome = await run();
      setAlwaysNote(
        outcome?.stored === 0 ? "This call can't be granted narrowly, so it will ask again." : null,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeciding(null);
    }
  };
  const busy = deciding !== null;
  const label = (key: string, text: string): string => (deciding === key ? "Sending…" : text);
  const item = sheetRowStacked;

  return (
    <Tile
      role="group"
      aria-label="Approval needed"
      className={cn(
        "flex w-full flex-col gap-2 p-3",
        risky ? "border-destructive/60" : "border-ring/50",
      )}
    >
      <p className="flex items-start gap-2 text-sm font-medium">
        <Mark
          kind="attention"
          tone={risky ? "signal" : "live"}
          label="Waiting for your approval"
          className="mt-0.5 size-3.5"
        />
        <span className="min-w-0">
          {who ?? "Your bot"} wants to {action}
          {hint !== null && <span className="text-muted-foreground font-normal">: {hint}</span>}
        </span>
      </p>
      <p
        className={cn(
          "flex items-center gap-1.5 text-xs",
          risky ? "text-destructive" : "text-muted-foreground",
        )}
      >
        <RiskIcon className="size-3.5 shrink-0" aria-hidden />
        {risk}
      </p>
      {reason !== null && reason !== undefined && reason !== "" && (
        <p className="text-muted-foreground border-border border-l pl-2 text-xs">{reason}</p>
      )}
      {change !== null && <ChangeDetails change={change} />}
      <Button
        variant="quiet"
        size="xs"
        className="w-fit"
        aria-expanded={details}
        onClick={() => setDetails((open) => !open)}
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform", details && "rotate-90")} />
        Details
      </Button>
      {details && (
        <div className="flex flex-col gap-2">
          <p className="section-label">{name}</p>
          <InputRecord input={input} />
          <DevDetails className="-ml-1">
            <CodeBlock size="sm">
              <CodeBlockContent wrap className="max-h-48 overflow-y-auto">
                {JSON.stringify(input, null, 2)}
              </CodeBlockContent>
            </CodeBlock>
          </DevDetails>
        </div>
      )}
      {error !== null && (
        <p className="text-destructive text-xs" role="alert">
          Decision not sent: {error}. Try again.
        </p>
      )}
      {alwaysNote !== null && (
        <p className="text-muted-foreground text-xs" role="status">
          {alwaysNote}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button size="icon-sm" variant="ghost" disabled={busy} aria-label="More choices" />
            }
          >
            <EllipsisIcon />
          </Menu.Trigger>
          <Menu.Portal>
            <MenuSheetBackdrop />
            <Menu.Positioner side="top" align="end" sideOffset={6} {...sheetPositioner}>
              <MenuPopup className="w-72">
                <SheetHeading>More choices</SheetHeading>
                {canAlwaysAllow(name) && (
                  <Menu.Item
                    className={item}
                    onClick={() => void decide("always", () => onDecide(true, true))}
                  >
                    {alwaysAllowText(name, input).title}
                    <span className={sheetHint}>{alwaysAllowText(name, input).detail}</span>
                  </Menu.Item>
                )}
                <Menu.Item
                  className={item}
                  onClick={() => void decide("takeover", () => onDecide(false, undefined, true))}
                >
                  Take over
                  <span className={sheetHint}>Decline and tell the bot you'll do it yourself.</span>
                </Menu.Item>
              </MenuPopup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void decide("deny", () => onDecide(false))}
        >
          {label("deny", "Deny")}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => void decide("approve", () => onDecide(true))}
        >
          {label(
            "approve",
            deciding === "always" || deciding === "takeover" ? "Sending…" : "Approve",
          )}
        </Button>
      </div>
    </Tile>
  );
}
