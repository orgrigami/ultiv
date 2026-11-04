/**
 * `spriessen daemon <install|uninstall|start|stop|restart|status|logs> [server|node]`:
 * `serve` (or `node`) kept running by the OS — systemd `--user` on Linux,
 * a launchd LaunchAgent on macOS — so it restarts on a crash and starts at
 * login. `install` writes the unit (units.ts) and starts it; the rest hand
 * over to systemctl/launchctl. On Linux a user service survives logout only
 * with lingering on (`loginctl enable-linger $USER`), which install points out.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { numberFlag, stringFlag, type Parsed } from "../args.ts";
import { nodeTokenPath, serverOf } from "../config.ts";
import {
  LAUNCHD_LABELS,
  launchdPlist,
  SYSTEMD_NAMES,
  systemdUnit,
  type DaemonRole,
  type UnitSpec,
} from "../daemon/units.ts";
import { repoRoot, serverDir } from "./serve.ts";

const ACTIONS = ["install", "uninstall", "start", "stop", "restart", "status", "logs"] as const;
type Action = (typeof ACTIONS)[number];

const run = (command: string, args: readonly string[]): number =>
  spawnSync(command, args, { stdio: "inherit" }).status ?? 1;

const unitPath = (role: DaemonRole): string =>
  process.platform === "darwin"
    ? join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABELS[role]}.plist`)
    : join(homedir(), ".config", "systemd", "user", SYSTEMD_NAMES[role]);

const logFileOf = (role: DaemonRole): string =>
  join(homedir(), "Library", "Logs", `spriessen-${role}.log`);

/** What the unit runs: `serve` with the chosen port/host, or `node` with its server. */
export const unitSpecOf = (role: DaemonRole, parsed: Parsed): UnitSpec => {
  const port = numberFlag(parsed, "port");
  const host = stringFlag(parsed, "host");
  const args =
    role === "server"
      ? [
          "serve",
          ...(port !== undefined ? ["--port", String(port)] : []),
          ...(host !== undefined ? ["--host", host] : []),
        ]
      : [
          "node",
          "--server",
          serverOf(stringFlag(parsed, "server")),
          "--token-file",
          stringFlag(parsed, "token-file") ?? nodeTokenPath(),
        ];
  return {
    role,
    node: process.execPath,
    entry: join(repoRoot(), "apps", "cli", "src", "main.ts"),
    args,
    workingDir: role === "server" ? serverDir() : homedir(),
    logFile: logFileOf(role),
  };
};

const install = (spec: UnitSpec): number => {
  const path = unitPath(spec.role);
  mkdirSync(dirname(path), { recursive: true });
  if (process.platform === "darwin") {
    mkdirSync(dirname(spec.logFile), { recursive: true });
    writeFileSync(path, launchdPlist(spec));
    console.log(`Wrote ${path}`);
    return run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, path]);
  }
  writeFileSync(path, systemdUnit(spec));
  console.log(`Wrote ${path}`);
  const code = run("systemctl", ["--user", "daemon-reload"]);
  if (code !== 0) return code;
  const started = run("systemctl", ["--user", "enable", "--now", SYSTEMD_NAMES[spec.role]]);
  if (started === 0) {
    console.log("To keep it running after you log out: loginctl enable-linger $USER");
  }
  return started;
};

const control = (role: DaemonRole, action: Exclude<Action, "install">): number => {
  const path = unitPath(role);
  if (action !== "uninstall" && !existsSync(path)) {
    console.error(`Not installed. Run: spriessen daemon install ${role}`);
    return 1;
  }
  if (process.platform === "darwin") {
    const target = `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABELS[role]}`;
    switch (action) {
      case "uninstall": {
        run("launchctl", ["bootout", target]);
        rmSync(path, { force: true });
        return 0;
      }
      case "start":
        return run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, path]);
      case "stop":
        return run("launchctl", ["bootout", target]);
      case "restart":
        return run("launchctl", ["kickstart", "-k", target]);
      case "status":
        return run("launchctl", ["print", target]);
      case "logs":
        return run("tail", ["-n", "100", "-f", logFileOf(role)]);
    }
  }
  const name = SYSTEMD_NAMES[role];
  switch (action) {
    case "uninstall": {
      run("systemctl", ["--user", "disable", "--now", name]);
      rmSync(path, { force: true });
      return run("systemctl", ["--user", "daemon-reload"]);
    }
    case "logs":
      return run("journalctl", ["--user", "-u", name, "-n", "100", "-f"]);
    case "status":
      return run("systemctl", ["--user", "status", "--no-pager", name]);
    default:
      return run("systemctl", ["--user", action, name]);
  }
};

export const daemonCommand = async (parsed: Parsed): Promise<number> => {
  const action = parsed.positionals[1] as Action | undefined;
  const role = (parsed.positionals[2] ?? "server") as DaemonRole;
  if (action === undefined || !ACTIONS.includes(action) || (role !== "server" && role !== "node")) {
    console.error(`usage: spriessen daemon <${ACTIONS.join("|")}> [server|node]`);
    return 1;
  }
  if (process.platform !== "linux" && process.platform !== "darwin") {
    console.error("daemon: only Linux (systemd --user) and macOS (launchd) are supported");
    return 1;
  }
  if (action === "install") return install(unitSpecOf(role, parsed));
  return control(role, action);
};
