/**
 * The bot form's reusable fields: model and effort, approval-mode choices
 * and help, the auto-approve list and the tool allowlist. The Edit-bot
 * dialog and the Crew profile's Access tab both use them.
 */

import { useEffect, useMemo, useState } from "react";
import { XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { ModelOptions } from "@/components/model-options";
import { Select } from "@/components/ui/select";
import { Tile } from "@/components/ui/tile";
import { api } from "@/lib/api";
import { describeAllowEntry } from "@/lib/approval-text";
import { allowlistMatches, notOnList } from "@/lib/allowlist";
import { plural } from "@/lib/plural";
import type {
  ModelInfo,
  ProfileApprovalMode,
  ProfileInfo,
  ToolCatalogEntry,
} from "@spriessen/contracts";

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
  label = "Model",
  emptyLabel = "Workspace default",
  disabled = false,
}: {
  modelId: string;
  effort: string;
  onModel: (modelId: string) => void;
  onEffort: (effort: string) => void;
  models: ModelInfo[];
  label?: string;
  /** The empty choice's words: what applies when no model is picked. */
  emptyLabel?: string;
  disabled?: boolean;
}) {
  const efforts = useMemo(
    () => models.find((model) => model.id === modelId)?.efforts ?? [],
    [models, modelId],
  );
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:gap-2">
      <label className="flex flex-1 flex-col gap-1 text-sm">
        {label}
        <Select
          className="w-full"
          value={modelId}
          disabled={disabled}
          onChange={(event) => onModel(event.target.value)}
        >
          <option value="">{emptyLabel}</option>
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
          disabled={disabled || efforts.length === 0}
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
          <Badge
            key={tool}
            variant="secondary"
            size="chip"
            className="max-w-full"
            title={describeAllowEntry(tool).full}
          >
            <span className="truncate font-mono">{describeAllowEntry(tool).label}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              pill
              className="shrink-0"
              aria-label={`Stop always allowing ${describeAllowEntry(tool).label}`}
              disabled={busyTool !== null}
              onClick={() => {
                void remove(tool);
              }}
            >
              <XIcon className="size-3" />
            </Button>
          </Badge>
        ))}
      </div>
      <span className="text-muted-foreground text-xs">
        Tools approved with "Always allow" skip the approval gate. A host-shell rule covers only
        that exact script. Removing one puts it back under this bot's approval mode.
      </span>
      {error !== null && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}

/**
 * The bot's tool allowlist (edit only): a curated list of installed tools;
 * null = every installed tool. Each change PATCHes the field wholesale
 * (there is no merge) and refreshes the page behind the dialog, like the
 * always-allowed list above. The catalog comes from GET /api/tools, so a
 * newly installed tool is visible here even before any bot uses it.
 */
export function AllowlistField({
  bot,
  refresh,
}: {
  bot: ProfileInfo;
  refresh: () => Promise<void>;
}) {
  const [catalog, setCatalog] = useState<readonly ToolCatalogEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = false;
    api
      .tools()
      .then((rows) => {
        if (!alive) setCatalog(rows);
      })
      .catch(() => {
        if (!alive) setCatalog([]);
      });
    return () => {
      alive = true;
    };
  }, []);
  const curated = bot.toolAllowlist;
  const save = async (next: readonly string[] | null): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.updateProfile(bot.id, { toolAllowlist: next === null ? null : [...next] });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (name: string): void => {
    const list = curated ?? [];
    void save(list.includes(name) ? list.filter((tool) => tool !== name) : [...list, name]);
  };
  const entries = catalog ?? [];
  const matches = allowlistMatches(entries, query);
  const gap = curated === null ? 0 : notOnList(entries, curated);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <span>Allowed tools</span>
      {curated === null ? (
        <p className="text-muted-foreground text-xs">
          Every installed tool. Add one below to start curating: a listed bot may only call the
          tools on its list, so tools installed later stay out of its reach until you add them.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-xs">
            {curated.length === 0
              ? "No tools."
              : `${curated.length} ${plural(curated.length, "tool", "tools")}.`}{" "}
            {catalog !== null &&
              (gap === 0
                ? "Every installed tool is on the list."
                : `${gap} installed ${gap === 1 ? "tool is" : "tools are"} not on the list — they stay out of reach until you add them.`)}
          </p>
          {curated.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {curated.map((tool) => (
                <Badge
                  key={tool}
                  variant="secondary"
                  size="chip"
                  className="max-w-full"
                  title={entries.find((entry) => entry.name === tool)?.description ?? tool}
                >
                  <span className="truncate font-mono">{tool}</span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    pill
                    className="shrink-0"
                    aria-label={`Remove ${tool} from the allowlist`}
                    disabled={busy}
                    onClick={() => toggle(tool)}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </Badge>
              ))}
            </div>
          )}
          <ConfirmDialog
            title="Allow every installed tool"
            warning="This clears the list: the bot may call every installed tool, including ones installed later."
            confirmLabel="Allow everything"
            onConfirm={async () => {
              await save(null);
            }}
          >
            <Button type="button" variant="outline" size="sm" disabled={busy}>
              Allow everything
            </Button>
          </ConfirmDialog>
        </div>
      )}
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search installed tools…"
        aria-label="Search installed tools"
      />
      {catalog === null ? (
        <p className="text-muted-foreground text-xs">Loading the tool catalog…</p>
      ) : matches.length === 0 ? (
        <p className="text-muted-foreground text-xs">No installed tool matches.</p>
      ) : (
        <Tile className="divide-border divide-y overflow-hidden">
          {matches.map((tool) => {
            const on = curated?.includes(tool.name) ?? false;
            return (
              <ListRow
                key={tool.name}
                title={<span className="truncate font-mono">{tool.name}</span>}
                subtitle={tool.description === "" ? undefined : tool.description}
                onClick={() => toggle(tool.name)}
                trailing={
                  <Button
                    variant={on ? "outline" : "ghost"}
                    size="sm"
                    className="shrink-0"
                    disabled={busy}
                    aria-label={`${on ? "Remove" : "Add"} ${tool.name}`}
                    onClick={() => toggle(tool.name)}
                  >
                    {on ? "Remove" : "Add"}
                  </Button>
                }
              />
            );
          })}
        </Tile>
      )}
      {error !== null && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}
