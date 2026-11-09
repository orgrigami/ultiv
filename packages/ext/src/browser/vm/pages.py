"""One page target of a bot's session, and the page-level moves on it.

Acts are REAL input (Input.dispatchMouseEvent / insertText / dispatchKeyEvent),
the same trusted events a person's mouse and keyboard produce: pages that
check `isTrusted` behave as they would for a human. Elements are named by
a CSS selector or by a REF from the last snapshot (`[12] button "Sign in"`):
the snapshot tags each listed element with `data-sp-ref`, so a ref is a
plain attribute selector. A password field's value never leaves the page.
"""
import json
import time

from cdp import CdpError, Interrupted

KEYCODES = {
    "Enter": 13, "Tab": 9, "Backspace": 8, "Delete": 46, "Escape": 27,
    "ArrowLeft": 37, "ArrowUp": 38, "ArrowRight": 39, "ArrowDown": 40,
    "Home": 36, "End": 35, "PageUp": 33, "PageDown": 34, " ": 32,
}
# Keys whose press must carry its text for the page's default action.
KEYTEXT = {"Enter": "\r", "Tab": "\t", " ": " "}


class DialogOpen(Exception):
    """The page is blocked on alert/confirm/prompt until someone answers it."""


class Missing(Exception):
    """No element matches the selector or ref."""


SNAPSHOT_JS = r"""
(() => {
  const MAX = 300;
  for (const el of document.querySelectorAll('[data-sp-ref]')) el.removeAttribute('data-sp-ref');
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],' +
    '[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],' +
    '[role=textbox],[role=combobox],[contenteditable=""],[contenteditable=true],[onclick]';
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const nameOf = (el) => clean(
    el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) ||
    el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') ||
    (el.tagName === 'INPUT' ? '' : el.innerText) || el.getAttribute('name') || '');
  const lines = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (n >= MAX) break;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    n += 1;
    el.setAttribute('data-sp-ref', String(n));
    const tag = el.tagName.toLowerCase();
    let kind = el.getAttribute('role') || tag;
    if (tag === 'input') kind = 'input[' + (el.type || 'text') + ']';
    let line = '[' + n + '] ' + kind;
    const name = nameOf(el);
    if (name) line += ' "' + name + '"';
    if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
      line += el.checked ? ' (checked)' : ' (unchecked)';
    } else if ((tag === 'input' || tag === 'textarea') && el.type !== 'password' && el.value) {
      line += ' value="' + clean(el.value) + '"';
    } else if (tag === 'select' && el.selectedOptions && el.selectedOptions[0]) {
      line += ' selected="' + clean(el.selectedOptions[0].text) + '"';
    }
    if (el.disabled) line += ' (disabled)';
    if (tag === 'a') line += ' -> ' + String(el.getAttribute('href') || '').slice(0, 120);
    lines.push(line);
  }
  return JSON.stringify({count: n, lines});
})()
"""


def target_js(selector=None, ref=None):
    """A JS expression for the element a call names (ref wins)."""
    if ref is not None:
        if not str(ref).isdigit():
            raise Missing("a ref is a number from the last snapshot, e.g. 12")
        return "document.querySelector('[data-sp-ref=\"%s\"]')" % ref
    if not selector:
        raise Missing("name the element: a ref from op snapshot, or a CSS selector")
    return "document.querySelector(%s)" % json.dumps(selector)


class Page:
    def __init__(self, cdp, target, session, popup):
        self.cdp = cdp
        self.target = target
        self.session = session
        self.popup = popup
        self.url = ""
        self.title = ""
        self.dialog = None
        self.chooser = None

    def call(self, method, params=None, timeout=30.0):
        return self.cdp.call(method, params, self.session, timeout)

    def input(self, method, params):
        """Input that may open a dialog: answered as soon as one opens."""
        try:
            self.cdp.call(method, params, self.session, 30.0, lambda: self.dialog is not None)
        except Interrupted:
            pass

    def setup(self, ua, lang):
        self.call("Page.enable")
        self.call("Page.setInterceptFileChooserDialog", {"enabled": True})
        self.call("Network.enable")
        self.call(
            "Network.setUserAgentOverride",
            {"userAgent": ua, "acceptLanguage": lang, "platform": "Linux x86_64"},
        )

    def evaluate(self, expression, timeout=20.0):
        if self.dialog is not None:
            raise DialogOpen(self.dialog.get("message", ""))
        result = self.call(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
            timeout,
        )
        if "exceptionDetails" in result:
            detail = result["exceptionDetails"].get("exception", {}).get("description", "")
            raise CdpError((detail or "the page rejected the script")[:300])
        return result.get("result", {}).get("value")

    def facts(self, with_text=True):
        expr = "JSON.stringify({url: location.href, title: document.title%s})" % (
            ", text: (document.body ? document.body.innerText : '').slice(0, 12000)"
            if with_text else ""
        )
        got = json.loads(self.evaluate(expr))
        self.url = got.get("url", self.url)
        self.title = got.get("title", self.title)
        return got

    def wait_ready(self, seconds=15.0):
        deadline = time.time() + seconds
        while time.time() < deadline:
            if self.dialog is not None:
                return False
            try:
                if self.evaluate("document.readyState", 5.0) in ("complete", "interactive"):
                    return True
            except (CdpError, DialogOpen):
                pass
            time.sleep(0.3)
        return False

    def settle(self):
        """After an act that may navigate: give the page a moment, then wait for it."""
        time.sleep(0.5)
        if self.dialog is not None:
            return
        self.wait_ready(8.0)

    def navigate(self, url):
        nav = self.call("Page.navigate", {"url": url})
        if nav.get("errorText"):
            raise CdpError("the page did not load (%s)" % nav["errorText"])
        self.wait_ready()

    def locate(self, selector=None, ref=None):
        """Scroll the element into view; its centre and kind, or Missing."""
        found = self.evaluate(
            "(() => { const el = %s; if (!el) return null;"
            " el.scrollIntoView({block: 'center', inline: 'center'});"
            " const r = el.getBoundingClientRect();"
            " return {x: r.left + r.width / 2, y: r.top + r.height / 2,"
            " type: String(el.type || ''), tag: el.tagName}; })()" % target_js(selector, ref)
        )
        if found is None:
            raise Missing("no element matches %s" % (("ref %s" % ref) if ref is not None else selector))
        return found

    def mouse(self, kind, x, y, button="left", clicks=1, buttons=None):
        params = {"type": kind, "x": x, "y": y, "button": button, "clickCount": clicks}
        if buttons is not None:
            params["buttons"] = buttons
        self.input("Input.dispatchMouseEvent", params)

    def click_at(self, x, y, clicks=1):
        if self.dialog is not None:
            raise DialogOpen(self.dialog.get("message", ""))
        self.mouse("mouseMoved", x, y, "none", 0)
        for n in range(1, clicks + 1):
            self.mouse("mousePressed", x, y, "left", n, 1)
            self.mouse("mouseReleased", x, y, "left", n, 0)

    def click(self, selector=None, ref=None):
        spot = self.locate(selector, ref)
        self.click_at(spot["x"], spot["y"])
        return spot

    def focus_and_clear(self, selector=None, ref=None):
        """Focus a field and select what it holds, so typed text replaces it."""
        kind = self.evaluate(
            "(() => { const el = %s; if (!el) return null; el.scrollIntoView({block: 'center'});"
            " el.focus(); if (typeof el.select === 'function') el.select();"
            " else if (el.isContentEditable) document.execCommand('selectAll');"
            " return String(el.type || el.tagName); })()" % target_js(selector, ref)
        )
        if kind is None:
            raise Missing("no element matches %s" % (("ref %s" % ref) if ref is not None else selector))
        return kind

    def insert_text(self, text):
        self.input("Input.insertText", {"text": text})

    def press(self, key):
        code = KEYCODES.get(key) or (ord(key[0].upper()) if len(key) == 1 else 0)
        text = KEYTEXT.get(key, key if len(key) == 1 else "")
        common = {"key": key, "windowsVirtualKeyCode": code, "nativeVirtualKeyCode": code}
        if text:
            common["text"] = text
        self.input("Input.dispatchKeyEvent", dict(common, type="keyDown" if text else "rawKeyDown"))
        if self.dialog is None:
            self.input("Input.dispatchKeyEvent", dict(common, type="keyUp"))

    def snapshot(self):
        return json.loads(self.evaluate(SNAPSHOT_JS))

    def screenshot(self, fmt="png", quality=None):
        params = {"format": fmt}
        if quality is not None:
            params["quality"] = quality
        return self.call("Page.captureScreenshot", params).get("data", "")
