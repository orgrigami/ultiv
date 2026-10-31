/**
 * The bot form: name, role, personality and model, used to create a bot (from
 * the Bots page or the switcher) and to edit one. On phones the selects stack
 * and Save spans the sheet.
 */
import { useMemo, useState } from "react";
import { XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ModelOptions } from "@/components/model-options";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useApp } from "@/lib/app-state";
import type { ModelInfo, ProfileApprovalMode, ProfileInfo } from "@ultiv/contracts";

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

/** The approval modes and their labels (shared by the edit dialog and the chat details). */
export const APPROVAL_MODE_OPTIONS: readonly {
  value: ProfileApprovalMode;
  label: string;
}[] = [
  { value: "manual", label: "Manual — ask me" },
  { value: "jev", label: "Jev decides" },
  { value: "yolo", label: "Fully automatic" },
];

/** What each approval mode means, in one line (shown under the select). */
export const APPROVAL_MODE_HELP: Record<ProfileApprovalMode, string> = {
  manual: "You approve every action the bot wants to take.",
  jev:
    "Jev handles low-risk calls and tells you in the chat what it approved or declined. " +
    "Credentials, connectors, secrets and the host shell always ask you.",
  yolo:
    "Actions run without asking. A credential's or connector's first use, connector " +
    "changes and secret requests still ask you.",
};

/** Model and effort: side by side only when both selects have room for their labels. */
export function ModelFields({
  modelId,
  effort,
  onModel,
  onEffort,
  models,
}: {
  modelId: string;
  effort: string;
  onModel: (modelId: string) => void;
  onEffort: (effort: string) => void;
  models: ModelInfo[];
}) {
  const efforts = useMemo(
    () => models.find((model) => model.id === modelId)?.efforts ?? [],
    [models, modelId],
  );
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:gap-2">
      <label className="flex flex-1 flex-col gap-1 text-sm">
        Model
        <Select
          className="w-full"
          value={modelId}
          onChange={(event) => onModel(event.target.value)}
        >
          <option value="">Workspace default</option>
          <ModelOptions models={models} />
        </Select>
      </label>
      <label
        className="flex flex-1 flex-col gap-1 text-sm"
        title={efforts.length === 0 ? "Pick a model with effort levels first" : undefined}
      >
        Effort
        <Select
          className="w-full"
          value={effort}
          disabled={efforts.length === 0}
          onChange={(event) => onEffort(event.target.value)}
        >
          <option value="">Model default</option>
          {efforts.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </Select>
      </label>
    </div>
  );
}

/**
 * The bot's always-allowed tools: entries skip the approval gate entirely —
 * each got there when an approval card was answered with "Always allow".
 * Removing one returns the tool to the bot's approval mode immediately.
 */
export function AutoApproveField({
  bot,
  refresh,
}: {
  bot: ProfileInfo;
  refresh: () => Promise<void>;
}) {
  const tools = bot.policies.autoApprove;
  const [busyTool, setBusyTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = async (tool: string): Promise<void> => {
    setBusyTool(tool);
    setError(null);
    try {
      // The policies patch merges per key, so send the whole shrunken list.
      await api.updateProfile(bot.id, {
        policies: { ...bot.policies, autoApprove: tools.filter((name) => name !== tool) },
      });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyTool(null);
    }
  };
  if (tools.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span>Always allowed</span>
      <div className="flex flex-wrap gap-1">
        {tools.map((tool) => (
          <Badge key={tool} variant="secondary" className="h-6 pr-1">
            {tool}
            <button
              type="button"
              aria-label={`Stop always allowing ${tool}`}
              disabled={busyTool !== null}
              className="rounded-full p-0.5 hover:bg-foreground/10 disabled:opacity-50"
              onClick={() => {
                void remove(tool);
              }}
            >
              <XIcon className="size-3" />
            </button>
          </Badge>
        ))}
      </div>
      <span className="text-muted-foreground text-xs">
        Tools approved with "Always allow" skip the approval gate. Removing one puts it back under
        this bot's approval mode.
      </span>
      {error !== null && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}

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
  const submit = async (): Promise<void> => {
    if (form.name.trim() === "") return;
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
                ? "The bash tool runs in this bot's own microVM sandbox; its workspace files are artifacts."
                : "No sandboxed bash for this bot. The privileged bash_host stays, always approved by you."}
            </span>
          </label>
          {extra}
          {error !== null && <p className="text-destructive text-sm">{error}</p>}
          <SaveRow busy={busy} unnamed={form.name.trim() === ""} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Create a bot from the form; resolves to its id. */
export const createBot = async (form: BotForm): Promise<string> =>
  (
    await api.createProfile({
      name: form.name.trim(),
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

/** "New bot" without a trigger of its own (the bot switcher drives it). */
export function NewBotDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => Promise<void>;
}) {
  const { sessions } = useApp();
  return (
    <BotDialog
      title="New bot"
      initial={emptyForm}
      models={sessions.models}
      open={open}
      onOpenChange={onOpenChange}
      confirm={async (form) => {
        await onCreated(await createBot(form));
      }}
    />
  );
}

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
      extra={<AutoApproveField bot={bot} refresh={refresh} />}
      initial={{
        name: bot.name,
        description: bot.description,
        persona: bot.persona,
        modelId: bot.model?.id ?? "",
        effort: bot.model?.effort ?? "",
        approvalMode: bot.policies.approvalMode,
        // Bots created before the toggle existed read as sandboxed.
        sandbox: bot.policies.sandbox !== false,
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
          policies: { approvalMode: form.approvalMode, sandbox: form.sandbox },
        });
        await refresh();
      }}
    />
  );
}
