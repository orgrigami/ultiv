/**
 * The browser broker inside a home VM (browser/vm/*.py): one chromium per
 * VM, every bot's session a private context in it, reachable ONLY by root —
 * the server's exec — never by a bot's `bash`. This file builds the root
 * scripts that install the broker (read-only to bots, under a folder named
 * by its version so a fixed broker never hides behind an old copy), start
 * it as the VM's browser user, and talk to it. The VM image ships the
 * browser user and chromium; the broker itself is written at its first use,
 * so a VM never waits for an image rebuild to get a fixed broker.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** The broker's Python modules, shipped beside this file. */
const MODULES = ["cdp.py", "pages.py", "session.py", "ops.py", "cast.py", "broker.py", "client.py"];

const SOURCES: readonly { readonly name: string; readonly text: string }[] = MODULES.map(
  (name) => ({ name, text: readFileSync(new URL(`./vm/${name}`, import.meta.url), "utf8") }),
);

/** The broker's version: a hash of every module (a fixed broker restarts). */
export const BROKER_VERSION = createHash("sha256")
  .update(SOURCES.map((source) => `${source.name}\n${source.text}`).join("\n"))
  .digest("hex")
  .slice(0, 12);

/** Where the broker lives and works inside the VM. */
export interface BrokerPaths {
  /** Read-only install root; the version folder goes under it. */
  readonly install: string;
  /** The 0700 socket folder (only root and the broker reach it). */
  readonly run: string;
  /** The browser user's own folder: the profile, staging, the log. */
  readonly data: string;
  /** The browser system user (null: run as whoever starts it — tests). */
  readonly user: string | null;
  /** Chromium's binary. */
  readonly chromium: string;
  /** A short TMPDIR for chromium's singleton socket (empty: under data). */
  readonly tmp: string;
}

export const VM_BROKER_PATHS: BrokerPaths = {
  install: "/opt/spriessen-browser",
  run: "/run/spriessen-browser",
  data: "/var/lib/spriessen-browser",
  user: "spbrowser",
  chromium: "chromium",
  tmp: "",
};

const quoted = (value: string): string => {
  if (value.includes("'")) throw new Error(`a broker path may not hold a quote: ${value}`);
  return `'${value}'`;
};

const dirOf = (paths: BrokerPaths): string => `${paths.install}/${BROKER_VERSION}`;

const client = (paths: BrokerPaths): string =>
  `python3 ${quoted(`${dirOf(paths)}/client.py`)} --run ${quoted(paths.run)}`;

const DOWN = (reason: string): string =>
  `echo '{"ok":false,"kind":"broker-down","error":"${reason}"}'`;

/** Write the modules into the version folder once (atomically, by rename). */
const installLines = (paths: BrokerPaths): string[] => {
  const dir = quoted(dirOf(paths));
  const fresh = quoted(`${dirOf(paths)}.new`);
  const lines = [
    `if [ ! -f ${quoted(`${dirOf(paths)}/broker.py`)} ]; then`,
    `  rm -rf ${fresh} && mkdir -p ${fresh}`,
  ];
  for (const source of SOURCES) {
    if (source.text.includes("__SP_PY_EOF__")) throw new Error("a broker module holds the marker");
    lines.push(`  cat > ${quoted(`${dirOf(paths)}.new/${source.name}`)} <<'__SP_PY_EOF__'`);
    lines.push(source.text.replace(/\n$/, ""), "__SP_PY_EOF__");
  }
  lines.push(`  chmod 755 ${fresh} && chmod 644 ${fresh}/*.py && mv ${fresh} ${dir}`, "fi");
  return lines;
};

/**
 * Install (once) and start the broker unless the right version already
 * answers; prints one JSON line. Serialized by a lock, so two first calls
 * never start two brokers. Also retires the pre-broker browser (one
 * chromium on a debug port, owned by whichever bot started it).
 */
export const brokerStartScript = (paths: BrokerPaths): string => {
  const run = quoted(paths.run);
  const data = quoted(paths.data);
  const asUser = paths.user;
  const tmp = paths.tmp === "" ? "" : ` --tmp ${quoted(paths.tmp)}`;
  return [
    "set -u",
    `mkdir -p ${quoted(paths.install)} ${run} ${data}`,
    `exec 9>${quoted(`${paths.install}/.start.lock`)}`,
    `flock -w 60 9 || { ${DOWN("the browser broker is still starting")}; exit 0; }`,
    ...installLines(paths),
    `if ${client(paths)} ping ${BROKER_VERSION} >/dev/null 2>&1; then echo '{"ok":true,"started":false}'; exit 0; fi`,
    `if [ -f ${run}/broker.pid ]; then kill "$(cat ${run}/broker.pid)" 2>/dev/null; sleep 1; fi`,
    // The bracket keeps this script's own command line from matching.
    "pkill -f -- '--user-data-dir=/tmp/[.]spriessen-browser( |$)' 2>/dev/null",
    'RUNAS=""',
    ...(asUser === null
      ? []
      : [
          'if [ "$(id -u)" = 0 ]; then',
          `  id ${asUser} >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ${asUser}`,
          `  chown ${asUser}:${asUser} ${run} ${data} && chmod 700 ${run} ${data}`,
          `  RUNAS="runuser -u ${asUser} --"`,
          "fi",
        ]),
    `setsid $RUNAS python3 ${quoted(`${dirOf(paths)}/broker.py`)} --run ${run} --data ${data} --version ${BROKER_VERSION} --chromium ${quoted(paths.chromium)}${tmp} </dev/null >>${quoted(`${paths.data}/broker.log`)} 2>&1 &`,
    "for _ in $(seq 1 240); do",
    `  if ${client(paths)} ping ${BROKER_VERSION} >/dev/null 2>&1; then echo '{"ok":true,"started":true}'; exit 0; fi`,
    "  sleep 0.25",
    "done",
    `${DOWN("the browser broker did not start")}`,
  ].join("\n");
};

/** One op: the request rides a heredoc (one JSON line), the reply is one line. */
export const brokerCallScript = (paths: BrokerPaths, request: unknown): string => {
  const line = JSON.stringify(request);
  return [`${client(paths)} call <<'__SP_REQ_EOF__'`, line, "__SP_REQ_EOF__"].join("\n");
};

/** One op whose request is written to stdin (large payloads, secrets). */
export const brokerStdinCallScript = (paths: BrokerPaths): string => `exec ${client(paths)} call`;

/** The cast: first stdin line is the request, then lines both ways. */
export const brokerRelayScript = (paths: BrokerPaths): string => `exec ${client(paths)} relay`;
