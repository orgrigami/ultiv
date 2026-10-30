/**
 * What a bot's connector change will do, field by field, inside its approval
 * card: name, the full address (or the exact command, arguments and the
 * NAMES of environment variables), transport, key and which bots get it. A
 * local command gets a louder warning: it runs on this computer.
 */
import { TerminalIcon, TriangleAlertIcon } from "lucide-react";

export interface ConnectorChange {
  change: "add" | "update" | "disable" | "enable" | "remove";
  server: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: string[];
  transport: string;
  auth: string;
  bots: string;
  runsOnMac: boolean;
  changes?: string[];
  caution?: string;
}

export const connectorChangeOf = (input: unknown): ConnectorChange | null => {
  if (typeof input !== "object" || input === null) return null;
  const change = input as Partial<ConnectorChange>;
  return typeof change.change === "string" && typeof change.server === "string"
    ? (change as ConnectorChange)
    : null;
};

/** Shell-like quoting so the owner sees exactly what will run. */
const quoted = (part: string): string =>
  /^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="text-muted-foreground w-24 shrink-0 text-xs">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

export function ChangeDetails({ change }: { change: ConnectorChange }) {
  return (
    <div className="flex flex-col gap-2">
      {change.runsOnMac && (
        <p
          role="note"
          className="border-destructive/60 bg-destructive/10 text-destructive flex gap-2 rounded-lg border p-2 text-xs"
        >
          <TerminalIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          This runs a program on this computer with your user's permissions. Approve only a command
          you recognise and trust.
        </p>
      )}
      {change.caution !== undefined && (
        <p
          role="note"
          className="flex gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-2 text-xs"
        >
          <TriangleAlertIcon className="text-live mt-0.5 size-3.5 shrink-0" aria-hidden />
          {change.caution}
        </p>
      )}
      {change.changes !== undefined && change.changes.length > 0 && (
        <ul className="bg-muted/50 flex flex-col gap-1 rounded-lg p-2 text-sm">
          {change.changes.map((line) => (
            <li key={line} className="break-words">
              {line}
            </li>
          ))}
        </ul>
      )}
      <dl className="flex flex-col gap-1.5">
        <Row label="Name">{change.server}</Row>
        {change.url !== undefined && (
          <Row label="Address">
            <code className="font-mono text-xs break-all">{change.url}</code>
          </Row>
        )}
        {change.command !== undefined && (
          <Row label="Command">
            <code className="font-mono text-xs break-all">
              {[change.command, ...(change.args ?? [])].map(quoted).join(" ")}
            </code>
          </Row>
        )}
        {change.env !== undefined && change.env.length > 0 && (
          <Row label="Variables">
            <code className="font-mono text-xs break-all">{change.env.join(", ")}</code>
            <span className="text-muted-foreground text-xs"> (values from your vault)</span>
          </Row>
        )}
        <Row label="Transport">{change.transport}</Row>
        <Row label="Key">{change.auth}</Row>
        <Row label="Bots">{change.bots}</Row>
      </dl>
    </div>
  );
}
