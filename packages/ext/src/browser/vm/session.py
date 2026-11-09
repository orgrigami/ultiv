"""Each bot's browser session inside the one shared chromium.

A session is one browser CONTEXT (its own cookies, storage and cache — no
other bot's context can see them) with one main tab, the popups that tab
opens (followed, at most MAX_POPUPS), and the downloads it starts. One
conversation HOLDS it at a time. Every CDP event lands here first (the
broker's worker thread): popups attach, dialogs and file choosers are
recorded on their page, downloads are kept or refused, and each change is
told to the session's live casts.
"""
import os
import re
import shutil
import threading
import time

from cdp import CdpError
from pages import Page

MAX_POPUPS = 3
MAX_DOWNLOADS = 10
DOWNLOAD_CAP = 25 * 1024 * 1024
# A download the page starts on its own (no act of the bot's or the owner's
# just before it) is refused: a page must not drop files on a bot unasked.
DOWNLOAD_AFTER_ACT_S = 20.0


def safe_name(name, fallback="download"):
    cleaned = re.sub(r"[^A-Za-z0-9._ -]", "_", os.path.basename(name or "")).strip(" .")
    return (cleaned or fallback)[:120]


class BotSession:
    def __init__(self, bot, context, staging, ua):
        self.bot = bot
        self.context = context
        self.staging = staging
        self.ua = ua
        self.main = None
        self.popups = []
        self.holder = ""
        self.held = False
        self.idle_s = 600.0
        self.last_at = time.time()
        self.last_act_at = 0.0
        self.downloads = {}
        self.casts = set()
        self.creating = True
        self.closed = False

    def pages(self):
        return ([self.main] if self.main is not None else []) + list(self.popups)

    def active(self):
        return self.popups[-1] if self.popups else self.main

    def touch(self, act=False):
        now = time.time()
        self.last_at = now
        if act:
            self.last_act_at = now

    def tell(self, event):
        for listener in list(self.casts):
            try:
                listener(event)
            except Exception:
                pass

    def ready_downloads(self):
        return [
            {"guid": guid, "name": row["name"], "size": row["size"], "url": row["url"]}
            for guid, row in self.downloads.items()
            if row["state"] == "ready"
        ]

    def summary(self):
        page = self.active()
        out = {
            "url": page.url if page else "",
            "title": page.title if page else "",
            "popup": bool(page and page.popup),
            "popups": len(self.popups),
            "holder": self.holder,
            "held": self.held,
            "idle": int(time.time() - self.last_at),
        }
        if page is not None and page.dialog is not None:
            out["dialog"] = page.dialog
        if page is not None and page.chooser is not None:
            out["chooser"] = {"mode": page.chooser.get("mode", "selectSingle")}
        ready = self.ready_downloads()
        if ready:
            out["downloads"] = ready
        return out


class Sessions:
    def __init__(self, data_dir, lang):
        self.data_dir = data_dir
        self.lang = lang
        self.cdp = None
        self.by_bot = {}
        self.by_target = {}
        self.by_session = {}
        self.lock = threading.RLock()

    # ---- lifecycle ----

    def get(self, bot):
        sess = self.by_bot.get(bot)
        return None if sess is None or sess.closed else sess

    def open(self, bot, ua):
        cdp = self.cdp
        context = cdp.call("Target.createBrowserContext", {"disposeOnDetach": False})[
            "browserContextId"
        ]
        staging = os.path.join(self.data_dir, "staging", safe_name(bot, "bot"))
        shutil.rmtree(staging, ignore_errors=True)
        for sub in ("downloads", "uploads"):
            os.makedirs(os.path.join(staging, sub), exist_ok=True)
        sess = BotSession(bot, context, staging, ua)
        with self.lock:
            self.by_bot[bot] = sess
        try:
            cdp.call(
                "Browser.setDownloadBehavior",
                {
                    "behavior": "allowAndName",
                    "browserContextId": context,
                    "downloadPath": os.path.join(staging, "downloads"),
                    "eventsEnabled": True,
                },
            )
            target = cdp.call(
                "Target.createTarget", {"url": "about:blank", "browserContextId": context}
            )["targetId"]
            sess.main = self.attach(sess, target, False)
        except CdpError:
            self.close(bot)
            raise
        sess.creating = False
        return sess

    def attach(self, sess, target, popup):
        sid = self.cdp.call("Target.attachToTarget", {"targetId": target, "flatten": True})[
            "sessionId"
        ]
        page = Page(self.cdp, target, sid, popup)
        with self.lock:
            self.by_target[target] = (sess, page)
            self.by_session[sid] = (sess, page)
        page.setup(sess.ua, self.lang)
        return page

    def close(self, bot):
        with self.lock:
            sess = self.by_bot.pop(bot, None)
            if sess is None:
                return False
            sess.closed = True
            for page in sess.pages():
                self.by_target.pop(page.target, None)
                self.by_session.pop(page.session, None)
        sess.tell({"t": "closed", "reason": "the browser session closed"})
        if self.cdp is not None and self.cdp.alive:
            try:
                self.cdp.call("Target.disposeBrowserContext", {"browserContextId": sess.context})
            except CdpError:
                pass
        shutil.rmtree(sess.staging, ignore_errors=True)
        return True

    def browser_gone(self):
        for bot in list(self.by_bot):
            sess = self.by_bot.get(bot)
            if sess is not None:
                sess.tell({"t": "closed", "reason": "the browser stopped"})
            self.close(bot)

    # ---- events (worker thread) ----

    def page_of(self, session_id):
        found = self.by_session.get(session_id)
        return found if found is not None else (None, None)

    def session_of_context(self, context):
        for sess in list(self.by_bot.values()):
            if sess.context == context and not sess.closed:
                return sess
        return None

    def on_target_created(self, info):
        if info.get("type") != "page" or info.get("targetId") in self.by_target:
            return
        sess = self.session_of_context(info.get("browserContextId"))
        if sess is None or sess.creating:
            return
        if len(sess.popups) >= MAX_POPUPS:
            try:
                self.cdp.call("Target.closeTarget", {"targetId": info["targetId"]})
            except CdpError:
                pass
            return
        try:
            page = self.attach(sess, info["targetId"], True)
        except CdpError:
            return
        page.url = info.get("url", "")
        sess.popups.append(page)
        sess.tell({"t": "page", "popup": True})

    def on_target_destroyed(self, target):
        with self.lock:
            found = self.by_target.pop(target, None)
            if found is None:
                return
            sess, page = found
            self.by_session.pop(page.session, None)
        if page.popup:
            if page in sess.popups:
                sess.popups.remove(page)
            sess.tell({"t": "page", "popup": bool(sess.popups)})
        elif not sess.closed:
            # The main tab died (a crash, or the page closed itself): the session is over.
            self.close(sess.bot)

    def on_target_info(self, info):
        found = self.by_target.get(info.get("targetId"))
        if found is not None:
            found[1].url = info.get("url", found[1].url)
            found[1].title = info.get("title", found[1].title)

    def on_page_event(self, method, params, session_id):
        sess, page = self.page_of(session_id)
        if page is None:
            return False
        if method == "Page.javascriptDialogOpening":
            page.dialog = {
                "type": params.get("type", "alert"),
                "message": str(params.get("message", ""))[:1000],
                "default": str(params.get("defaultPrompt", ""))[:200],
            }
            sess.tell(dict({"t": "dialog", "open": True}, **page.dialog))
        elif method == "Page.javascriptDialogClosed":
            page.dialog = None
            sess.tell({"t": "dialog", "open": False})
        elif method == "Page.fileChooserOpened":
            page.chooser = {
                "mode": params.get("mode", "selectSingle"),
                "node": params.get("backendNodeId"),
            }
            sess.tell({"t": "chooser", "open": True, "mode": page.chooser["mode"]})
        elif method == "Page.screencastFrame":
            sess.tell({"t": "_frame", "page": page, "params": params})
        return True

    # ---- downloads ----

    def download_owner(self, frame_id):
        found = self.by_target.get(frame_id)
        if found is not None:
            return found[0]
        recent = [s for s in self.by_bot.values() if not s.closed]
        recent.sort(key=lambda s: s.last_act_at, reverse=True)
        return recent[0] if recent else None

    def cancel_download(self, sess, guid):
        try:
            self.cdp.call(
                "Browser.cancelDownload", {"guid": guid, "browserContextId": sess.context}
            )
        except CdpError:
            pass

    def on_download_begin(self, params):
        sess = self.download_owner(params.get("frameId"))
        if sess is None:
            return
        guid = params.get("guid", "")
        unasked = time.time() - sess.last_act_at > DOWNLOAD_AFTER_ACT_S
        if unasked or len(sess.downloads) >= MAX_DOWNLOADS:
            self.cancel_download(sess, guid)
            return
        sess.downloads[guid] = {
            "name": safe_name(params.get("suggestedFilename")),
            "url": str(params.get("url", ""))[:500],
            "state": "started",
            "size": 0,
        }

    def on_download_progress(self, params):
        guid = params.get("guid", "")
        for sess in list(self.by_bot.values()):
            row = sess.downloads.get(guid)
            if row is None:
                continue
            size = max(int(params.get("totalBytes") or 0), int(params.get("receivedBytes") or 0))
            if size > DOWNLOAD_CAP and row["state"] == "started":
                row["state"] = "too-big"
                self.cancel_download(sess, guid)
                return
            state = params.get("state")
            if state == "completed":
                row["state"] = "ready"
                row["size"] = size
                sess.tell({"t": "download", "guid": guid, "name": row["name"], "size": size})
            elif state == "canceled" and row["state"] == "started":
                row["state"] = "canceled"
            return

    def take_download(self, sess, guid):
        row = sess.downloads.get(guid)
        if row is None or row["state"] != "ready":
            return None
        path = os.path.join(sess.staging, "downloads", guid)
        try:
            with open(path, "rb") as handle:
                data = handle.read(DOWNLOAD_CAP + 1)
        except OSError:
            return None
        row["state"] = "taken"
        try:
            os.remove(path)
        except OSError:
            pass
        return {"name": row["name"], "url": row["url"], "data": data}
