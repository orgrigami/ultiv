/**
 * The in-VM DoH DNS bridge for OPEN homes (`netOpen`). The microsandbox
 * runtime's gateway resolver has been observed (8 Nov 2026, v0.7.13) answering
 * NXDOMAIN for every name — bash and browser alike — for hours in long-lived
 * VMs, while plain 443 egress keeps working (verified: DoH over 443 answered
 * with the resolver in that exact state). The bridge listens on 127.0.0.1:53
 * and forwards each query verbatim over DNS-over-HTTPS, a path the flapping
 * forwarder never touches. /etc/resolv.conf lists it FIRST, the gateway stays
 * listed after it, so a stopped bridge (a VM that was stopped and started; the
 * daemon is installed at VM creation) simply falls back to the runtime's own
 * path — never worse than today.
 *
 * NEVER on allowlist homes: there the gateway resolver IS the enforcement of
 * the home's host list, and it stays the only resolver. The bridge is a
 * workaround for an upstream fault in the one configuration with nothing to
 * enforce; drop it when the runtime's forwarder is fixed.
 */
import { SETUP_WARN } from "./setup-steps.ts";

/** Where the daemon lives inside the VM (beside the CDP driver, in /tmp). */
export const DNSD_PATH = "/tmp/.spriessen-dnsd.py";
/** Its log (best effort; the boot never fails on the bridge). */
export const DNSD_LOG = "/tmp/.spriessen-dnsd.log";

const DNSD_SOURCE = `#!/usr/bin/env python3
"""A loopback DNS forwarder over DoH: one UDP query in, one answer out."""
import socket, threading, time, urllib.request

UPSTREAMS = ["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"]
LOG = None

def log(msg):
    global LOG
    try:
        if LOG is None:
            LOG = open("${DNSD_LOG}", "ab")
        LOG.write(("%s %s\\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg)).encode())
        LOG.flush()
    except Exception:
        pass

def via_doh(query):
    for url in UPSTREAMS:
        try:
            req = urllib.request.Request(
                url, data=query, method="POST",
                headers={"Content-Type": "application/dns-message"},
            )
            with urllib.request.urlopen(req, timeout=4) as r:
                answer = r.read()
            if 12 <= len(answer) <= 4096:
                return answer
            log("odd upstream length %d" % len(answer))
        except Exception as cause:
            log("upstream %s: %s" % (url, cause))
    return None

def servvfail(query):
    head = bytearray(query[:12])
    head[2] |= 0x80
    head[3] = (head[3] & 0xF0) | 2
    return bytes(head)

def serve():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 53))
    log("listening on 127.0.0.1:53")
    while True:
        query, addr = sock.recvfrom(512)

        def one(query=query, addr=addr):
            answer = via_doh(query)
            if answer is None:
                answer = servvfail(query)
            elif len(answer) > 512:
                head = bytearray(answer[:12])
                head[2] |= 0x02
                answer = bytes(head) + answer[12:512]
                log("truncated a %d-byte answer" % len(answer))
            try:
                sock.sendto(answer, addr)
            except Exception:
                pass

        threading.Thread(target=one, daemon=True).start()

def guard():
    """Keep this resolver first in resolv.conf; never remove the gateway."""
    while True:
        try:
            with open("/etc/resolv.conf") as f:
                lines = f.read().splitlines()
            if not any(line.strip() == "nameserver 127.0.0.1" for line in lines):
                with open("/etc/resolv.conf", "w") as f:
                    f.write("nameserver 127.0.0.1\\n" + "\\n".join(lines) + "\\n")
                log("pinned 127.0.0.1 first in resolv.conf")
        except Exception as cause:
            log("guard: %s" % cause)
        time.sleep(60)

threading.Thread(target=guard, daemon=True).start()
serve()
`;

/**
 * The root boot steps (idempotent, never fatal): install the daemon once,
 * start it when it is not running, and pin it first in resolv.conf. The
 * daemon's own guard thread re-asserts the pin every minute (the runtime can
 * rewrite resolv.conf on reconnects).
 */
export const dnsBridgeBootSteps = (): string[] => [
  `if [ ! -s ${DNSD_PATH} ]; then cat > ${DNSD_PATH} <<'__SPRIESSEN_DNSD__'`,
  DNSD_SOURCE,
  "__SPRIESSEN_DNSD__",
  "fi",
  `pgrep -f spriessen-dnsd.py >/dev/null 2>&1 || nohup python3 ${DNSD_PATH} >/dev/null 2>&1 &`,
  `grep -q '^nameserver 127\\.0\\.0\\.1' /etc/resolv.conf 2>/dev/null ` +
    `|| sed -i '1i nameserver 127.0.0.1' /etc/resolv.conf 2>/dev/null ` +
    `|| echo '${SETUP_WARN} dns bridge resolv.conf pin' >&2`,
];
