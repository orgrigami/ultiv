/**
 * The service files `spriessen daemon install` writes — pure text, so they
 * are tested without touching the machine. Two roles:
 *
 * - `server`: `spriessen serve` under the OS's own supervisor, restarted on
 *   crash, started at login (systemd --user; launchd LaunchAgent on macOS).
 * - `node`: `spriessen node`, this machine as a paired node for a server
 *   elsewhere.
 *
 * Both run the CLI's plain-TS entry with the Node that installed them
 * (`process.execPath`), from the folder that keeps the data. Nothing secret
 * is written into a unit: the node's token stays in its 0600 file and the
 * server's keys stay in `.env`.
 */
export type DaemonRole = "server" | "node";

export interface UnitSpec {
  readonly role: DaemonRole;
  /** The Node binary. */
  readonly node: string;
  /** The CLI entry (apps/cli/src/main.ts). */
  readonly entry: string;
  /** Arguments after the entry (`serve --port 8787`, `node --server … --token-file …`). */
  readonly args: readonly string[];
  readonly workingDir: string;
  /** macOS only: where stdout/stderr go. */
  readonly logFile: string;
}

export const SYSTEMD_NAMES: Record<DaemonRole, string> = {
  server: "spriessen.service",
  node: "spriessen-node.service",
};

export const LAUNCHD_LABELS: Record<DaemonRole, string> = {
  server: "id.spriessen.server",
  node: "id.spriessen.node",
};

const DESCRIPTIONS: Record<DaemonRole, string> = {
  server: "Spriessen server (API, web app, bots)",
  node: "Spriessen node agent (this machine as a paired node)",
};

/** Quote one word for a systemd ExecStart line. */
export const systemdWord = (word: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `"${word.replace(/(["\\])/g, "\\$1")}"`;

export const systemdUnit = (spec: UnitSpec): string =>
  [
    "[Unit]",
    `Description=${DESCRIPTIONS[spec.role]}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${spec.workingDir}`,
    `ExecStart=${[spec.node, "--disable-warning=ExperimentalWarning", spec.entry, ...spec.args].map(systemdWord).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=3",
    // The server closes links and the mind's scope on SIGTERM; give it room.
    "TimeoutStopSec=30",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

const xml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const launchdPlist = (spec: UnitSpec): string => {
  const program = [spec.node, "--disable-warning=ExperimentalWarning", spec.entry, ...spec.args];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${LAUNCHD_LABELS[spec.role]}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...program.map((word) => `    <string>${xml(word)}</string>`),
    "  </array>",
    `  <key>WorkingDirectory</key><string>${xml(spec.workingDir)}</string>`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    `  <key>StandardOutPath</key><string>${xml(spec.logFile)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(spec.logFile)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
};
