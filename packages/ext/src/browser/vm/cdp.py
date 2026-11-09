"""One chromium over --remote-debugging-pipe: the broker's only line to it.

Commands go out on the child's fd 3, replies and events come back on its
fd 4, each message one JSON object ended by a NUL byte. There is no debug
PORT: nothing else in the VM can reach this browser. A reader thread
resolves replies by id and hands every event to `on_event`, which must not
block (the broker queues events for its worker: a CDP call made from the
reader thread would wait forever for a reply only the reader can deliver).
"""
import json
import os
import subprocess
import threading
import time


class CdpError(Exception):
    pass


class Interrupted(CdpError):
    """The wait ended early because its `until` came true (a dialog opened)."""


class Cdp:
    def __init__(self, argv, env, log_path, on_event):
        cmd_r, cmd_w = os.pipe()
        resp_r, resp_w = os.pipe()
        # bash maps the two pipe ends onto fds 3/4, the slots chromium's pipe
        # transport reads, then becomes chromium (exec). Not sh: dash cannot
        # redirect a descriptor above 9.
        script = 'exec "$0" "$@" 3<&%d 4>&%d %d<&- %d>&-' % (cmd_r, resp_w, cmd_r, resp_w)
        with open(log_path, "ab") as log:
            self.proc = subprocess.Popen(
                ["bash", "-c", script] + argv,
                pass_fds=(cmd_r, resp_w),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        os.close(cmd_r)
        os.close(resp_w)
        self.out = cmd_w
        self.inp = resp_r
        self.write_lock = threading.Lock()
        self.pending = {}
        self.seq = 0
        self.alive = True
        self.on_event = on_event
        threading.Thread(target=self._reader, name="cdp-reader", daemon=True).start()

    def _reader(self):
        buf = bytearray()
        try:
            while True:
                chunk = os.read(self.inp, 1 << 20)
                if not chunk:
                    break
                buf += chunk
                while True:
                    end = buf.find(b"\0")
                    if end < 0:
                        break
                    raw = bytes(buf[:end])
                    del buf[: end + 1]
                    try:
                        self._dispatch(json.loads(raw))
                    except ValueError:
                        pass
        except OSError:
            pass
        finally:
            self.alive = False
            for slot in list(self.pending.values()):
                slot[1] = {"error": {"message": "the browser closed"}}
                slot[0].set()
            self.pending.clear()
            self.on_event("Broker.browserGone", {}, None)

    def _dispatch(self, msg):
        rid = msg.get("id")
        if rid is not None:
            slot = self.pending.pop(rid, None)
            if slot is not None:
                slot[1] = msg
                slot[0].set()
            return
        method = msg.get("method")
        if method:
            self.on_event(method, msg.get("params") or {}, msg.get("sessionId"))

    def call(self, method, params=None, session=None, timeout=30.0, until=None):
        """One command's result. `until` (polled) stops the wait early: an input
        event that opens a page dialog gets no reply until the dialog closes."""
        if not self.alive:
            raise CdpError("the browser closed")
        slot = [threading.Event(), None]
        with self.write_lock:
            self.seq += 1
            rid = self.seq
            self.pending[rid] = slot
            msg = {"id": rid, "method": method, "params": params or {}}
            if session:
                msg["sessionId"] = session
            data = json.dumps(msg).encode() + b"\0"
            try:
                while data:
                    data = data[os.write(self.out, data):]
            except OSError as cause:
                self.pending.pop(rid, None)
                raise CdpError("the browser closed (%s)" % cause)
        deadline = time.monotonic() + timeout
        while not slot[0].wait(0.1 if until is not None else timeout):
            if until is not None and until():
                self.pending.pop(rid, None)
                raise Interrupted(method)
            if time.monotonic() >= deadline:
                self.pending.pop(rid, None)
                raise CdpError("%s timed out" % method)
        reply = slot[1] or {}
        if "error" in reply:
            raise CdpError("%s: %s" % (method, reply["error"].get("message", "")))
        return reply.get("result", {})

    def stop(self):
        try:
            self.call("Browser.close", timeout=5.0)
        except CdpError:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        for fd in (self.out, self.inp):
            try:
                os.close(fd)
            except OSError:
                pass
