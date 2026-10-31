/**
 * Add or edit a connector: where it lives (a web address or a command on the
 * server's computer), how it signs in (nothing, a header from the vault, or
 * the provider's own sign-in), and which bots may use it. Secrets are always
 * picked from the vault — never typed into this form.
 */
import { useState } from "react";
import type { McpTransport, ProfileInfo, VaultItemInfo } from "@spreissen/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  TRANSPORT_LABEL,
  inputOfForm,
  type AuthChoice,
  type ConnectorForm,
} from "@/lib/connector-text";
import type { McpServerInput } from "@spreissen/contracts";
import { Chip, ParamRows, SecretRows, ToggleRow } from "./bits";

type Patch = (patch: Partial<ConnectorForm>) => void;

const fieldLabel = "text-muted-foreground text-xs font-medium";

function WhereFields({ form, patch }: { form: ConnectorForm; patch: Patch }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Where it runs">
        <Chip
          label="Web address"
          checked={form.kind === "web"}
          onChange={() => patch({ kind: "web" })}
        />
        <Chip
          label="Command"
          checked={form.kind === "command"}
          onChange={() => patch({ kind: "command" })}
        />
      </div>
      {form.kind === "web" ? (
        <div className="flex flex-wrap gap-2">
          <Input
            className="min-w-48 flex-[3]"
            aria-label="Server address"
            inputMode="url"
            autoComplete="off"
            placeholder="https://example.com/mcp"
            value={form.url}
            onChange={(event) => patch({ url: event.target.value })}
          />
          <Select
            aria-label="Connection type"
            className="min-w-36 flex-1"
            value={form.transport === "stdio" ? "auto" : form.transport}
            onChange={(event) => patch({ transport: event.target.value as McpTransport })}
          >
            {Object.entries(TRANSPORT_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                Connection: {label}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <>
          <Input
            aria-label="Command"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            placeholder="npx -y @modelcontextprotocol/server-everything"
            value={form.commandLine}
            onChange={(event) => patch({ commandLine: event.target.value })}
          />
          <p className="text-muted-foreground text-xs">
            Runs on the server's computer in its own folder, with only basic system settings plus
            the variables you add below.
          </p>
        </>
      )}
    </>
  );
}

function AuthFields(props: { form: ConnectorForm; patch: Patch; items: VaultItemInfo[] }) {
  const { form, patch, items } = props;
  if (form.kind === "command") {
    return (
      <div className="flex flex-col gap-2">
        <span className={fieldLabel}>Secret settings (environment variables)</span>
        <SecretRows
          rows={form.env}
          onChange={(env) => patch({ env })}
          items={items}
          namePlaceholder="API_TOKEN"
          addLabel="Add variable"
          keyName={form.name}
          withPrefix={false}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <span className={fieldLabel}>Sign-in</span>
      <Select
        aria-label="Sign-in"
        value={form.auth}
        onChange={(event) => {
          const auth = event.target.value as AuthChoice;
          patch({
            auth,
            ...(auth === "headers" && form.headers.length === 0
              ? { headers: [{ name: "Authorization", item: "", prefix: "Bearer " }] }
              : {}),
          });
        }}
      >
        <option value="none">None</option>
        <option value="headers">A key from the vault (sent as a header)</option>
        <option value="oauth">Sign in with the provider</option>
      </Select>
      {form.auth === "headers" && (
        <SecretRows
          rows={form.headers}
          onChange={(headers) => patch({ headers })}
          items={items}
          namePlaceholder="Authorization"
          addLabel="Add header"
          keyName={form.name}
          withPrefix
        />
      )}
      {form.auth === "oauth" && (
        <>
          <div className="flex flex-wrap gap-2">
            <Input
              className="min-w-36 flex-1"
              aria-label="Scopes (optional)"
              placeholder="Scopes (optional)"
              value={form.oauthScope}
              onChange={(event) => patch({ oauthScope: event.target.value })}
            />
            <Input
              className="min-w-36 flex-1"
              aria-label="Client ID (optional)"
              placeholder="Client ID (optional)"
              value={form.oauthClientId}
              onChange={(event) => patch({ oauthClientId: event.target.value })}
            />
          </div>
          <span className={fieldLabel}>Client secret (optional)</span>
          <SecretRows
            rows={form.oauthSecret}
            onChange={(oauthSecret) => patch({ oauthSecret })}
            items={items}
            namePlaceholder="Client secret"
            addLabel="Add a client secret"
            withPrefix={false}
            keyName={form.name}
            hideName
          />
          <span className={fieldLabel}>Extra sign-in parameters (optional)</span>
          <ParamRows
            rows={form.oauthAuthParams}
            onChange={(oauthAuthParams) => patch({ oauthAuthParams })}
            addLabel="Add parameter"
          />
          <p className="text-muted-foreground text-xs">
            After saving, press Connect to sign in on the provider's page. Leave Client ID empty
            unless the provider gave you one; add its secret when it did. Google also needs the
            parameter access_type = offline, so the connection keeps a refresh token.
          </p>
        </>
      )}
    </div>
  );
}

function BotsField(props: { form: ConnectorForm; patch: Patch; profiles: ProfileInfo[] }) {
  const { form, patch, profiles } = props;
  const chosen = form.profiles;
  return (
    <div className="flex flex-col gap-2">
      <span className={fieldLabel}>Bots that can use it</span>
      <div className="flex flex-wrap gap-2">
        <Chip
          label="All bots"
          checked={chosen === null}
          onChange={() => patch({ profiles: null })}
        />
        {profiles
          .filter((profile) => profile.archivedAt === null)
          .map((profile) => (
            <Chip
              key={profile.id}
              label={profile.name}
              checked={chosen?.includes(profile.id) ?? false}
              onChange={(on) => {
                const base = chosen ?? [];
                const next = on ? [...base, profile.id] : base.filter((id) => id !== profile.id);
                patch({ profiles: next.length === 0 ? null : next });
              }}
            />
          ))}
      </div>
    </div>
  );
}

export function ConnectorFormView(props: {
  initial: ConnectorForm;
  submitLabel: string;
  profiles: ProfileInfo[];
  vaultItems: VaultItemInfo[];
  onSubmit: (input: McpServerInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch: Patch = (change) => setForm((current) => ({ ...current, ...change }));
  const submit = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await props.onSubmit(inputOfForm(form));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-3"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void submit();
      }}
    >
      <Input
        aria-label="Connector name"
        placeholder="Name (e.g. GitHub)"
        value={form.name}
        onChange={(event) => patch({ name: event.target.value })}
      />
      <WhereFields form={form} patch={patch} />
      <AuthFields form={form} patch={patch} items={props.vaultItems} />
      <BotsField form={form} patch={patch} profiles={props.profiles} />
      <ToggleRow
        label="Let read-only tools run without asking"
        hint="The first use still asks. Tools that can change things always ask."
        checked={form.autoAllowReadOnly}
        onChange={(autoAllowReadOnly) => patch({ autoAllowReadOnly })}
      />
      {error !== null && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" className="min-h-11 flex-1" disabled={busy}>
          {busy ? "Saving…" : props.submitLabel}
        </Button>
        <Button type="button" variant="outline" className="min-h-11" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
