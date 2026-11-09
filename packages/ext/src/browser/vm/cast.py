"""The live cast over one bot's session: frames out, the owner's acts in.

One cast per viewer connection (the server fans one cast out to all its
viewers). Frames are chromium's screencast, sized to what the viewer shows
(`size`), and BACKPRESSURED: the socket writer holds only the newest frame,
so a slow link gets fewer, fresher frames instead of a growing delay.
Events (a dialog, a file chooser, a finished download, a popup) are never
dropped. A WATCH cast only streams; a DRIVE cast (an open takeover) also
pins the viewport (default 1280x800, or the owner's screen) and takes acts
as REAL input. When the page did not repaint after an act, one screenshot
stands in so the owner always sees what they did.
"""
import base64
import json
import threading
import time

from cdp import CdpError
from ops import stage_upload, upload_into, UPLOAD_CAP
from pages import DialogOpen, Missing

QUALITY = 60
FRAMES_KEPT = 8
DEFAULT_VIEWPORT = (1280, 800, False)


def clamp(value, low, high, default):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def image_size(raw):
    """(width, height) of a JPEG (SOF marker) or PNG (IHDR) from its first bytes."""
    if raw[:8] == b"\x89PNG\r\n\x1a\n" and len(raw) >= 24:
        return int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
    i = 2
    while i + 9 < len(raw):
        if raw[i] != 0xFF:
            i += 1
            continue
        marker = raw[i + 1]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            return int.from_bytes(raw[i + 7:i + 9], "big"), int.from_bytes(raw[i + 5:i + 7], "big")
        if marker == 0xD8 or marker == 0x01 or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        i += 2 + int.from_bytes(raw[i + 2:i + 4], "big")
    return None


class Writer:
    """The socket's one writer: events in order, frames newest-only."""

    def __init__(self, conn):
        self.conn = conn
        self.cond = threading.Condition()
        self.queue = []
        self.frame = None
        self.closed = False
        threading.Thread(target=self.run, name="cast-writer", daemon=True).start()

    def put(self, payload, frame=False):
        line = (json.dumps(payload) + "\n").encode()
        with self.cond:
            if frame:
                self.frame = line
            else:
                self.queue.append(line)
            self.cond.notify()

    def close(self):
        with self.cond:
            self.closed = True
            self.cond.notify()

    def run(self):
        while True:
            with self.cond:
                while not (self.queue or self.frame or self.closed):
                    self.cond.wait()
                lines = self.queue + ([self.frame] if self.frame else [])
                self.queue, self.frame = [], None
                done = self.closed
            try:
                for line in lines:
                    self.conn.sendall(line)
            except OSError:
                done = True
            if done:
                try:
                    self.conn.shutdown(2)
                except OSError:
                    pass
                return


class Cast:
    def __init__(self, broker, sess, req, conn):
        self.broker = broker
        self.sess = sess
        self.drive = bool(req.get("drive"))
        self.size = (clamp(req.get("w"), 320, 2560, 1280), clamp(req.get("h"), 240, 1600, 800))
        self.viewport = DEFAULT_VIEWPORT if self.drive else None
        self.page = None
        self.frames = {}
        self.order = []
        self.seq = 0
        self.frame_count = 0
        self.lock = threading.RLock()
        self.writer = Writer(conn)

    def emit(self, payload):
        self.writer.put(payload)

    # ---- page and screencast ----

    def start_screencast(self, page):
        if self.drive and self.viewport is not None:
            w, h, mobile = self.viewport
            page.call(
                "Emulation.setDeviceMetricsOverride",
                {"width": w, "height": h, "deviceScaleFactor": 1, "mobile": mobile},
            )
        page.call(
            "Page.startScreencast",
            {"format": "jpeg", "quality": QUALITY, "maxWidth": self.size[0],
             "maxHeight": self.size[1], "everyNthFrame": 1},
        )

    def stop_screencast(self, page, unpin):
        for method in ("Page.stopScreencast",) + (("Emulation.clearDeviceMetricsOverride",) if unpin else ()):
            try:
                page.call(method, {}, 5.0)
            except CdpError:
                pass

    def switch(self, page):
        with self.lock:
            if page is self.page:
                return
            if self.page is not None and not self.sess.closed:
                self.stop_screencast(self.page, self.drive)
            self.page = page
            if page is None:
                return
            try:
                self.start_screencast(page)
            except CdpError as cause:
                self.emit({"t": "error", "error": str(cause)[:200]})
            self.emit({"t": "page", "popup": page.popup, "url": page.url, "title": page.title})

    def restart(self):
        with self.lock:
            if self.page is None:
                return
            self.stop_screencast(self.page, False)
            self.start_screencast(self.page)

    # ---- events (the broker's worker thread) ----

    def on_event(self, event):
        kind = event.get("t")
        if kind == "_frame":
            self.on_frame(event["page"], event["params"])
        elif kind == "page":
            self.switch(self.sess.active())
        elif kind == "closed":
            self.emit({"t": "closed", "reason": event.get("reason", "the browser closed")})
            self.writer.close()
        else:
            self.emit(event)

    def remember(self, meta):
        self.seq += 1
        fid = "f%d" % self.seq
        self.frames[fid] = meta
        self.order.append(fid)
        while len(self.order) > FRAMES_KEPT:
            self.frames.pop(self.order.pop(0), None)
        return fid

    def send_frame(self, page, data, meta):
        fid = self.remember(meta)
        self.frame_count += 1
        self.writer.put(
            {"t": "frame", "id": fid, "data": data, "w": meta["iw"], "h": meta["ih"],
             "url": page.url, "title": page.title, "popup": page.popup},
            frame=True,
        )

    def on_frame(self, page, params):
        try:
            page.call("Page.screencastFrameAck", {"sessionId": params.get("sessionId")}, 5.0)
        except CdpError:
            pass
        if page is not self.page:
            return
        data = params.get("data", "")
        meta = params.get("metadata") or {}
        size = image_size(base64.b64decode(data[:8192])) or (self.size[0], self.size[1])
        self.send_frame(page, data, {
            "iw": size[0], "ih": size[1],
            "dw": meta.get("deviceWidth") or size[0], "dh": meta.get("deviceHeight") or size[1],
            "ot": meta.get("offsetTop") or 0,
        })

    # ---- acts (this connection's reader thread) ----

    def point(self, act):
        meta = self.frames.get(act.get("id")) or (self.frames[self.order[-1]] if self.order else {})
        iw, ih = meta.get("iw") or 1, meta.get("ih") or 1
        x = float(act.get("x", 0)) * (meta.get("dw") or iw) / iw
        y = float(act.get("y", 0)) * (meta.get("dh") or ih) / ih - (meta.get("ot") or 0)
        return max(0.0, x), max(0.0, y)

    def nudge(self, before):
        deadline = time.time() + 0.35
        while time.time() < deadline:
            if self.frame_count != before:
                return
            time.sleep(0.05)
        page = self.page
        if page is None or page.dialog is not None:
            return
        try:
            data = page.screenshot("jpeg", QUALITY)
        except CdpError:
            return
        size = image_size(base64.b64decode(data[:8192])) or self.size
        self.send_frame(page, data, {"iw": size[0], "ih": size[1], "dw": size[0], "dh": size[1], "ot": 0})

    def take_download(self, act):
        got = self.broker.sessions.take_download(self.sess, str(act.get("guid", "")))
        if got is None:
            self.emit({"t": "error", "error": "that download is not ready"})
            return
        self.emit({"t": "download-data", "guid": act.get("guid"), "name": got["name"],
                   "url": got["url"], "data": base64.b64encode(got["data"]).decode()})

    def act(self, act):
        kind = act.get("a")
        if kind == "size":
            self.size = (clamp(act.get("w"), 320, 2560, 1280), clamp(act.get("h"), 240, 1600, 800))
            self.restart()
            return
        if kind == "take_download":
            self.take_download(act)
            return
        if not self.drive:
            self.emit({"t": "error", "error": "watching never touches the page"})
            return
        with self.lock:
            page = self.page
            if page is None:
                return
            self.sess.touch(act=True)
            before = self.frame_count
            self.drive_act(page, kind, act)
        if kind not in ("move", "hover", "viewport"):
            self.nudge(before)

    def drive_act(self, page, kind, act):
        if kind == "tap":
            x, y = self.point(act)
            page.click_at(x, y, clicks=clamp(act.get("count"), 1, 3, 1))
        elif kind in ("down", "move", "up", "hover"):
            x, y = self.point(act)
            if kind == "down":
                page.mouse("mouseMoved", x, y, "none", 0)
                page.mouse("mousePressed", x, y, "left", 1, 1)
            elif kind == "up":
                page.mouse("mouseReleased", x, y, "left", 1, 0)
            else:
                held = kind == "move" and bool(act.get("held"))
                page.mouse("mouseMoved", x, y, "left" if held else "none", 0, 1 if held else 0)
        elif kind == "type":
            page.insert_text(str(act.get("text", ""))[:5000])
        elif kind == "key":
            page.press(str(act.get("key") or "Enter"))
        elif kind == "scroll":
            x, y = self.point(act) if "x" in act else (self.size[0] / 2, self.size[1] / 2)
            page.call("Input.dispatchMouseEvent", {
                "type": "mouseWheel", "x": x, "y": y,
                "deltaX": float(act.get("dx", 0)), "deltaY": float(act.get("dy", 0)),
            })
        elif kind == "nav":
            page.call("Page.navigate", {"url": str(act.get("url") or "about:blank")})
        elif kind == "reload":
            page.call("Page.reload", {})
        elif kind == "back":
            page.evaluate("history.back(), true")
        elif kind == "dialog":
            self.answer_dialog(act)
        elif kind == "upload":
            self.upload(page, act)
        elif kind == "viewport":
            self.viewport = (
                clamp(act.get("w"), 320, 1920, 1280), clamp(act.get("h"), 320, 1600, 800),
                bool(act.get("mobile")),
            )
            self.restart()
        else:
            self.emit({"t": "error", "error": "unknown act %r" % kind})

    def answer_dialog(self, act):
        target = next((p for p in reversed(self.sess.pages()) if p.dialog is not None), None)
        if target is None:
            return
        params = {"accept": bool(act.get("accept", True))}
        if act.get("text") is not None:
            params["promptText"] = str(act.get("text"))[:2000]
        target.call("Page.handleJavaScriptDialog", params)
        target.dialog = None

    def upload(self, page, act):
        data = base64.b64decode(str(act.get("data", "")))
        if len(data) > UPLOAD_CAP:
            self.emit({"t": "error", "error": "the file is larger than 25 MB"})
            return
        if page.chooser is None:
            self.emit({"t": "error", "error": "the page is not asking for a file"})
            return
        upload_into(self.sess, page, stage_upload(self.sess, str(act.get("name") or "upload"), data))
        self.emit({"t": "chooser", "open": False})

    # ---- lifecycle ----

    def run(self, reader):
        self.sess.casts.add(self.on_event)
        try:
            self.switch(self.sess.active())
            self.emit({"t": "ready", "drive": self.drive})
            page = self.sess.active()
            if page is not None and page.dialog is not None:
                self.emit(dict({"t": "dialog", "open": True}, **page.dialog))
            if page is not None and page.chooser is not None:
                self.emit({"t": "chooser", "open": True, "mode": page.chooser.get("mode")})
            for row in self.sess.ready_downloads():
                self.emit({"t": "download", "guid": row["guid"], "name": row["name"], "size": row["size"]})
            for line in reader:
                text = line.strip()
                if not text:
                    continue
                try:
                    act = json.loads(text)
                except ValueError:
                    self.emit({"t": "error", "error": "the act is not JSON"})
                    continue
                if act.get("a") == "stop":
                    break
                try:
                    self.act(act)
                except (CdpError, DialogOpen, Missing, ValueError) as cause:
                    self.emit({"t": "error", "error": str(cause)[:200]})
        finally:
            self.sess.casts.discard(self.on_event)
            with self.lock:
                if self.page is not None and not self.sess.closed:
                    self.stop_screencast(self.page, self.drive)
                self.page = None
            self.writer.close()
