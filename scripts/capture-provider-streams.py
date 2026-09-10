#!/usr/bin/env python3
"""Record provider HTTP streams without buffering their delivery to the client.

Run with --upstream pointed at one provider endpoint.  The proxy records every
request/response exchange beneath --fixtures; CAPTURE_CASE selects a directory
and enables the documented request rewrites used to force edge cases.
"""

import argparse
import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, build_opener, ProxyHandler

HOP_BY_HOP = {
    "host", "connection", "proxy-connection", "transfer-encoding",
    "keep-alive", "upgrade", "content-length",
}
RESPONSE_HOP_BY_HOP = HOP_BY_HOP | {"content-length"}


def utc_stamp():
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")


def json_rewrite(body, case):
    """Return rewritten JSON bytes and a concise description of the change."""
    if case != "truncated-tool-json":
        return body, None
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return body, "skipped: request was not JSON"
    if not isinstance(value, dict):
        return body, "skipped: JSON root was not an object"
    # Both APIs use max_tokens.  Responses accepts max_output_tokens instead.
    if "max_tokens" in value:
        value["max_tokens"] = 48
        field = "max_tokens"
    elif "max_output_tokens" in value:
        value["max_output_tokens"] = 48
        field = "max_output_tokens"
    else:
        value["max_tokens"] = 48
        field = "max_tokens (added)"
    return json.dumps(value, separators=(",", ":")).encode("utf-8"), field + "=48"


class CaptureServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, handler, config):
        ThreadingHTTPServer.__init__(self, address, handler)
        self.config = config


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    def do_GET(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def do_PUT(self):
        self.forward()

    def do_DELETE(self):
        self.forward()

    def do_PATCH(self):
        self.forward()

    def forward(self):
        config = self.server.config
        started = time.monotonic()
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        body, rewrite = json_rewrite(body, config.case)
        record_dir = config.fixtures / config.provider / config.case / utc_stamp()
        record_dir.mkdir(parents=True, exist_ok=False)
        (record_dir / "request.json").write_bytes(body)

        upstream = urlsplit(config.upstream)
        # --upstream may include a stable API prefix (ChatGPT's backend-api,
        # for example); clients send paths relative to the local proxy.
        base_path = upstream.path.rstrip("/")
        target_path = base_path + self.path
        target = urlunsplit((upstream.scheme, upstream.netloc, target_path, "", ""))
        headers = {key: value for key, value in self.headers.items()
                   if key.lower() not in HOP_BY_HOP}
        request = Request(target, data=body if body else None, headers=headers,
                          method=self.command)
        response = None
        status = 502
        response_headers = {}
        error = None
        headers_sent = False
        try:
            # Explicitly bypass ambient proxy settings: localhost captures must
            # always establish TLS directly to the configured upstream.
            opener = build_opener(ProxyHandler({}))
            try:
                response = opener.open(request, timeout=config.timeout)
            except HTTPError as exc:
                response = exc
            status = response.code
            response_headers = dict(response.headers.items())
            self.send_response(status)
            for key, value in response.headers.items():
                if key.lower() not in RESPONSE_HOP_BY_HOP:
                    self.send_header(key, value)
            self.send_header("Connection", "close")
            self.end_headers()
            headers_sent = True
            # read1() returns whatever one underlying read yields.  read() would
            # block until it had chunk_size bytes or EOF, which buffers the whole
            # stream whenever provider events are smaller than chunk_size -- i.e.
            # always.  Verified: read() delivers everything at EOF, read1()
            # delivers each upstream write as it lands.
            read_available = getattr(response, "read1", None) or response.read
            with (record_dir / "response.sse").open("wb") as output:
                while True:
                    chunk = read_available(config.chunk_size)
                    if not chunk:
                        break
                    output.write(chunk)
                    output.flush()
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except Exception as exc:  # Capture operational failures as metadata.
            error = "%s: %s" % (type(exc).__name__, exc)
            # Only send an error response if no status line has gone out yet.
            # Once headers are sent, send_error would inject a second header
            # block into the response body and corrupt the very capture we are
            # recording -- which is what a mid-stream upstream failure does.
            if not headers_sent and not self.wfile.closed:
                try:
                    self.send_error(502, error)
                except Exception:
                    pass
            else:
                self.close_connection = True
        finally:
            if response is not None:
                response.close()
            meta = {
                "provider": config.provider,
                "case": config.case,
                "upstream": config.upstream,
                "method": self.command,
                "path": self.path,
                "status": status,
                "response_headers": response_headers,
                "rewrite_applied": rewrite,
                "duration_ms": round((time.monotonic() - started) * 1000, 2),
            }
            if error:
                meta["error"] = error
            (record_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", choices=("anthropic", "openai"), required=True)
    parser.add_argument("--upstream", required=True,
                        help="upstream origin/prefix, e.g. https://chatgpt.com/backend-api")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--fixtures", type=Path, default=Path("fixtures"))
    parser.add_argument("--chunk-size", type=int, default=1024)
    parser.add_argument("--timeout", type=float, default=120.0)
    args = parser.parse_args()
    args.case = os.environ.get("CAPTURE_CASE", "passthrough")
    if args.case not in {"interleaved", "truncated-tool-json", "refusal", "context-limit", "passthrough"}:
        parser.error("CAPTURE_CASE has an unsupported value: %s" % args.case)
    server = CaptureServer(("127.0.0.1", args.port), Handler, args)
    host, port = server.server_address
    print("capture proxy listening at http://%s:%s" % (host, port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
