#!/usr/bin/env python3
"""The home VM's browser broker: ONE chromium, every bot's session inside it.

Runs as the VM's browser system user (started by root; see broker-install.ts
on the server side). Chromium listens on a private PIPE, never a port, and
the broker's own socket lives in a 0700 folder: only root (the server's
exec) reaches it, so a bot's `bash` can reach neither the broker nor the
browser — every bot act goes through the server's tool and its approval
gate. Each request names the bot whose session it means; the server is the
only caller and it already knows which bot a conversation belongs to.

    broker.py --run DIR --data DIR --version V [--chromium BIN] [--lang L]

Each connection sends one JSON line: an op (one reply line, then the
connection closes) or `cast` (lines both ways until either side ends).
Sessions idle past their window (+2 minutes of slack; the server closes
them first, saving sign-ins) are closed here as a backstop, so a browser
never outlives a server that forgot it.
"""
import argparse
import json
import os
import queue
import signal
import socket
import struct
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cdp import Cdp, CdpError  # noqa: E402
from cast import Cast  # noqa: E402
from ops import run_op  # noqa: E402
from session import Sessions  # noqa: E402

BACKSTOP_SLACK_S = 120.0


def chromium_major(binary):
    try:
        raw = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=15).stdout
    except (OSError, subprocess.SubprocessError):
        return "131"
    for word in raw.split():
        if word[:1].isdigit() and "." in word:
            return word.split(".")[0]
    return "131"


class Broker:
    def __init__(self, args):
        self.args = args
        self.version = args.version
        self.events = queue.Queue()
        self.sessions = Sessions(args.data, args.lang)
        self.cdp = None
        self.start_lock = threading.Lock()
        self.profile = os.path.join(args.data, "profile")
        major = chromium_major(args.chromium)
        # The reduced desktop UA a real Chrome of this major sends: no
        # "HeadlessChrome", nothing a sign-in page would refuse.
        self.default_ua = (
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/%s.0.0.0 Safari/537.36" % major
        )

    # ---- the browser ----

    def ensure_browser(self):
        with self.start_lock:
            if self.cdp is not None and self.cdp.alive:
                return
            # A chromium left behind by an earlier broker holds the profile lock.
            subprocess.run(["pkill", "-f", "--", "--user-data-dir=" + self.profile],
                           capture_output=True, timeout=10)
            os.makedirs(self.profile, exist_ok=True)
            home = os.path.join(self.args.data, "home")
            # Chromium's singleton socket lives under TMPDIR and is capped at
            # 108 bytes: --tmp moves it somewhere short when --data is deep.
            tmp = self.args.tmp or os.path.join(home, "tmp")
            for path in (home, home + "/xdg", tmp):
                os.makedirs(path, exist_ok=True)
            env = dict(os.environ, HOME=home, XDG_RUNTIME_DIR=home + "/xdg", TMPDIR=tmp)
            argv = [
                self.args.chromium, "--headless=new", "--no-sandbox", "--disable-gpu",
                "--disable-dev-shm-usage", "--disable-extensions", "--hide-scrollbars",
                "--no-first-run", "--no-default-browser-check", "--window-size=1280,800",
                "--disable-blink-features=AutomationControlled",
                "--user-agent=" + self.default_ua, "--lang=" + self.args.lang.split(",")[0],
                "--user-data-dir=" + self.profile, "--remote-debugging-pipe", "about:blank",
            ]
            cdp = Cdp(argv, env, os.path.join(self.args.data, "chromium.log"), self.on_event)
            cdp.call("Target.setDiscoverTargets", {"discover": True}, timeout=30.0)
            self.cdp = cdp
            self.sessions.cdp = cdp

    def on_event(self, method, params, session_id):
        self.events.put((method, params, session_id))

    def worker(self):
        while True:
            method, params, session_id = self.events.get()
            try:
                self.handle(method, params, session_id)
            except Exception as cause:  # one bad event never stops the broker
                sys.stderr.write("event %s failed: %s\n" % (method, cause))

    def handle(self, method, params, session_id):
        sessions = self.sessions
        if method == "Broker.browserGone":
            sessions.browser_gone()
        elif method == "Target.targetCreated":
            sessions.on_target_created(params.get("targetInfo") or {})
        elif method == "Target.targetDestroyed":
            sessions.on_target_destroyed(params.get("targetId"))
        elif method == "Target.targetInfoChanged":
            sessions.on_target_info(params.get("targetInfo") or {})
        elif method == "Browser.downloadWillBegin":
            sessions.on_download_begin(params)
        elif method == "Browser.downloadProgress":
            sessions.on_download_progress(params)
        elif session_id is not None:
            sessions.on_page_event(method, params, session_id)

    def reaper(self):
        while True:
            time.sleep(30)
            now = time.time()
            for bot, sess in list(self.sessions.by_bot.items()):
                if not sess.held and now - sess.last_at > sess.idle_s + BACKSTOP_SLACK_S:
                    self.sessions.close(bot)

    # ---- the socket ----

    def allowed(self, conn):
        creds = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        _pid, uid, _gid = struct.unpack("3i", creds)
        return uid in (0, os.getuid())

    def serve_one(self, conn):
        try:
            if not self.allowed(conn):
                return
            reader = conn.makefile("r", encoding="utf-8", newline="\n")
            line = reader.readline()
            try:
                req = json.loads(line)
            except ValueError:
                conn.sendall(b'{"ok":false,"kind":"error","error":"the request is not JSON"}\n')
                return
            if req.get("op") == "ping":
                reply = {"ok": True, "version": self.version, "sessions": len(self.sessions.by_bot)}
                conn.sendall((json.dumps(reply) + "\n").encode())
            elif req.get("op") == "cast":
                self.serve_cast(conn, req, reader)
            else:
                conn.sendall((json.dumps(run_op(self, req)) + "\n").encode())
        except (OSError, CdpError) as cause:
            try:
                conn.sendall((json.dumps({"ok": False, "kind": "error", "error": str(cause)[:200]}) + "\n").encode())
            except OSError:
                pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def serve_cast(self, conn, req, reader):
        sess = self.sessions.get(str(req.get("bot", "")))
        if sess is None:
            conn.sendall(b'{"t":"fatal","error":"this bot has no browser open"}\n')
            return
        Cast(self, sess, req, conn).run(reader)

    def run(self):
        run_dir = self.args.run
        os.makedirs(run_dir, exist_ok=True)
        # Bound by its RELATIVE name inside the run folder: a socket path is
        # capped at 108 bytes, and the folder may sit deeper than that.
        os.chdir(run_dir)
        path = "broker.sock"
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(path)
        os.chmod(path, 0o600)
        server.listen(64)
        with open("broker.pid", "w") as handle:
            handle.write(str(os.getpid()))
        threading.Thread(target=self.worker, name="events", daemon=True).start()
        threading.Thread(target=self.reaper, name="reaper", daemon=True).start()
        while True:
            conn, _ = server.accept()
            threading.Thread(target=self.serve_one, args=(conn,), daemon=True).start()

    def shutdown(self, *_):
        if self.cdp is not None:
            self.cdp.stop()
        os._exit(0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--chromium", default="chromium")
    parser.add_argument("--lang", default="en-US,en")
    parser.add_argument("--tmp", default="")
    broker = Broker(parser.parse_args())
    signal.signal(signal.SIGTERM, broker.shutdown)
    signal.signal(signal.SIGINT, broker.shutdown)
    broker.run()


if __name__ == "__main__":
    main()
