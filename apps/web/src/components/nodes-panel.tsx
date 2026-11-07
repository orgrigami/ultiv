/**
 * The Nodes panel (Settings): the owner's paired machines — bash's `node`
 * targets. Pairing is an owner act: the dialog shows the one-time token once
 * (the server never shows it again), the list carries status, last-seen and
 * the roots (where scripts START — not a jail: a script runs as the owner's
 * account and can reach anything it can), and revoke kills the pairing. A bot can run scripts on
 * a node only after it is paired here and the bot's host access is on.
 */
import { useCallback, useEffect, useState } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SectionHeader } from "@/components/ui/section-header";
import { Badge } from "@/components/ui/badge";
import { ListCard } from "@/components/ui/list-card";
import { SkeletonRows } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import type { NodeInfo } from "@spriessen/contracts";

const relative = (at: number | null): string =>
  at === null ? "never seen" : `${Math.max(1, Math.round((Date.now() - at) / 60_000))} min ago`;

const rootsText = (roots: readonly string[]): string =>
  roots.length === 0 ? "no starting folder" : `starts in ${roots.join(", ")}`;

export function NodesPanel() {
  const [nodes, setNodes] = useState<NodeInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [minted, setMinted] = useState<{ name: string; token: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setNodes(await api.nodes());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => void load(), [load]);

  if (error !== null && nodes === null)
    return (
      <section aria-label="Nodes" className="flex flex-col gap-2">
        <SectionHeader title="Nodes" />
        <ErrorState message={`Couldn't load nodes: ${error}`} onRetry={() => void load()} />
      </section>
    );
  return (
    <section aria-label="Nodes" className="flex flex-col gap-2">
      <SectionHeader
        title="Nodes"
        action={
          <Button size="sm" variant="outline" onClick={() => setPairing(true)}>
            <PlusIcon /> Pair a node
          </Button>
        }
      />
      <p className="text-muted-foreground text-xs">
        Your other machines, so a bot with host access can run scripts there (bash target
        &quot;node&quot;). Scripts run as your account on that machine and can reach anything it
        can; every one asks you first unless you saved that exact script. The pairing token is shown
        once, here.
      </p>
      {nodes === null ? (
        <SkeletonRows label="Loading nodes" rows={1} />
      ) : nodes.length === 0 ? (
        <EmptyState>
          No nodes paired yet — pair one to let your bots run scripts on another machine you own.
        </EmptyState>
      ) : (
        <ListCard as="ul">
          {nodes.map((node) => (
            <NodeRow key={node.id} node={node} onChanged={load} />
          ))}
        </ListCard>
      )}
      <PairDialog
        open={pairing}
        onClose={() => setPairing(false)}
        onPaired={(name, token) => {
          setPairing(false);
          setMinted({ name, token });
          void load();
        }}
      />
      <Dialog open={minted !== null} onOpenChange={(open) => !open && setMinted(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>Copy the token for {minted?.name} now</DialogTitle>
          <p className="text-muted-foreground text-sm">
            Run the node agent on that machine with this token. It is shown once — the server keeps
            only a hash and can never show it again. If it is lost, revoke the node and pair again.
          </p>
          <code className="bg-muted font-mono text-xs break-all rounded p-2 select-all">
            {minted?.token}
          </code>
          <p className="text-muted-foreground text-sm">
            On that machine, save it to a file only you can read (chmod 600) and run{" "}
            <code className="font-mono text-xs">
              spriessen node --server &lt;this address&gt; --token-file &lt;file&gt;
            </code>
            . Or skip the copy: sign in there and run{" "}
            <code className="font-mono text-xs">spriessen node pair</code>.
          </p>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function NodeRow({ node, onChanged }: { node: NodeInfo; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const revoke = async () => {
    setBusy(true);
    try {
      await api.revokeNode(node.id);
      await onChanged();
    } finally {
      setBusy(false);
    }
  };
  const paired = node.status === "paired";
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm">
          {node.name}
          <Badge variant={paired ? (node.connected ? "live" : "ok") : "muted"}>
            {paired ? (node.connected ? "connected" : "paired") : "revoked"}
          </Badge>
        </span>
        <span className="text-muted-foreground font-mono text-xs truncate">
          {rootsText(node.roots)} · last seen {relative(node.lastSeenAt)}
        </span>
      </span>
      {paired && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revoke()}>
          Revoke
        </Button>
      )}
    </li>
  );
}

function PairDialog({
  open,
  onClose,
  onPaired,
}: {
  open: boolean;
  onClose: () => void;
  onPaired: (name: string, token: string) => void;
}) {
  const [name, setName] = useState("");
  const [roots, setRoots] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pair = async () => {
    setBusy(true);
    setError(null);
    try {
      const rootsList = roots
        .split("\n")
        .map((root) => root.trim())
        .filter((root) => root !== "");
      const minted = await api.pairNode({ name: name.trim(), roots: rootsList });
      setName("");
      setRoots("");
      onPaired(minted.node.name, minted.token);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle>Pair a node</DialogTitle>
        <label className="flex flex-col gap-1 text-sm">
          Name
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="build-box"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Starting folders (one absolute path per line)
          <span className="text-muted-foreground text-xs">
            Scripts start in one of these. They are not a fence: a script can still go anywhere your
            account can.
          </span>
          <Textarea
            mono
            rows={3}
            value={roots}
            onChange={(event) => setRoots(event.target.value)}
            placeholder={"/home/me/repos"}
          />
        </label>
        {error !== null && <p className="text-destructive text-xs">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || name.trim() === "" || roots.trim() === ""}
            onClick={() => void pair()}
          >
            Pair
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
