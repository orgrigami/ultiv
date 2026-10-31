/**
 * The Connectors screen: every MCP server the owner added, its live status,
 * and an add form. The list refreshes on its own (fast while something is
 * connecting) and whenever the tab regains focus — e.g. back from sign-in.
 */
import { CopyIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  McpServerInfo,
  McpServerList,
  ProfileInfo,
  VaultItemInfo,
} from "@spreissen/contracts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DevDetails } from "@/components/ui/dev-details";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { api } from "@/lib/api";
import { writeClipboard } from "@/lib/clipboard";
import { emptyConnectorForm } from "@/lib/connector-text";
import { ConnectorCard } from "./connector-card";
import { ConnectorFormView } from "./connector-form";

/** Vault items that can stand in for a header or variable value. */
const usableItems = (list: unknown): VaultItemInfo[] =>
  Array.isArray(list)
    ? (list as VaultItemInfo[]).filter(
        (item) => item.access === "secret" && ["key", "note", "login"].includes(item.kind),
      )
    : [];

function useConnectors() {
  const [list, setList] = useState<McpServerList | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [vaultItems, setVaultItems] = useState<VaultItemInfo[]>([]);
  const load = useCallback(async () => {
    try {
      setList(await api.mcpServers());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
    setVaultItems(usableItems(await api.vault().catch(() => [])));
  }, []);
  // After Connect, poll fast for a while: the sign-in finishes in another tab.
  const [watchUntil, setWatchUntil] = useState(0);
  const busy =
    (list?.servers.some((server) => server.state === "connecting") ?? false) ||
    watchUntil > Date.now();
  useEffect(() => {
    void load();
    const timer = setInterval(
      () => {
        if (document.visibilityState === "visible") void load();
      },
      busy ? 2_000 : 10_000,
    );
    const onFocus = (): void => void load();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [load, busy]);
  const watch = useCallback(() => setWatchUntil(Date.now() + 120_000), []);
  return { list, loadFailed, vaultItems, load, watch };
}

/** Open the provider's sign-in page in a new tab (opened first, so popups aren't blocked). */
const openSignIn = async (info: McpServerInfo): Promise<void> => {
  const tab = window.open("", "_blank");
  try {
    const reply = await api.mcpConnect(info.id);
    if (reply.url === null) {
      tab?.close();
      return;
    }
    if (tab === null) {
      window.location.assign(reply.url);
      return;
    }
    tab.opener = null;
    tab.location.href = reply.url;
  } catch (cause) {
    tab?.close();
    throw cause;
  }
};

function CallbackNote({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <DevDetails>
      <span className="flex flex-wrap items-center gap-2">
        Sign-in return address (register it if a provider asks):
        <code className="font-mono break-all">{url}</code>
        <Button
          variant="ghost"
          size="xs"
          onClick={() =>
            void writeClipboard(url).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          <CopyIcon />
          {copied ? "Copied" : "Copy"}
        </Button>
      </span>
    </DevDetails>
  );
}

export function ConnectorsPanel({ profiles }: { profiles: ProfileInfo[] }) {
  const { list, loadFailed, vaultItems, load, watch } = useConnectors();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    await load();
  };
  const servers = list?.servers ?? [];
  return (
    <section aria-label="Connectors" className="flex flex-col gap-3">
      <SectionHeader
        title="Your connectors"
        action={
          !adding && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <PlusIcon />
              Add connector
            </Button>
          )
        }
      />
      {adding && (
        <Card className="gap-3 p-3">
          <p className="text-sm font-semibold">New connector</p>
          <ConnectorFormView
            initial={emptyConnectorForm()}
            submitLabel="Add connector"
            profiles={profiles}
            vaultItems={vaultItems}
            onSubmit={async (input) => {
              await api.mcpAdd(input);
              setAdding(false);
              await load();
            }}
            onCancel={() => setAdding(false)}
          />
        </Card>
      )}
      {error !== null && <ErrorState message={error} />}
      {loadFailed && list === null ? (
        <ErrorState message="Couldn't load connectors." onRetry={() => void load()} />
      ) : list !== null && servers.length === 0 && !adding ? (
        <EmptyState>
          No connectors yet. Add one to give your bots new tools — a web address from the service's
          docs, or a command that starts a local server.
        </EmptyState>
      ) : null}
      {servers.map((info) => (
        <ConnectorCard
          key={info.id}
          info={info}
          profiles={profiles}
          vaultItems={vaultItems}
          act={act}
          connect={(target) => {
            watch();
            void act(() => openSignIn(target));
          }}
        />
      ))}
      <p className="text-muted-foreground text-xs">
        Changes apply right away: bots see new tools on their next message. Each bot asks you before
        its first use of a connector, and before any tool that can change things.
      </p>
      {list !== null && <CallbackNote url={list.callbackUrl} />}
    </section>
  );
}
