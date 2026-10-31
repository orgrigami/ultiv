/**
 * One connector: live status in plain words, Connect / Try again, the
 * on-off and read-only switches, its tools (each switchable), edit and remove.
 * Every change applies live — no server restart.
 */
import { ChevronDownIcon, PencilIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import type {
  McpServerInfo,
  McpServerInput,
  ProfileInfo,
  VaultItemInfo,
} from "@spreissen/contracts";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { TRANSPORT_LABEL, formOfInfo, statusLine, targetOf, toolKind } from "@/lib/connector-text";
import { cn } from "@/lib/utils";
import { ConnectorFormView } from "./connector-form";
import { StatusDot, ToggleRow } from "./bits";

export interface CardProps {
  info: McpServerInfo;
  profiles: ProfileInfo[];
  vaultItems: VaultItemInfo[];
  /** Run an action, show its error, then reload the list. */
  act: (run: () => Promise<unknown>) => Promise<void>;
  /** Start the provider sign-in in a new tab. */
  connect: (info: McpServerInfo) => void;
}

/** The saved settings as a request, with one change applied. */
const savedInput = (info: McpServerInfo, change: Partial<McpServerInput>): McpServerInput => ({
  name: info.name,
  transport: info.transport,
  url: info.url,
  command: info.command,
  auth: info.auth,
  profiles: info.profiles,
  enabled: info.enabled,
  autoAllowReadOnly: info.autoAllowReadOnly,
  disabledTools: info.disabledTools,
  ...change,
});

function ToolList({ info, act }: Pick<CardProps, "info" | "act">) {
  const [open, setOpen] = useState(false);
  if (info.tools.length === 0) return null;
  const on = info.tools.filter((tool) => tool.enabled).length;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="hover:bg-muted/60 focus-visible:ring-ring/50 flex min-h-11 items-center gap-2 rounded-lg px-2 text-left text-sm outline-none focus-visible:ring-3"
      >
        <span className="flex-1">
          Tools{" "}
          <span className="text-muted-foreground">
            · {on} of {info.tools.length} on
          </span>
        </span>
        <ChevronDownIcon
          className={cn(
            "size-4 transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      {open &&
        info.tools.map((tool) => (
          <ToggleRow
            key={tool.remoteName}
            label={tool.title ?? tool.remoteName}
            hint={`${toolKind(tool)}${tool.description === "" ? "" : ` · ${tool.description.split("\n")[0]?.slice(0, 120) ?? ""}`}`}
            checked={tool.enabled}
            onChange={(enabled) =>
              void act(() =>
                api.mcpUpdate(
                  info.id,
                  savedInput(info, {
                    disabledTools: enabled
                      ? info.disabledTools.filter((name) => name !== tool.remoteName)
                      : [...info.disabledTools, tool.remoteName],
                  }),
                ),
              )
            }
          />
        ))}
    </div>
  );
}

function StatusRow({ info, act, connect }: Pick<CardProps, "info" | "act" | "connect">) {
  const oauth = info.auth.kind === "oauth";
  const needsConnect = oauth && (info.state === "needs_sign_in" || !info.signedIn);
  return (
    <div className="flex items-center gap-2">
      <p
        className={cn(
          "min-w-0 flex-1 text-sm",
          info.state === "failed" ? "text-destructive" : "text-muted-foreground",
        )}
        aria-live="polite"
      >
        {statusLine(info)}
        {info.state === "connected" &&
        info.activeTransport !== null &&
        info.activeTransport !== "stdio"
          ? ` · ${TRANSPORT_LABEL[info.activeTransport]}`
          : ""}
      </p>
      {info.enabled && needsConnect && (
        <Button className="min-h-11" onClick={() => connect(info)}>
          Connect
        </Button>
      )}
      {info.enabled && !needsConnect && info.state !== "connected" && (
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() => void act(() => api.mcpReconnect(info.id))}
        >
          <RefreshCwIcon />
          Try again
        </Button>
      )}
    </div>
  );
}

function Actions({ info, act, onEdit }: Pick<CardProps, "info" | "act"> & { onEdit: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={onEdit}>
        <PencilIcon />
        Edit
      </Button>
      {info.state === "connected" && (
        <Button variant="ghost" size="sm" onClick={() => void act(() => api.mcpReconnect(info.id))}>
          <RefreshCwIcon />
          Reconnect
        </Button>
      )}
      {info.auth.kind === "oauth" && info.signedIn && (
        <Button variant="ghost" size="sm" onClick={() => void act(() => api.mcpSignOut(info.id))}>
          Sign out
        </Button>
      )}
      <span className="flex-1" />
      <ConfirmDialog
        title={`Remove ${info.name}?`}
        warning="Bots lose its tools right away. Any call in progress stops. Saved sign-in is deleted."
        confirmLabel="Remove connector"
        onConfirm={async () => {
          await api.mcpRemove(info.id);
          await act(async () => undefined);
        }}
      >
        <Button variant="ghost" size="icon" aria-label={`Remove ${info.name}`}>
          <Trash2Icon />
        </Button>
      </ConfirmDialog>
    </div>
  );
}

export function ConnectorCard(props: CardProps) {
  const { info, act } = props;
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <Card className="gap-3 p-3">
        <p className="text-sm font-semibold">Edit {info.name}</p>
        <ConnectorFormView
          initial={formOfInfo(info)}
          submitLabel="Save changes"
          profiles={props.profiles}
          vaultItems={props.vaultItems}
          onSubmit={async (input) => {
            await api.mcpUpdate(info.id, input);
            setEditing(false);
            await act(async () => undefined);
          }}
          onCancel={() => setEditing(false)}
        />
      </Card>
    );
  }
  const bots =
    info.profiles === null
      ? "All bots"
      : props.profiles
          .filter((profile) => info.profiles?.includes(profile.id))
          .map((profile) => profile.name)
          .join(", ") || "No bots";
  return (
    <Card className="gap-1 p-3">
      <div className="flex items-center gap-2">
        <StatusDot state={info.state} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{info.name}</span>
          <span className="text-muted-foreground block truncate text-xs">
            {targetOf(info)} · {bots}
          </span>
        </span>
      </div>
      <StatusRow info={info} act={act} connect={props.connect} />
      <ToggleRow
        label="On"
        checked={info.enabled}
        onChange={(enabled) =>
          void act(() => api.mcpUpdate(info.id, savedInput(info, { enabled })))
        }
      />
      <ToggleRow
        label="Read-only tools run without asking"
        hint={info.firstUseApproved ? undefined : "After you approve the first use."}
        checked={info.autoAllowReadOnly}
        onChange={(autoAllowReadOnly) =>
          void act(() => api.mcpUpdate(info.id, savedInput(info, { autoAllowReadOnly })))
        }
      />
      <ToolList info={info} act={act} />
      <Actions info={info} act={act} onEdit={() => setEditing(true)} />
    </Card>
  );
}
