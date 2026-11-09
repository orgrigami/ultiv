/**
 * The in-VM CDP driver for interactive browser sessions: a small python3
 * script (stdlib only — the image ships python3 beside chromium) that speaks
 * the DevTools websocket directly and answers ONE command per run as a JSON
 * line on stdout. Chromium itself runs DETACHED on the VM's loopback port
 * (one per home VM, a shared user-data-dir under /tmp) so the browser and
 * its cookies SURVIVE between calls; each tool call attaches to it, does one
 * thing, and exits. Everything the model receives is words and structure —
 * never cookies, never storage values.
 *
 * Chromium runs with a hermetic HOME/XDG_RUNTIME_DIR/TMPDIR under the
 * profile dir: the backend's exec env points TMPDIR at the bot's $HOME/.tmp,
 * which does not exist until the workspace prepare runs (the browser path
 * never runs it), and chromium ABORTS at launch when its ProcessSingleton
 * socket dir under TMPDIR is missing. The hermetic HOME also keeps
 * chromium's dot-dirs (.config/.cache/.local) out of the workspace, where
 * the sync loop would promote them to artifacts.
 */

import { createHash } from "node:crypto";

/** The VM-loopback port the detached chromium listens on. */
export const CDP_PORT = 9222;
/** One chromium per home VM; its profile (cookies) live here, VM-scoped. */
export const PROFILE_DIR = "/tmp/.spriessen-browser";

export const DRIVER_SOURCE = `#!/usr/bin/env python3
"""One CDP command per run: argv[1] is the JSON command; stdout is one JSON line."""
import base64, json, os, socket, subprocess, sys, time, urllib.error, urllib.request

PORT = ${CDP_PORT}
BASE = "http://127.0.0.1:%d" % PORT
PROFILE = "${PROFILE_DIR}"
DEADLINE = 20.0


def out(payload):
    print(json.dumps(payload))
    sys.exit(0)


def fail(message, kind="error"):
    out({"ok": False, "kind": kind, "error": message})


def up():
    try:
        with urllib.request.urlopen(BASE + "/json/version", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def plain_user_agent():
    """A regular desktop Chrome UA for this chromium's version (no "HeadlessChrome")."""
    version = "131.0.0.0"
    try:
        raw = subprocess.run(
            ["chromium", "--version"], capture_output=True, text=True, timeout=10
        ).stdout
        for word in raw.split():
            if word[:1].isdigit() and word.count(".") == 3:
                version = word
                break
    except Exception:
        pass
    return (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/%s Safari/537.36" % version
    )


# Written beside the profile when a browser launches with the plain identity.
IDENTITY = PROFILE + "/.identity-v1"


def headless_identity():
    """True when the RUNNING browser was launched before the identity fix."""
    return not os.path.exists(IDENTITY)


def ensure_browser():
    if up():
        # A browser launched before the identity fix still says
        # "HeadlessChrome" (sign-in pages refuse it): relaunch it once on the
        # same profile — the cookies are on disk and come back with it.
        if not headless_identity():
            return
        subprocess.run(["pkill", "-f", PROFILE], timeout=10, capture_output=True)
        for _ in range(40):
            if not up():
                break
            time.sleep(0.25)
    os.makedirs(PROFILE, exist_ok=True)
    # Hermetic runtime dirs (see the file header): the bot's TMPDIR may not
    # exist on a fresh VM, and chromium aborts without its singleton-socket
    # dir; a HOME under the profile keeps its dot-dirs out of the workspace.
    home = PROFILE + "/home"
    for d in (home, home + "/xdg", home + "/tmp"):
        os.makedirs(d, exist_ok=True)
    env = dict(os.environ)
    env["HOME"] = home
    env["XDG_RUNTIME_DIR"] = home + "/xdg"
    env["TMPDIR"] = home + "/tmp"
    subprocess.Popen(
        [
            "chromium", "--headless=new", "--no-sandbox", "--disable-gpu",
            "--disable-dev-shm-usage", "--disable-extensions", "--hide-scrollbars",
            "--window-size=1280,1600",
            # Sign-in pages (Google's "this browser or app may not be
            # secure") refuse a browser that announces automation: no
            # navigator.webdriver, no automation infobar switch, and the
            # plain Chrome user agent instead of "HeadlessChrome".
            "--disable-blink-features=AutomationControlled",
            "--user-agent=" + plain_user_agent(),
            "--lang=en-US,en",
            "--user-data-dir=" + PROFILE,
            "--remote-debugging-port=%d" % PORT,
            "about:blank",
        ],
        env=env,
        stdout=open(PROFILE + "/log", "ab"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    open(IDENTITY, "w").close()
    for _ in range(80):
        if up():
            return
        time.sleep(0.25)
    fail("chromium did not start (see " + PROFILE + "/log)", "browser-down")


def page_target():
    """The first page target, created fresh when none exists."""
    with urllib.request.urlopen(BASE + "/json/list", timeout=5) as r:
        targets = json.load(r)
    for t in targets:
        if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
            return t
    req = urllib.request.Request(BASE + "/json/new", method="PUT", data=b"")
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)


class Ws:
    """The slice of the websocket protocol CDP needs (text frames, no TLS)."""

    def __init__(self, url):
        hostport, _, rest = url[5:].partition("/")
        # The debugger url carries "host:port" (or "[v6]:port"); the socket
        # wants the host ALONE — "127.0.0.1:9222" as a host string is treated
        # as a name and getaddrinfo fails with "Name or service not known".
        if hostport.startswith("["):
            host = hostport[1 : hostport.index("]")]
        else:
            host = hostport.partition(":")[0]
        path = "/" + rest
        self.sock = socket.create_connection((host, PORT), timeout=DEADLINE)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            (
                "GET %s HTTP/1.1\\r\\nHost: %s\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n"
                "Sec-WebSocket-Key: %s\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n" % (path, host, key)
            ).encode(),
        )
        buf = b""
        while b"\\r\\n\\r\\n" not in buf:
            chunk = self.sock.recv(1)
            if not chunk:
                raise IOError("websocket handshake failed")
            buf += chunk
        if b" 101 " not in buf.split(b"\\r\\n", 1)[0]:
            raise IOError("websocket refused")

    def send(self, text):
        data = text.encode()
        head = bytearray([0x81])
        n = len(data)
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126)
            head += n.to_bytes(2, "big")
        else:
            head.append(0x80 | 127)
            head += n.to_bytes(8, "big")
        mask = os.urandom(4)
        head += mask
        self.sock.sendall(bytes(head) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _read(self, want):
        buf = b""
        while len(buf) < want:
            chunk = self.sock.recv(want - len(buf))
            if not chunk:
                raise IOError("websocket closed")
            buf += chunk
        return buf

    def recv(self):
        """One full message; pings are answered, close raises."""
        payload = b""
        while True:
            head = self._read(2)
            fin, opcode = head[0] & 0x80, head[1] & 0x0F
            n = head[1] & 0x7F
            if n == 126:
                n = int.from_bytes(self._read(2), "big")
            elif n == 127:
                n = int.from_bytes(self._read(8), "big")
            masked = head[1] & 0x80
            mask = self._read(4) if masked else None
            data = self._read(n)
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if opcode == 8:
                raise IOError("websocket closed by peer")
            if opcode == 9:
                self.sock.sendall(bytes([0x8A, 0x80, 0, 0, 0, 0]))
                continue
            payload += data
            if fin:
                return payload.decode("utf-8", "replace")


class Tab:
    def __init__(self):
        target = page_target()
        self.id = target["id"]
        self.ws = Ws(target["webSocketDebuggerUrl"])
        self.seq = 0

    def call(self, method, params=None):
        self.seq += 1
        rid = self.seq
        self.ws.send(json.dumps({"id": rid, "method": method, "params": params or {}}))
        deadline = time.time() + DEADLINE
        while time.time() < deadline:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == rid:
                if "error" in msg:
                    raise IOError("%s: %s" % (method, msg["error"].get("message", "")))
                return msg.get("result", {})
        raise IOError("%s timed out" % method)

    def evaluate(self, expression, await_promise=False):
        result = self.call(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": await_promise},
        )
        if "exceptionDetails" in result:
            detail = result["exceptionDetails"].get("exception", {}).get("description", "")
            raise IOError((detail or "the page rejected the script")[:300])
        return result.get("result", {}).get("value")


def wait_ready(tab, seconds=15.0):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            if tab.evaluate("document.readyState") in ("complete", "interactive"):
                return True
        except Exception:
            pass
        time.sleep(0.3)
    return False


def page_facts(tab):
    return tab.evaluate(
        "JSON.stringify({url: location.href, title: document.title,"
        " text: (document.body ? document.body.innerText : '').slice(0, 12000)})"
    )


def main():
    if len(sys.argv) < 2:
        fail("usage: driver '<json command>' (or import for the cast)")
    try:
        command = json.loads(sys.argv[1])
    except Exception:
        fail("the command is not JSON")
    op = command.get("op")
    try:
        if op == "close":
            subprocess.run(["pkill", "-f", PROFILE], timeout=10, capture_output=True)
            out({"ok": True, "closed": True})
        ensure_browser()
        tab = Tab()
        if op == "open":
            url = command.get("url", "about:blank")
            tab.call("Page.enable")
            nav = tab.call("Page.navigate", {"url": url})
            if "errorText" in nav and nav["errorText"]:
                fail("the page did not load (%s)" % nav["errorText"], "load")
            wait_ready(tab)
            out(dict({"ok": True}, **json.loads(page_facts(tab))))
        if op == "read":
            selector = command.get("selector")
            if selector:
                text = tab.evaluate(
                    "(document.querySelector(%r) || {innerText: null}).innerText"
                    % selector
                )
                if text is None:
                    fail("no element matches %r" % selector, "selector")
                out({"ok": True, "selector": selector, "text": str(text)[:12000]})
            out(dict({"ok": True}, **json.loads(page_facts(tab))))
        if op == "click":
            selector = command.get("selector", "")
            found = tab.evaluate(
                "(() => { const el = document.querySelector(%r);"
                " if (!el) return 'missing'; el.scrollIntoView({block: 'center'}); el.click();"
                " return 'ok'; })()" % selector
            )
            if found != "ok":
                fail("no element matches %r" % selector, "selector")
            time.sleep(0.6)
            wait_ready(tab, 8.0)
            out(dict({"ok": True}, **json.loads(page_facts(tab))))
        if op == "type":
            selector, text = command.get("selector", ""), command.get("text", "")
            kind = tab.evaluate(
                "(document.querySelector(%r) || {type: 'missing'}).type" % selector
            )
            if kind == "missing":
                fail("no element matches %r" % selector, "selector")
            if kind == "password":
                fail(
                    "that field is a password field: saved logins are not wired into the browser;"
                    " ask your owner to sign in (browser takeover) or to add the credential's"
                    " binding",
                    "password",
                )
            done = tab.evaluate(
                "(() => { const el = document.querySelector(%r); el.focus();"
                " el.value = %s; el.dispatchEvent(new Event('input', {bubbles: true}));"
                " el.dispatchEvent(new Event('change', {bubbles: true})); return 'ok'; })()"
                % (selector, json.dumps(text))
            )
            out({"ok": True, "filled": selector})
        if op == "press":
            key = command.get("key", "Enter")
            tab.evaluate(
                "(() => { const el = document.activeElement;"
                " for (const type of ['keydown', 'keyup'])"
                "  el.dispatchEvent(new KeyboardEvent(type, {key: %s, bubbles: true}));"
                " if (%s && el.form) el.form.requestSubmit(); return true; })()"
                % (json.dumps(key), "true" if key == "Enter" else "false")
            )
            time.sleep(0.6)
            wait_ready(tab, 8.0)
            out(dict({"ok": True}, **json.loads(page_facts(tab))))
        if op == "shot":
            result = tab.call("Page.captureScreenshot", {"format": "png"})
            out({"ok": True, "png": result.get("data", "")})
        fail("unknown op %r" % op)
    except IOError as cause:
        fail(str(cause))
    except Exception as cause:
        fail("%s: %s" % (type(cause).__name__, cause))


if __name__ == "__main__":
    main()
`;

/**
 * Where the driver lives inside the VM (outside the wiped workspace). The
 * name carries a hash of the source: the install step writes only a MISSING
 * file, so a fixed driver must land at a new path or a long-lived VM keeps
 * running the old one for its whole life.
 */
export const DRIVER_PATH = `/tmp/.spriessen-cdp-${createHash("sha256").update(DRIVER_SOURCE).digest("hex").slice(0, 12)}.py`;

/** Install the driver once per VM (idempotent), then run one command. */
export const driverCallScript = (command: string): string =>
  [
    "if ! command -v python3 >/dev/null 2>&1; then",
    '  echo \'{"ok":false,"kind":"no-python","error":"the VM image has no python3"}\'; exit 0; fi',
    `if [ ! -f ${DRIVER_PATH} ] || [ "$(wc -c < ${DRIVER_PATH})" -lt 1000 ]; then`,
    `  cat > ${DRIVER_PATH} <<'__SPRIESSEN_CDP__'`,
    DRIVER_SOURCE,
    "__SPRIESSEN_CDP__",
    "fi",
    `python3 ${DRIVER_PATH} '${command.replaceAll("'", `'\\''`)}'`,
  ].join("\n");
