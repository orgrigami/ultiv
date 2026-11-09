"""The one-shot ops on a bot's session (everything but the live cast).

Every request names its `bot` (the server's word for which session) and
the `conv` that drives it: a session is HELD by one conversation, and any
other gets `busy` with the holder named. Replies are one JSON object; page
replies carry the session summary (dialog, file chooser, finished
downloads) so the caller always learns what the page is waiting on.
"""
import base64
import os
import re
import time
import uuid
from urllib.parse import urlsplit

from cdp import CdpError
from pages import DialogOpen, Missing, target_js
from session import safe_name

UPLOAD_CAP = 25 * 1024 * 1024

LOGIN_JS = r"""
(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' &&
      !el.disabled && !el.readOnly; };
  for (const el of document.querySelectorAll('[data-sp-login]')) el.removeAttribute('data-sp-login');
  const all = [...document.querySelectorAll('input')];
  const inputs = all.filter(vis);
  const words = (el) => [el.name, el.id, el.getAttribute('aria-label'), el.placeholder].join(' ');
  const pass = inputs.find((el) => el.type === 'password');
  const otp = inputs.find((el) => el.type !== 'password' && (el.autocomplete === 'one-time-code' ||
    /otp|totp|2fa|mfa|one.?time|verification.?code|security.?code/i.test(words(el))));
  const texts = inputs.filter((el) => ['email', 'text', 'tel', ''].includes(el.type) && el !== otp);
  let user = texts.find((el) => /username|email/.test(el.autocomplete || '') ||
    /user|email|e-mail|login|account|identifier/i.test(words(el)));
  if (!user && pass) {
    for (let i = all.indexOf(pass) - 1; i >= 0; i -= 1) if (texts.includes(all[i])) { user = all[i]; break; }
  }
  if (!user && !pass && !otp && texts.length === 1) user = texts[0];
  const found = [];
  if (user) { user.setAttribute('data-sp-login', 'username'); found.push('username'); }
  if (pass) { pass.setAttribute('data-sp-login', 'password'); found.push('password'); }
  if (otp) { otp.setAttribute('data-sp-login', 'otp'); found.push('otp'); }
  return found;
})()
"""


class Refused(Exception):
    def __init__(self, kind, message):
        Exception.__init__(self, message)
        self.kind = kind


def fail(kind, message):
    return {"ok": False, "kind": kind, "error": message}


def host_allowed(url, patterns):
    """The vault binding's target forms: host, *.suffix, host:port, https url prefix."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    if parts.scheme not in ("https", "http") or host == "":
        return False
    for raw in patterns or []:
        pattern = str(raw).strip().lower()
        if pattern.startswith("https://") or pattern.startswith("http://"):
            if url.lower().startswith(pattern):
                return True
        elif pattern.startswith("*."):
            if host.endswith(pattern[1:]) and host != pattern[2:]:
                return True
        elif ":" in pattern:
            if parts.netloc.lower() == pattern:
                return True
        elif host == pattern:
            return True
    return False


def page_reply(sess, page, extra=None, with_text=True):
    if page.dialog is not None:
        # The page is frozen on its dialog: say so instead of reading it.
        out = {"ok": True, "url": page.url, "title": page.title}
        out.update(extra or {})
        out["session"] = sess.summary()
        return out
    facts = page.facts(with_text)
    out = {"ok": True, "url": facts.get("url", ""), "title": facts.get("title", "")}
    if with_text:
        out["text"] = facts.get("text", "")
    out.update(extra or {})
    out["session"] = sess.summary()
    return out


def claim(broker, req, create=False):
    """The bot's session for this conversation, or a refusal naming the holder."""
    bot, conv = str(req.get("bot", "")), str(req.get("conv", ""))
    if bot == "":
        raise Refused("error", "no bot named")
    sess = broker.sessions.get(bot)
    if sess is not None and sess.holder not in ("", conv) and not req.get("force"):
        raise Refused("busy", sess.holder)
    if sess is None:
        if not create:
            raise Refused("no-session", "this bot has no browser open (op open starts one)")
        live = [s for s in broker.sessions.by_bot.values() if not s.closed]
        if len(live) >= broker.max_sessions:
            raise Refused(
                "full",
                "this home's browser is full: %d bots are browsing at once; wait for one to "
                "finish (sessions close when their task ends or after 10 quiet minutes)" % len(live),
            )
        broker.ensure_browser()
        sess = broker.sessions.open(bot, str(req.get("ua") or broker.default_ua))
    if conv:
        sess.holder = conv
    idle = req.get("idle_s")
    if isinstance(idle, (int, float)) and 60 <= idle <= 7200:
        sess.idle_s = float(idle)
    return sess


def check_site(page, req):
    """An act that names its site (an owner's per-site rule approved it) runs only there."""
    site = str(req.get("expect_host") or "").lower()
    if site == "":
        return
    try:
        host = (urlsplit(page.url).netloc or "").lower()
    except ValueError:
        host = ""
    if host != site:
        raise Refused("site", "this page is on %s, not %s" % (host or "no site", site))


def op_open(broker, req):
    url = str(req.get("url") or "about:blank")
    if not (url == "about:blank" or re.match(r"^https?://", url)):
        return fail("load", "only http(s) urls open")
    sess = claim(broker, req, create=True)
    sess.touch(act=True)
    # Opening a page starts over in the main tab: popups from the last page close.
    for popup in list(sess.popups):
        try:
            broker.cdp.call("Target.closeTarget", {"targetId": popup.target})
        except CdpError:
            pass
    page = sess.main
    page.navigate(url)
    return page_reply(sess, page, with_text=False)


def op_read(broker, req):
    sess = claim(broker, req)
    sess.touch()
    page = sess.active()
    if req.get("selector") or req.get("ref") is not None:
        expr = target_js(req.get("selector"), req.get("ref"))
        text = page.evaluate("(%s || {innerText: null}).innerText" % expr)
        if text is None:
            raise Missing("no element matches")
        return dict({"ok": True, "text": str(text)[:12000]}, session=sess.summary())
    return page_reply(sess, page)


def op_snapshot(broker, req):
    sess = claim(broker, req)
    sess.touch()
    page = sess.active()
    snap = page.snapshot()
    return page_reply(sess, page, {"elements": snap.get("lines", [])})


def op_click(broker, req):
    sess = claim(broker, req)
    sess.touch(act=True)
    page = sess.active()
    check_site(page, req)
    page.click(req.get("selector"), req.get("ref"))
    page.settle()
    return page_reply(sess, sess.active(), with_text=False)


def op_type(broker, req):
    sess = claim(broker, req)
    sess.touch(act=True)
    page = sess.active()
    check_site(page, req)
    kind = page.focus_and_clear(req.get("selector"), req.get("ref"))
    if str(kind).lower() == "password":
        return fail("password", "that field is a password field")
    page.insert_text(str(req.get("text", "")))
    return dict({"ok": True, "filled": True}, session=sess.summary())


def op_press(broker, req):
    sess = claim(broker, req)
    sess.touch(act=True)
    page = sess.active()
    check_site(page, req)
    page.press(str(req.get("key") or "Enter"))
    page.settle()
    return page_reply(sess, sess.active(), with_text=False)


def op_shot(broker, req):
    sess = claim(broker, req)
    sess.touch()
    page = sess.active()
    return {"ok": True, "png": page.screenshot(), "url": page.url, "session": sess.summary()}


def op_dialog(broker, req):
    sess = claim(broker, req)
    sess.touch(act=True)
    page = next((p for p in reversed(sess.pages()) if p.dialog is not None), None)
    if page is None:
        return fail("no-dialog", "no dialog is open on the page")
    check_site(page, req)
    params = {"accept": bool(req.get("accept", True))}
    if req.get("text") is not None:
        params["promptText"] = str(req.get("text"))[:2000]
    answered = page.dialog
    page.call("Page.handleJavaScriptDialog", params)
    # Chromium's own "closed" event clears it (never us: the page may open the
    # next dialog at once, and clearing here would lose that one).
    deadline = time.time() + 1.0
    while page.dialog is answered and time.time() < deadline:
        time.sleep(0.05)
    return dict({"ok": True}, session=sess.summary())


def stage_upload(sess, name, data):
    folder = os.path.join(sess.staging, "uploads", uuid.uuid4().hex)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, safe_name(name, "upload"))
    with open(path, "wb") as handle:
        handle.write(data)
    return path


def upload_into(sess, page, path, selector=None, ref=None):
    """Hand a staged file to the page's waiting chooser, or to a file input."""
    if page.chooser is not None and selector is None and ref is None:
        page.call("DOM.setFileInputFiles", {"files": [path], "backendNodeId": page.chooser["node"]})
        page.chooser = None
        return
    found = page.call(
        "Runtime.evaluate", {"expression": target_js(selector, ref), "returnByValue": False}
    ).get("result", {})
    object_id = found.get("objectId")
    if object_id is None:
        raise Missing("no file field matches; or wait for the page to ask for a file")
    page.call("DOM.setFileInputFiles", {"files": [path], "objectId": object_id})


def op_upload(broker, req):
    sess = claim(broker, req)
    sess.touch(act=True)
    try:
        data = base64.b64decode(str(req.get("data", "")), validate=True)
    except ValueError:
        return fail("error", "the file is not base64")
    if len(data) > UPLOAD_CAP:
        return fail("too-big", "the file is larger than 25 MB")
    page = sess.active()
    check_site(page, req)
    path = stage_upload(sess, str(req.get("name") or "upload"), data)
    upload_into(sess, page, path, req.get("selector"), req.get("ref"))
    time.sleep(0.3)
    return dict({"ok": True, "uploaded": os.path.basename(path)}, session=sess.summary())


def op_take_download(broker, req):
    sess = claim(broker, req)
    got = broker.sessions.take_download(sess, str(req.get("guid", "")))
    if got is None:
        return fail("no-download", "that download is not ready")
    return {
        "ok": True,
        "name": got["name"],
        "url": got["url"],
        "data": base64.b64encode(got["data"]).decode(),
    }


COOKIE_FIELDS = (
    "name", "value", "domain", "path", "secure", "httpOnly", "sameSite", "expires",
    "priority", "sourceScheme", "sourcePort",
)


def op_cookies_export(broker, req):
    sess = claim(broker, req)
    domains = [str(d).lower().lstrip(".") for d in req.get("domains") or [] if d]
    cookies = broker.cdp.call("Storage.getCookies", {"browserContextId": sess.context}).get(
        "cookies", []
    )
    keep = []
    for cookie in cookies:
        domain = str(cookie.get("domain", "")).lower().lstrip(".")
        if any(domain == d or domain.endswith("." + d) for d in domains):
            keep.append({k: cookie[k] for k in COOKIE_FIELDS if k in cookie})
    return {"ok": True, "cookies": keep, "ua": sess.ua}


def op_cookies_import(broker, req):
    sess = claim(broker, req, create=True)
    cookies = []
    for cookie in req.get("cookies") or []:
        row = {k: cookie[k] for k in COOKIE_FIELDS if k in cookie}
        if row.get("expires", 0) in (-1, 0):
            row.pop("expires", None)
        if row.get("name") and row.get("domain"):
            cookies.append(row)
    if cookies:
        broker.cdp.call(
            "Storage.setCookies", {"cookies": cookies, "browserContextId": sess.context}
        )
    return {"ok": True, "restored": len(cookies), "session": sess.summary()}


def op_cookies_clear(broker, req):
    sess = broker.sessions.get(str(req.get("bot", "")))
    if sess is not None:
        broker.cdp.call("Storage.clearCookies", {"browserContextId": sess.context})
    return {"ok": True}


def op_fill_login(broker, req):
    sess = claim(broker, req)
    sess.touch(act=True)
    page = sess.active()
    facts = page.facts(False)
    check_site(page, req)
    if not host_allowed(facts.get("url", ""), req.get("hosts")):
        return fail("host", "this page's address is not one the vault item may be used on")
    found = page.evaluate(LOGIN_JS) or []
    values = {
        "username": req.get("username"),
        "password": req.get("password"),
        "otp": req.get("otp"),
    }
    filled = []
    for field in found:
        value = values.get(field)
        if not value:
            continue
        page.focus_and_clear('[data-sp-login="%s"]' % field)
        page.insert_text(str(value))
        filled.append(field)
    page.evaluate(
        "(() => { for (const el of document.querySelectorAll('[data-sp-login]'))"
        " el.removeAttribute('data-sp-login'); return true; })()"
    )
    return {"ok": True, "filled": filled, "url": facts.get("url", ""), "session": sess.summary()}


def op_status(broker, req):
    sess = broker.sessions.get(str(req.get("bot", "")))
    return {"ok": True, "session": None if sess is None else sess.summary()}


def op_hold(broker, req):
    sess = broker.sessions.get(str(req.get("bot", "")))
    if sess is None:
        return fail("no-session", "this bot has no browser open")
    sess.held = bool(req.get("on"))
    sess.touch()
    return {"ok": True}


def op_close(broker, req):
    bot, conv = str(req.get("bot", "")), str(req.get("conv", ""))
    sess = broker.sessions.get(bot)
    if sess is None:
        return {"ok": True, "closed": False}
    if sess.holder not in ("", conv) and not req.get("force"):
        return fail("busy", sess.holder)
    broker.sessions.close(bot)
    return {"ok": True, "closed": True}


OPS = {
    "open": op_open, "read": op_read, "snapshot": op_snapshot, "click": op_click,
    "type": op_type, "press": op_press, "shot": op_shot, "dialog": op_dialog,
    "upload": op_upload, "take_download": op_take_download,
    "cookies_export": op_cookies_export, "cookies_import": op_cookies_import,
    "cookies_clear": op_cookies_clear, "fill_login": op_fill_login,
    "status": op_status, "hold": op_hold, "close": op_close,
}


def run_op(broker, req):
    handler = OPS.get(req.get("op"))
    if handler is None:
        return fail("error", "unknown op %r" % req.get("op"))
    try:
        return handler(broker, req)
    except Refused as refused:
        return fail(refused.kind, str(refused))
    except Missing as missing:
        return fail("selector", str(missing))
    except DialogOpen as dialog:
        return fail("dialog", "a page dialog is open and waits for an answer: %s" % dialog)
    except CdpError as cause:
        text = str(cause)
        kind = "browser-down" if "browser closed" in text else ("load" if "did not load" in text else "error")
        return fail(kind, text[:300])
