#!/usr/bin/env python3
"""The server's line to the browser broker, run by root inside the VM.

    client.py --run DIR call            one request line on stdin, one reply line out
    client.py --run DIR relay           first stdin line is the request; then lines
                                        both ways until either side ends (the cast)
    client.py --run DIR ping VERSION    exit 0 when the running broker has VERSION

A broker that is not running answers `broker-down`, so the server starts it.
"""
import json
import os
import socket
import sys
import threading

DOWN = {"ok": False, "kind": "broker-down", "error": "the browser broker is not running"}


def connect(run_dir):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    # By the relative name (socket paths are capped at 108 bytes).
    os.chdir(run_dir)
    sock.connect("broker.sock")
    return sock


def call(run_dir, line):
    try:
        sock = connect(run_dir)
    except OSError:
        print(json.dumps(DOWN))
        return 0
    sock.sendall(line.rstrip("\n").encode() + b"\n")
    reply = sock.makefile("r", encoding="utf-8").readline()
    print(reply.strip() if reply.strip() else json.dumps(DOWN))
    return 0


def relay(run_dir):
    first = sys.stdin.readline()
    try:
        sock = connect(run_dir)
    except OSError:
        print(json.dumps({"t": "fatal", "error": DOWN["error"]}))
        return 0
    sock.sendall(first.rstrip("\n").encode() + b"\n")

    def upstream():
        try:
            for line in sys.stdin:
                sock.sendall(line.encode())
        except OSError:
            pass
        try:
            sock.shutdown(socket.SHUT_WR)
        except OSError:
            pass

    threading.Thread(target=upstream, daemon=True).start()
    out = sys.stdout.buffer
    while True:
        chunk = sock.recv(1 << 16)
        if not chunk:
            break
        out.write(chunk)
        out.flush()
    return 0


def ping(run_dir, version):
    try:
        sock = connect(run_dir)
        sock.sendall(b'{"op":"ping"}\n')
        reply = json.loads(sock.makefile("r", encoding="utf-8").readline() or "{}")
    except (OSError, ValueError):
        return 1
    return 0 if reply.get("version") == version else 2


def main():
    args = sys.argv[1:]
    if len(args) < 3 or args[0] != "--run":
        print(__doc__.strip(), file=sys.stderr)
        return 64
    run_dir, mode = args[1], args[2]
    if mode == "call":
        return call(run_dir, sys.stdin.readline())
    if mode == "relay":
        return relay(run_dir)
    if mode == "ping" and len(args) > 3:
        return ping(run_dir, args[3])
    print(__doc__.strip(), file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main())
