/**
 * The bot form: name, role, personality and model, used to create a bot (from
 * the Bots page or the switcher) and to edit one. On phones the selects stack
 * and Save spans the sheet.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { ModelInfo, ProfileApprovalMode, ProfileInfo } from "@spriessen/contracts";
import { deadlineValue, formProblem } from "@/lib/deadline-fields";
import { BotLimits } from "@/components/bot-limits";
import { useTaskDefault } from "@/lib/task-settings";

import {
  APPROVAL_MODE_HELP,
  APPROVAL_MODE_OPTIONS,
  AllowlistField,
  AutoApproveField,
  ModelFields,
} from "@/components/bot-fields";
import { BackgroundModelField } from "@/components/background-model-field";

export interface BotForm {
  name: string;
  description: string;
  persona: string;
  /** "" = workspace default model. */
  modelId: string;
  effort: string;
  /** Who answers the bot's gated tool calls. */
  approvalMode: ProfileApprovalMode;
  /** Whether the bot gets the sandboxed bash tool. */
  sandbox: boolean;
  /** Turn deadlines (edit only): "" = the default (60 s / 15 min). */
  firstTokenSec?: string;
  turnMin?: string;
  /** Tasks at once (edit only): "" = the workspace default. */
  taskLimit?: string;
}

export const emptyForm: BotForm = {
  name: "",
  description: "",
  persona: "",
  modelId: "",
  effort: "",
  approvalMode: "manual",
  sandbox: true,
};

/** Save (full width on phones) and what saving changes. */
function SaveRow({ busy, unnamed }: { busy: boolean; unnamed: boolean }) {
  return (
    <>
      <div className="flex justify-end gap-2">
        {/* Disabled buttons swallow hover, so the reason sits on a wrapper. */}
        <span
          className="w-full sm:w-auto"
          title={unnamed ? "Give the bot a name first" : undefined}
        >
          <Button type="submit" className="w-full sm:w-auto" disabled={busy || unnamed}>
            {busy ? "Working…" : "Save"}
          </Button>
        </span>
      </div>
      <p className="text-muted-foreground text-xs">
        A new bot introduces itself in its main chat. Changes to the role, personality and model
        apply to all of this bot's chats from the next message.
      </p>
    </>
  );
}

export function BotDialog({
  title,
  initial,
  models,
  confirm,
  /** Edit-only fields (e.g. the always-allowed tool list); rendered before Save. */
  extra,
  children,
  open: controlledOpen,
  onOpenChange,
}: {
  title: string;
  initial: BotForm;
  models: ModelInfo[];
  confirm: (form: BotForm) => Promise<void>;
  extra?: React.ReactNode | undefined;
  /** The trigger; omit it and drive `open` instead. */
  children?: React.ReactElement | undefined;
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}) {
  const [form, setForm] = useState<BotForm>(initial);
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (next: boolean): void => {
    setOwnOpen(next);
    onOpenChange?.(next);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskDefault = useTaskDefault(open && form.firstTokenSec !== undefined);
  const submit = async (): Promise<void> => {
    if (form.name.trim() === "") return;
    // Bad deadlines are shown next to their field; nothing is sent.
    if (formProblem(form) !== null) return;
    setBusy(true);
    setError(null);
    try {
      await confirm(form);
      setOpen(false);
    } catch (cause) {
      // Stay open — the error must be readable against the draft.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setError(null);
      }}
    >
      {children !== undefined && <DialogTrigger render={children} />}
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            Name
            <Input
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Robinson"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Role / description
            <Input
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="Research assistant for the workspace"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Personality and instructions
            <Textarea
              rows={6}
              value={form.persona}
              onChange={(event) => setForm({ ...form, persona: event.target.value })}
              placeholder={"You are meticulous. You check rather than guess…"}
            />
          </label>
          <ModelFields
            modelId={form.modelId}
            effort={form.effort}
            onModel={(modelId) => setForm({ ...form, modelId, effort: "" })}
            onEffort={(effort) => setForm({ ...form, effort })}
            models={models}
          />
          <label className="flex flex-col gap-1 text-sm">
            Approval mode
            <Select
              className="w-full"
              value={form.approvalMode}
              onChange={(event) =>
                setForm({ ...form, approvalMode: event.target.value as ProfileApprovalMode })
              }
            >
              {APPROVAL_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <span className="text-muted-foreground text-xs">
              {APPROVAL_MODE_HELP[form.approvalMode]}
            </span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Sandbox (bash)
            <Select
              className="w-full"
              value={form.sandbox ? "on" : "off"}
              onChange={(event) => setForm({ ...form, sandbox: event.target.value === "on" })}
            >
              <option value="on">On — sandboxed bash</option>
              <option value="off">Off — no bash tool</option>
            </Select>
            <span className="text-muted-foreground text-xs">
              {form.sandbox
                ? "The bash tool runs in this bot's home's VM — the org VM for an org bot, its team's VM otherwise — as its own Linux user; its workspace files are artifacts."
                : "No bash tool for this bot — none of its targets (VM, host, node), so no shell at all."}
            </span>
          </label>
          {form.firstTokenSec !== undefined && (
            <BotLimits
              form={form}
              taskDefault={taskDefault}
              onChange={(limits) => setForm({ ...form, ...limits })}
            />
          )}
          {extra}
          {error !== null && <p className="text-destructive text-sm">{error}</p>}
          <SaveRow busy={busy} unnamed={form.name.trim() === ""} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Create a bot from the form (in a team, or the org); resolves to its id. */
export const createBot = async (form: BotForm, teamId?: string | null): Promise<string> =>
  (
    await api.createProfile({
      name: form.name.trim(),
      ...(teamId ? { teamId } : {}),
      ...(form.description !== "" ? { description: form.description } : {}),
      ...(form.persona !== "" ? { persona: form.persona } : {}),
      ...modelPayload(form),
      // The defaults need no key; a delegated mode and sandbox-off ride the per-key merge.
      ...(form.approvalMode !== "manual" || form.sandbox === false
        ? {
            policies: {
              ...(form.approvalMode !== "manual" ? { approvalMode: form.approvalMode } : {}),
              ...(form.sandbox === false ? { sandbox: false } : {}),
            },
          }
        : {}),
    })
  ).id;

export function modelPayload(form: BotForm) {
  return form.modelId === ""
    ? { model: null }
    : {
        model: {
          id: form.modelId,
          ...(form.effort !== "" ? { effort: form.effort } : {}),
        },
      };
}

/** Edit an existing bot; refreshes the list after a save. */
export function EditBotDialog({
  bot,
  models,
  open,
  onOpenChange,
  refresh,
}: {
  bot: ProfileInfo;
  models: ModelInfo[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  refresh: () => Promise<void>;
}) {
  return (
    <BotDialog
      title={`Edit ${bot.name}`}
      models={models}
      open={open}
      onOpenChange={onOpenChange}
      extra={
        <>
          <BackgroundModelField bot={bot} models={models} refresh={refresh} />
          <AutoApproveField bot={bot} refresh={refresh} />
          <AllowlistField bot={bot} refresh={refresh} />
        </>
      }
      initial={{
        name: bot.name,
        description: bot.description,
        persona: bot.persona,
        modelId: bot.model?.id ?? "",
        effort: bot.model?.effort ?? "",
        approvalMode: bot.policies.approvalMode,
        // Bots created before the toggle existed read as sandboxed.
        sandbox: bot.policies.sandbox !== false,
        firstTokenSec: String(bot.policies.firstTokenDeadlineSec ?? ""),
        turnMin: String(bot.policies.turnDeadlineMin ?? ""),
        taskLimit: String(bot.policies.maxRunningTasks ?? ""),
      }}
      confirm={async (form) => {
        // Throws on failure, so the form stays open with the reason.
        await api.updateProfile(bot.id, {
          name: form.name.trim(),
          // Always sent on edit, so an emptied field clears.
          description: form.description,
          persona: form.persona,
          ...modelPayload(form),
          // Per-key merge server-side: only these keys change.
          policies: {
            approvalMode: form.approvalMode,
            sandbox: form.sandbox,
            firstTokenDeadlineSec: deadlineValue(form.firstTokenSec, "firstTokenDeadlineSec"),
            turnDeadlineMin: deadlineValue(form.turnMin, "turnDeadlineMin"),
            maxRunningTasks: deadlineValue(form.taskLimit, "maxRunningTasks"),
          },
        });
        await refresh();
      }}
    />
  );
}
