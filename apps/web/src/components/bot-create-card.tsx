/**
 * The `bot_create` confirmation card, inline in the chat: the proposal as a
 * small editable form. Name, title, personality, model + effort, and the
 * sandbox toggle. Creating sends the corrected input back through the
 * approval's override channel; denying (or letting it expire) tells the bot
 * nothing was created.
 */
import { useState } from "react";
import type { ModelInfo } from "@ultiv/contracts";
import type { DecideOutcome } from "@/components/approval-card";
import { ModelFields } from "@/components/bot-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** The form state: one editable field per tool arg. */
export interface BotProposal {
  name: string;
  title: string;
  persona: string;
  modelId: string;
  effort: string;
  sandbox: boolean;
}

/** Reads the tool's proposed input tolerantly (any field may be missing). */
export const proposalOf = (input: unknown): BotProposal => {
  const record =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const text = (key: string): string => (typeof record[key] === "string" ? record[key] : "");
  const sandbox = record["sandbox"];
  return {
    name: text("name"),
    title: text("title"),
    persona: text("persona"),
    modelId: text("model"),
    effort: text("effort"),
    sandbox: sandbox !== false,
  };
};

/** One labeled text field (input or textarea). */
function TextField({
  label,
  value,
  onChange,
  placeholder,
  rows,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  rows?: number | undefined;
}) {
  const body =
    rows === undefined ? (
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    ) : (
      <Textarea
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    );
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      {body}
    </label>
  );
}

/** The sandbox row: one checkbox with its meaning spelled out. */
function SandboxField({
  sandbox,
  onSandbox,
}: {
  sandbox: boolean;
  onSandbox: (sandbox: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label className="flex items-center gap-2">
        <Checkbox checked={sandbox} onCheckedChange={(checked) => onSandbox(checked)} />
        Own sandbox (bash in a microVM)
      </label>
      <span className="text-muted-foreground text-xs">
        {sandbox
          ? "The bot gets a sandboxed bash over its own workspace files."
          : "No bash for this bot; its files stay artifacts only."}
      </span>
    </div>
  );
}

/** The deny/create buttons and the owner-facing helper line. */
function CreateActions({
  deciding,
  named,
  onDeny,
  onCreate,
}: {
  deciding: "deny" | "create" | null;
  named: boolean;
  onDeny: () => void;
  onCreate: () => void;
}) {
  return (
    <>
      <p className="text-muted-foreground text-xs">
        The new bot starts asking you to approve its actions, whatever this bot's own mode is.
      </p>
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="outline" disabled={deciding !== null} onClick={onDeny}>
          Deny
        </Button>
        <span title={named ? undefined : "Give the bot a name first"}>
          <Button size="sm" disabled={deciding !== null || !named} onClick={onCreate}>
            {deciding === "create" ? "Creating…" : deciding === "deny" ? "Sending…" : "Create bot"}
          </Button>
        </span>
      </div>
    </>
  );
}

/** The card's fields, one per tool arg: name, title, personality, model/effort, sandbox. */
function ProposalFields({
  proposal,
  setProposal,
  models,
}: {
  proposal: BotProposal;
  setProposal: (proposal: BotProposal) => void;
  models: ModelInfo[];
}) {
  return (
    <>
      <TextField
        label="Name"
        value={proposal.name}
        onChange={(name) => setProposal({ ...proposal, name })}
        placeholder="Robinson"
      />
      <TextField
        label="Title / role"
        value={proposal.title}
        onChange={(title) => setProposal({ ...proposal, title })}
        placeholder="Research assistant for the workspace"
      />
      <TextField
        label="Personality"
        rows={3}
        value={proposal.persona}
        onChange={(persona) => setProposal({ ...proposal, persona })}
        placeholder={"You are meticulous. You check rather than guess…"}
      />
      <ModelFields
        modelId={proposal.modelId}
        effort={proposal.effort}
        onModel={(modelId) => setProposal({ ...proposal, modelId, effort: "" })}
        onEffort={(effort) => setProposal({ ...proposal, effort })}
        models={models}
      />
      <SandboxField
        sandbox={proposal.sandbox}
        onSandbox={(sandbox) => setProposal({ ...proposal, sandbox })}
      />
    </>
  );
}

/**
 * The editable confirmation card: the proposal as a form. An approval sends
 * the WHOLE corrected input back (the override replaces the tool's arguments
 * wholesale), so what the owner confirmed is exactly what gets created.
 */
export function BotCreateCard(props: {
  input: unknown;
  /** Why the owner is being asked (the bot's own one-liner), if it landed. */
  reason?: string | null | undefined;
  who?: string | undefined;
  models: ModelInfo[];
  onDecide: (
    approved: boolean,
    always?: boolean,
    takeover?: boolean,
    input?: unknown,
  ) => Promise<DecideOutcome | void>;
}) {
  const [proposal, setProposal] = useState(() => proposalOf(props.input));
  const [deciding, setDeciding] = useState<"deny" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (approved: boolean): Promise<void> => {
    setDeciding(approved ? "create" : "deny");
    setError(null);
    try {
      await props.onDecide(
        true,
        undefined,
        undefined,
        approved
          ? {
              name: proposal.name.trim(),
              title: proposal.title.trim(),
              persona: proposal.persona,
              model: proposal.modelId,
              effort: proposal.effort,
              sandbox: proposal.sandbox,
            }
          : undefined,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeciding(null);
    }
  };
  const named = proposal.name.trim() !== "";
  return (
    <div
      role="group"
      aria-label="Bot proposal"
      className="bg-card flex w-full flex-col gap-3 rounded-xl border border-ring/60 p-3"
    >
      <p className="text-sm font-medium">
        {props.who ?? "Your bot"} wants to create a bot
        {proposal.name !== "" && (
          <span className="text-muted-foreground font-normal">: {proposal.name}</span>
        )}
      </p>
      {props.reason && (
        <p className="text-muted-foreground border-l-2 border-border pl-2 text-xs italic">
          {props.reason}
        </p>
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (named) void submit(true);
        }}
      >
        <ProposalFields proposal={proposal} setProposal={setProposal} models={props.models} />
        {error !== null && (
          <p className="text-destructive text-xs" role="alert">
            Decision not sent: {error}. Try again.
          </p>
        )}
        <CreateActions
          deciding={deciding}
          named={named}
          onDeny={() => void submit(false)}
          onCreate={() => void submit(true)}
        />
      </form>
    </div>
  );
}
