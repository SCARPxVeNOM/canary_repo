"""mitmproxy addon for the Canary scanner: ground truth.

Writes one JSON line per HTTP(S) request the browser makes (pages, iframes,
workers, extensions) and per WebSocket message it sends. Anything here left the
browser over HTTP; anon-rpc traffic leaves over WebRTC and never appears, so
everything in this file is, by definition, not protected by anon-rpc.

    CANARY_SCAN_OUT=flows.jsonl mitmdump -q -p 8899 -s addon.py
"""

import base64
import hashlib
import json
import os
import time

from mitmproxy import http

OUT = open(os.environ["CANARY_SCAN_OUT"], "a", buffering=1)
MAX_BODY = 256 * 1024
KEEP_HEADERS = ("origin", "referer", "content-type", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest")


def _text(message) -> tuple[str | None, int]:
    raw = message.get_content(strict=False) or b""
    if len(raw) > MAX_BODY:
        return None, len(raw)
    try:
        return raw.decode("utf-8"), len(raw)
    except UnicodeDecodeError:
        return "base64:" + base64.b64encode(raw).decode(), len(raw)


def _write(rec: dict) -> None:
    OUT.write(json.dumps(rec) + "\n")


def request(flow: http.HTTPFlow) -> None:
    # *.localhost means "this machine" to a browser, but not to every resolver.
    # Connect to loopback and keep the Host header, so local demos work through the proxy.
    host = flow.request.pretty_host
    if host == "localhost" or host.endswith(".localhost"):
        header = flow.request.host_header
        flow.request.host = "127.0.0.1"
        flow.request.host_header = header


def response(flow: http.HTTPFlow) -> None:
    _record(flow)


def error(flow: http.HTTPFlow) -> None:
    if flow.response is None:
        _record(flow)


def _record(flow: http.HTTPFlow) -> None:
    req = flow.request
    body, body_len = _text(req)
    rec = {
        "type": "http",
        "t": time.time(),
        "method": req.method,
        "url": req.pretty_url,
        "host": req.pretty_host,
        "headers": {k: req.headers[k] for k in KEEP_HEADERS if k in req.headers},
        "body": body,
        "bodyLen": body_len,
        "status": flow.response.status_code if flow.response else None,
        "error": str(flow.error) if flow.error else None,
    }
    if flow.response is not None:
        ctype = flow.response.headers.get("content-type", "")
        rec["respType"] = ctype.split(";")[0]
        if "html" in ctype or "javascript" in ctype:
            rec["respSha256"] = hashlib.sha256(flow.response.get_content(strict=False) or b"").hexdigest()
    _write(rec)


def websocket_message(flow: http.HTTPFlow) -> None:
    msg = flow.websocket.messages[-1]
    if not msg.from_client:
        return
    content = msg.content if isinstance(msg.content, bytes) else str(msg.content).encode()
    try:
        body = content.decode("utf-8")
    except UnicodeDecodeError:
        body = "base64:" + base64.b64encode(content).decode()
    _write({
        "type": "ws",
        "t": time.time(),
        "method": "WS",
        "url": flow.request.pretty_url,
        "host": flow.request.pretty_host,
        "headers": {k: flow.request.headers[k] for k in ("origin",) if k in flow.request.headers},
        "body": body[:MAX_BODY],
        "bodyLen": len(content),
    })
