/**
 * The in-VM CAST half of the browser takeover: one long-lived python3
 * process that reuses the base driver (browser/driver.ts) as a library —
 * exec'd with a foreign __name__ so its one-shot main() never runs — and
 * then runs a LIVE channel over the same CDP websocket:
 *
 *   stdout: one JSON line per event — `ready`, `frame` (a screencast JPEG
 *     plus the metadata that maps its pixels back to page coordinates),
 *     `error` (an act failed; the cast continues), `fatal` (startup died).
 *   stdin: one JSON line per owner act — tap / type / key / scroll / nav /
 *     reload / stop — dispatched as REAL Input.* events, the same trusted
 *  	input stream a physical keyboard and mouse produce.
 *
 * The viewport is pinned (Emulation.setDeviceMetricsOverride 1280x800, dsf
 * 1) so frame pixels and CSS pixels map 1:1 apart from chromium's own
 * maxWidth/maxHeight fit; the mapping math keeps the general case correct.
 * Frames are JPEG q55 — a page repaint, not a video: chromium only sends a
 * frame when the view actually changes. Every act is followed by a forced
 * frame (captureScreenshot on the live scroll) so the owner always sees the
 * effect of what they did, even when the page itself did not repaint.
 */
import { DRIVER_PATH, DRIVER_SOURCE } from "./driver.ts";

/** Where the cast script lives inside the VM. */
export const CAST_PATH = "/tmp/.spriessen-cast.py";
/** The pinned cast viewport (CSS px == frame px at dsf 1). */
export const CAST_VIEW = { width: 1280, height: 800 } as const;
/** One cast may outlive a long takeover, but not the afternoon. */
export const CAST_TIMEOUT_MS = 30 * 60_000;

export const CAST_SOURCE = `#!/usr/bin/env python3
import base64, json, select, sys, time

BASE = "${DRIVER_PATH}"
ns = {"__name__": "spriessen-base"}
exec(compile(open(BASE).read(), BASE, "exec"), ns)

VIEW_W, VIEW_H = ${CAST_VIEW.width}, ${CAST_VIEW.height}
FRAMES_KEPT = 8
FACTS_EVERY = 1.0
KEYCODES = {
    "Enter": 13, "Tab": 9, "Backspace": 8, "Delete": 46, "Escape": 27,
    "ArrowLeft": 37, "ArrowUp": 38, "ArrowRight": 39, "ArrowDown": 40,
    "Home": 36, "End": 35, "PageUp": 33, "PageDown": 34,
}
# Keys whose press must produce its text for the page's default behaviour.
KEYTEXT = {"Enter": "\\r", "Tab": "\\t"}


def emit(payload):
    print(json.dumps(payload))
    sys.stdout.flush()


def image_size(raw):
    """(width, height) of the frame CDP handed us: JPEG SOF or PNG IHDR."""
    if raw[:8] == b"\\x89PNG\\r\\n\\x1a\\n" and len(raw) >= 24:
        return int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
    i = 2
    while i + 9 < len(raw):
        if raw[i] != 0xFF:
            i += 1
            continue
        marker = raw[i + 1]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                      0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            return int.from_bytes(raw[i + 7:i + 9], "big"), int.from_bytes(raw[i + 5:i + 7], "big")
        if marker == 0xD8 or marker == 0x01 or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        i += 2 + int.from_bytes(raw[i + 2:i + 4], "big")
    return None


class CastTab(ns["Tab"]):
    """The base Tab, but CDP EVENTS seen while a call waits are QUEUED,
    never handled inline: handling them inline (ack a screencast frame from
    inside another call's wait loop) nests calls, and a nested call can
    swallow the outer call's response id — the dropped response times out,
    the ack never lands, and the compositor stalls the whole renderer. The
    main loop drains the queue between its own calls."""

    def __init__(self):
        ns["Tab"].__init__(self)
        self.events = []
        # select() gates reads; a quiet page must not trip the socket timeout.
        self.ws.sock.settimeout(None)

    def call(self, method, params=None):
        self.seq += 1
        rid = self.seq
        self.ws.send(json.dumps({"id": rid, "method": method, "params": params or {}}))
        deadline = time.time() + 20.0
        while time.time() < deadline:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == rid:
                if "error" in msg:
                    raise IOError("%s: %s" % (method, msg["error"].get("message", "")))
                return msg.get("result", {})
            if msg.get("method"):
                self.events.append(msg)
        raise IOError("%s timed out" % method)


class Cast:
    def __init__(self):
        ns["ensure_browser"]()
        self.tab = CastTab()
        self.facts = {}
        self.facts_at = 0.0
        self.frames = {}
        self.order = []
        self.seq = 0

    # ---- facts (url/title), throttled ----

    def refresh_facts(self):
        try:
            got = self.tab.evaluate(
                "JSON.stringify({url: location.href, title: document.title})"
            )
            self.facts = json.loads(got)
            self.facts_at = time.time()
        except Exception:
            pass  # mid-navigation: the previous facts stand until it settles

    def maybe_facts(self):
        if time.time() - self.facts_at > FACTS_EVERY:
            self.refresh_facts()
        return self.facts

    # ---- frames ----

    def remember(self, meta):
        self.seq += 1
        fid = "f%d" % self.seq
        self.frames[fid] = meta
        self.order.append(fid)
        while len(self.order) > FRAMES_KEPT:
            self.frames.pop(self.order.pop(0), None)
        return fid

    def frame_line(self, data, size, sx, sy):
        meta = {"sx": sx, "sy": sy, "ps": 1.0, "ot": 0, "dw": size[0], "iw": size[0]}
        fid = self.remember(meta)
        line = {"t": "frame", "id": fid, "data": data, "w": size[0], "h": size[1]}
        line.update(self.maybe_facts())
        emit(line)

    def on_screencast(self, params):
        meta = params.get("metadata") or {}
        try:
            self.tab.call("Page.screencastFrameAck", {"sessionId": params.get("sessionId")})
        except Exception:
            pass
        raw = base64.b64decode(params.get("data", ""))
        size = image_size(raw) or (meta.get("deviceWidth") or VIEW_W, meta.get("deviceHeight") or VIEW_H)
        cast_meta = {
            "sx": meta.get("scrollOffsetX") or 0,
            "sy": meta.get("scrollOffsetY") or 0,
            "ps": meta.get("pageScaleFactor") or 1.0,
            "ot": meta.get("offsetTop") or 0,
            "dw": meta.get("deviceWidth") or size[0],
            "iw": size[0],
        }
        fid = self.remember(cast_meta)
        line = {
            "t": "frame", "id": fid, "data": params.get("data", ""),
            "w": size[0], "h": size[1],
        }
        line.update(self.maybe_facts())
        emit(line)

    def event(self, msg):
        method = msg.get("method")
        if method == "Page.screencastFrame":
            self.on_screencast(msg.get("params") or {})
        elif method == "Page.frameNavigated":
            frame = (msg.get("params") or {}).get("frame") or {}
            if frame.get("parentId") is None:
                self.refresh_facts()

    def nudge(self):
        """Force a frame after an act, on the CURRENT scroll position."""
        try:
            sx, sy = self.live_scroll()
            shot = self.tab.call(
                "Page.captureScreenshot", {"format": "jpeg", "quality": 55}
            )
            raw = base64.b64decode(shot.get("data", ""))
            size = image_size(raw) or (VIEW_W, VIEW_H)
            self.frame_line(shot.get("data", ""), size, sx, sy)
        except Exception:
            pass  # the page will repaint on its own or the next act will

    # ---- coordinates ----

    def live_scroll(self):
        try:
            got = self.tab.evaluate("[window.scrollX || 0, window.scrollY || 0]")
            return got[0], got[1]
        except Exception:
            return 0, 0

    def viewport_xy(self, meta, x, y):
        ps = meta.get("ps", 1.0) or 1.0
        iw = meta.get("iw") or VIEW_W
        dw = meta.get("dw") or VIEW_W
        k = (iw / (dw * ps)) if dw and ps else 1.0
        page_x = (meta.get("sx") or 0) + x / k
        page_y = (meta.get("sy") or 0) + (y - (meta.get("ot") or 0)) / k
        now_x, now_y = self.live_scroll()
        vx = max(0, min(VIEW_W - 1, int(round(page_x - now_x))))
        vy = max(0, min(VIEW_H - 1, int(round(page_y - now_y))))
        return vx, vy

    def meta_for(self, fid):
        if fid and fid in self.frames:
            return self.frames[fid]
        if self.order:
            return self.frames[self.order[-1]]
        return {}

    # ---- acts ----

    def act(self, act):
        kind = act.get("a")
        if kind == "tap":
            meta = self.meta_for(act.get("id"))
            vx, vy = self.viewport_xy(meta, act.get("x", 0), act.get("y", 0))
            for type_ in ("mouseMoved", "mousePressed", "mouseReleased"):
                self.tab.call(
                    "Input.dispatchMouseEvent",
                    {"type": type_, "x": vx, "y": vy, "button": "left", "clickCount": 1},
                )
        elif kind == "type":
            self.tab.call("Input.insertText", {"text": act.get("text", "")})
        elif kind == "key":
            key = act.get("key", "Enter")
            code = KEYCODES.get(key) or (ord(key[0].upper()) if len(key) == 1 else 0)
            # A key whose default action matters (Enter submits, Tab moves)
            # must carry its text — a bare rawKeyDown fires no default.
            text = KEYTEXT.get(key, "")
            common = {"key": key, "windowsVirtualKeyCode": code, "nativeVirtualKeyCode": code}
            if text:
                common["text"] = text
            self.tab.call(
                "Input.dispatchKeyEvent",
                dict(common, type="keyDown" if text else "rawKeyDown"),
            )
            self.tab.call("Input.dispatchKeyEvent", dict(common, type="keyUp"))
        elif kind == "scroll":
            self.tab.call(
                "Input.dispatchMouseEvent",
                {
                    "type": "mouseWheel",
                    "x": act.get("x", VIEW_W // 2),
                    "y": act.get("y", VIEW_H // 2),
                    "deltaX": act.get("dx", 0),
                    "deltaY": act.get("dy", 0),
                },
            )
        elif kind == "nav":
            self.tab.call("Page.navigate", {"url": act.get("url", "about:blank")})
        elif kind == "reload":
            self.tab.call("Page.reload", {})
        else:
            emit({"t": "error", "error": "unknown act %r" % kind})
            return
        self.nudge()

    # ---- lifecycle ----

    def start(self):
        self.tab.call("Page.enable")
        self.tab.call(
            "Emulation.setDeviceMetricsOverride",
            {"width": VIEW_W, "height": VIEW_H, "deviceScaleFactor": 1, "mobile": False},
        )
        self.refresh_facts()
        self.tab.call(
            "Page.startScreencast",
            {
                "format": "jpeg",
                "quality": 55,
                "maxWidth": VIEW_W,
                "maxHeight": VIEW_H,
                "everyNthFrame": 1,
            },
        )
        emit({"t": "ready", "w": VIEW_W, "h": VIEW_H})

    def run(self):
        sock = self.tab.ws.sock
        while True:
            # Events queued while a call waited are handled BETWEEN calls —
            # see CastTab: never inside a call's wait loop.
            while self.tab.events:
                self.event(self.tab.events.pop(0))
            readable, _, _ = select.select([sock, sys.stdin], [], [], 15.0)
            if sock in readable:
                msg = json.loads(self.tab.ws.recv())
                if msg.get("method"):
                    self.event(msg)
            if sys.stdin in readable:
                line = sys.stdin.readline()
                if line.strip() == "":
                    return  # EOF: the server stopped the cast
                try:
                    act = json.loads(line)
                except ValueError:
                    emit({"t": "error", "error": "the act is not JSON"})
                    continue
                if act.get("a") == "stop":
                    return
                try:
                    self.act(act)
                except Exception as cause:
                    emit({"t": "error", "error": str(cause)[:200]})

    def close(self):
        for method, params in (
            ("Page.stopScreencast", {}),
            ("Emulation.clearDeviceMetricsOverride", {}),
        ):
            try:
                self.tab.call(method, params)
            except Exception:
                pass


def main():
    cast = None
    try:
        cast = Cast()
        cast.start()
        cast.run()
    except SystemExit:
        raise
    except Exception as cause:
        emit({"t": "fatal", "error": "%s: %s" % (type(cause).__name__, cause)})
    finally:
        if cast is not None:
            cast.close()


if __name__ == "__main__":
    main()
`;

/**
 * Install (or refresh) the base driver when it predates the __main__ guard,
 * write the cast script, and run it — one long-lived process whose stdio is
 * the cast channel. The base rewrite is guarded so a VM still carrying the
 * old one-shot-only driver gets the importable version before the cast
 * exec()s it.
 */
export const castLaunchScript = (): string =>
  [
    "if ! command -v python3 >/dev/null 2>&1; then",
    `  echo '{"t":"fatal","error":"the VM image has no python3"}'; exit 0; fi`,
    `if [ ! -f ${DRIVER_PATH} ] || [ "$(wc -c < ${DRIVER_PATH})" -lt 1000 ] || ! grep -q '__main__' ${DRIVER_PATH}; then`,
    "  cat > " + DRIVER_PATH + " <<'__SPRIESSEN_CDP__'",
    DRIVER_SOURCE,
    "__SPRIESSEN_CDP__",
    "fi",
    `cat > ${CAST_PATH} <<'__SPRIESSEN_CAST__'`,
    CAST_SOURCE,
    "__SPRIESSEN_CAST__",
    `exec python3 ${CAST_PATH}`,
  ].join("\n");
