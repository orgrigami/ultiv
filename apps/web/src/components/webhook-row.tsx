/**
 * Inbound webhooks on the Routines page: the row (plain summary; URL, method,
 * reject breakdown, a new-token action and a test fire behind Details) and the
 * creation dialog. Only a hash of the token is stored, so the full URL is
 * shown once, right after creating it or issuing a new token. Bots never see it.
 */
import { BellIcon, KeyRoundIcon, PlugIcon } from "lucide-react";
import { useState } from "react";
import type { ProfileInfo, WebhookInfo } from "@spreissen/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DevDetails } from "@/components/ui/dev-details";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { BUSY_LABEL, Meta, RawValue, RoutineRow, runs, when } from "@/components/routine-rows";

/** Send a test payload through the real ingress checks. */
function TestFire({ hook }: { hook: WebhookInfo }) {
  const [payload, setPayload] = useState("{}");
  const [result, setResult] = useState<string | null>(null);
  const run = async (): Promise<void> => {
    setResult(null);
    try {
      const outcome = await api.testWebhook(hook.id, JSON.parse(payload) as unknown);
      setResult(
        outcome.accepted
          ? "Accepted: the payload matches."
          : `Turned away: ${outcome.detail ?? "the payload doesn't match the expected format"}`,
      );
    } catch (cause) {
      setResult(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <form
      className="mt-1 flex flex-wrap items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void run();
      }}
    >
      <Input
        className="min-w-0 flex-1 font-mono"
        value={payload}
        onChange={(event) => setPayload(event.target.value)}
        aria-label={`Test payload for ${hook.name ?? "this webhook"}`}
      />
      <Button type="submit" variant="outline" size="sm">
        <PlugIcon /> Send test
      </Button>
      {result !== null && (
        <p role="status" className="w-full">
          {result}
        </p>
      )}
    </form>
  );
}

const hookUrl = (id: string, token: string): string =>
  `${location.origin}/hooks/${id}?token=${encodeURIComponent(token)}`;

/** The full URL, shown once: it can't be read back later. */
function OneTimeUrl({ id, token }: { id: string; token: string }) {
  return (
    <div className="flex flex-col gap-1" role="status">
      <RawValue label="URL:" value={hookUrl(id, token)} />
      <p className="text-xs">Copy it now. It won't be shown again.</p>
    </div>
  );
}

/** Issue a new token (the old one stops working) and show its URL once. */
function NewToken({ hook }: { hook: WebhookInfo }) {
  const [confirming, setConfirming] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rotate = async (): Promise<void> => {
    setError(null);
    try {
      const rotated = await api.rotateWebhookToken(hook.id);
      setToken(rotated.token ?? null);
      setConfirming(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  if (token !== null) return <OneTimeUrl id={hook.id} token={token} />;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {confirming ? (
        <>
          <span>Anything using the current token will be refused.</span>
          <Button variant="outline" size="sm" onClick={() => void rotate()}>
            Issue new token
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
          <KeyRoundIcon /> New token
        </Button>
      )}
      {error !== null && <p className="text-destructive w-full">{error}</p>}
    </div>
  );
}

export function WebhookRow({
  hook,
  bot,
  onDelete,
}: {
  hook: WebhookInfo;
  bot: string;
  onDelete: () => Promise<void>;
}) {
  const rejected = hook.rejectedAuth + hook.rejectedSchema + hook.rejectedRate + hook.rejectedSize;
  return (
    <RoutineRow
      what="webhook"
      warning="Anything still sending to it will be refused. This can't be undone."
      onDelete={onDelete}
    >
      <p className="text-sm font-medium">{hook.name ?? "Webhook"}</p>
      <p className="text-sm">Runs when a webhook is called</p>
      <Meta>
        <span>{bot}</span>
        {hook.schema !== null && <Badge variant="outline">Checks format</Badge>}
        {hook.whenBusy !== undefined && hook.whenBusy !== "steer" && (
          <Badge variant="outline">{BUSY_LABEL[hook.whenBusy] ?? hook.whenBusy}</Badge>
        )}
      </Meta>
      <p className="text-muted-foreground text-xs">
        {runs(hook.fireCount, hook.lastFiredAt)}
        {rejected > 0 && <span className="text-destructive">. Turned away {rejected}</span>}
      </p>
      <DevDetails>
        <div className="flex flex-col gap-1">
          <RawValue label="Method:" value="POST" />
          <RawValue
            label="URL (add the token):"
            value={`${location.origin}/hooks/${hook.id}?token=`}
            shown={`${location.origin}/hooks/${hook.id.slice(0, 8)}…?token=•••`}
          />
          <p>The token was shown once, when it was made. Lost it? Issue a new one.</p>
          <NewToken hook={hook} />
          {rejected > 0 && (
            <p>
              Turned away: wrong token {hook.rejectedAuth}, wrong format {hook.rejectedSchema}, too
              often {hook.rejectedRate}, too large {hook.rejectedSize}.
            </p>
          )}
          {hook.lastRejectAt !== null && (
            <p className="break-words">
              Last turned away {when(hook.lastRejectAt)} ({hook.lastRejectReason})
              {hook.recentRejects[0] !== undefined && `: ${hook.recentRejects[0].detail}`}
            </p>
          )}
          <TestFire hook={hook} />
        </div>
      </DevDetails>
    </RoutineRow>
  );
}

/** Creation form: a webhook needs a bot to deliver into (optional schema). */
export function CreateWebhook({
  profiles,
  onCreated,
}: {
  profiles: ProfileInfo[];
  onCreated: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string>("");
  const [name, setName] = useState("");
  const [schema, setSchema] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; token: string } | null>(null);

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      let parsed: Record<string, unknown> | null = null;
      if (schema.trim() !== "") {
        parsed = JSON.parse(schema) as Record<string, unknown>;
      }
      const hook = await api.createWebhook({
        sessionId,
        ...(name.trim() !== "" ? { name: name.trim() } : {}),
        ...(parsed !== null ? { schema: parsed } : {}),
      });
      setName("");
      setSchema("");
      // Keep the dialog open: this is the only time the token can be shown.
      setCreated(hook.token !== undefined ? { id: hook.id, token: hook.token } : null);
      if (hook.token === undefined) setOpen(false);
      await onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (profiles.length === 0) return null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setCreated(null);
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <BellIcon /> New webhook
          </Button>
        }
      />
      <DialogContent>
        <DialogTitle>New inbound webhook</DialogTitle>
        {created !== null ? (
          <div className="mt-3 flex flex-col gap-2 text-sm">
            <p>Created. Other apps send a POST to this URL:</p>
            <OneTimeUrl id={created.id} token={created.token} />
            <Button
              size="sm"
              onClick={() => {
                setOpen(false);
                setCreated(null);
              }}
            >
              Done
            </Button>
          </div>
        ) : (
          <form
            className="mt-3 flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (sessionId !== "" && !busy) void create();
            }}
          >
            <Select
              className="w-full"
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              aria-label="Deliver into bot"
            >
              <option value="">Choose a bot…</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </Select>
            <Input
              aria-label="Webhook name (optional)"
              placeholder="Name (optional)"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Textarea
              aria-label="JSON Schema (optional)"
              className="min-h-20 font-mono text-sm"
              placeholder='Expected format as JSON Schema (optional), e.g. {"type":"object","required":["event"]}'
              value={schema}
              onChange={(event) => setSchema(event.target.value)}
            />
            {error !== null && <p className="text-destructive text-xs">{error}</p>}
            <Button type="submit" size="sm" disabled={sessionId === "" || busy}>
              Create
            </Button>
            <p className="text-muted-foreground text-xs">
              After you create it, you'll see its URL with the secret token once. Bots never see the
              token.
            </p>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
