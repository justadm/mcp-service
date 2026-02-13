#!/usr/bin/env python3
"""
TCP proxy for: docker containers -> host gateway -> ssh reverse tunnel.

Use-case:
- laptop runs: ssh -N -R 127.0.0.1:13306:127.0.0.1:3306 <vm>
- on VM the forwarded MySQL is available only on 127.0.0.1:13306
- docker containers need a reachable host IP, typically 172.17.0.1 (host-gateway)
This proxy listens on 172.17.0.1:13306 and forwards to 127.0.0.1:13306.
"""

import os
import selectors
import socket


LISTEN_HOST = os.environ.get("LISTEN_HOST", "172.17.0.1")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "13306"))
UPSTREAM_HOST = os.environ.get("UPSTREAM_HOST", "127.0.0.1")
UPSTREAM_PORT = int(os.environ.get("UPSTREAM_PORT", "13306"))


def set_nonblock(s: socket.socket) -> None:
    s.setblocking(False)


def pump(sel: selectors.BaseSelector, a: socket.socket, b: socket.socket) -> None:
    # Register both sockets for read; on readability, forward bytes to the other side.
    sel.register(a, selectors.EVENT_READ, data=b)
    sel.register(b, selectors.EVENT_READ, data=a)
    while True:
        events = sel.select(timeout=60)
        if not events:
            continue
        for key, _mask in events:
            src = key.fileobj
            dst = key.data
            try:
                data = src.recv(65536)
            except OSError:
                return
            if not data:
                return
            try:
                dst.sendall(data)
            except OSError:
                return


def main() -> None:
    ls = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    ls.bind((LISTEN_HOST, LISTEN_PORT))
    ls.listen(128)

    while True:
        client, _addr = ls.accept()
        upstream = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            upstream.connect((UPSTREAM_HOST, UPSTREAM_PORT))
        except OSError:
            try:
                client.close()
            finally:
                upstream.close()
            continue

        set_nonblock(client)
        set_nonblock(upstream)
        sel = selectors.DefaultSelector()
        try:
            pump(sel, client, upstream)
        finally:
            try:
                sel.close()
            except Exception:
                pass
            try:
                client.close()
            except Exception:
                pass
            try:
                upstream.close()
            except Exception:
                pass


if __name__ == "__main__":
    main()

