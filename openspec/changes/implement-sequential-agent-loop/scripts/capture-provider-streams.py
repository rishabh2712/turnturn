#!/usr/bin/env python3
"""Stdlib-only provider stream capture proxy.

Run a local HTTP endpoint that forwards requests to one HTTPS upstream, streams
the upstream response back to the client, and writes the exact upstream response
bytes to a fixture directory.

Environment:
  CAPTURE_UPSTREAM_BASE_URL  Required. Example: https://api.anthropic.com
  CAPTURE_PROVIDER           Required. Example: anthropic or openai
  CAPTURE_CASE               Required. Example: interleaved
  CAPTURE_SOURCE             Optional. Example: litellm
  CAPTURE_WIRE               Optional. Example: openai-chat-completions
  CAPTURE_PURPOSE            Optional. Example: compatibility or truth
  CAPTURE_BACKEND            Optional. Example: bedrock
  CAPTURE_MODEL              Optional. Example: bedrock-claude-4.5-haiku
  CAPTURE_API_VERSION        Optional. Example: 2023-06-01
  CAPTURE_FIXTURE_DIR        Optional. Defaults to ../fixtures/providers
  CAPTURE_LISTEN_HOST        Optional. Defaults to 127.0.0.1
  CAPTURE_LISTEN_PORT        Optional. Defaults to 8765
  CAPTURE_FORCE_MAX_TOKENS   Optional. Defaults to 48 for truncated cases.
  CAPTURE_CHUNK_SIZE         Optional. Defaults to 1024.

The proxy forwards credentials upstream but redacts credential-bearing headers
from saved metadata and auth-like JSON request fields from saved request bodies.
Non-secret request and response bodies are preserved as fixture data.
"""

from __future__ import annotations

import datetime as _dt
import http.client
import http.server
import json
import os
import pathlib
import socketserver
import sys
import time
import urllib.parse
from typing import Dict, Iterable, Optional, Tuple


HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}

SECRET_HEADER_NAMES = {
    "authorization",
    "cookie",
    "proxy-authorization",
    "x-api-key",
    "api-key",
    "anthropic-api-key",
}

SECRET_HEADER_FRAGMENTS = (
    "token",
    "secret",
    "credential",
)

SECRET_JSON_KEYS = {
    "api_key",
    "apikey",
    "access_token",
    "authorization",
    "auth",
    "bearer",
    "client_secret",
    "cookie",
    "id_token",
    "key",
    "password",
    "refresh_token",
    "secret",
    "session",
    "token",
}


class CaptureConfig:
    def __init__(self) -> None:
        upstream = require_env("CAPTURE_UPSTREAM_BASE_URL")
        parsed = urllib.parse.urlparse(upstream)
        if parsed.scheme != "https" or not parsed.netloc:
            raise SystemExit("CAPTURE_UPSTREAM_BASE_URL must be an https:// URL")
        self.upstream = parsed
        self.provider = require_env("CAPTURE_PROVIDER")
        self.case = require_env("CAPTURE_CASE")
        self.source = os.environ.get("CAPTURE_SOURCE")
        self.wire = os.environ.get("CAPTURE_WIRE")
        self.purpose = os.environ.get("CAPTURE_PURPOSE")
        self.backend = os.environ.get("CAPTURE_BACKEND")
        self.model = os.environ.get("CAPTURE_MODEL")
        self.api_version = os.environ.get("CAPTURE_API_VERSION")
        self.listen_host = os.environ.get("CAPTURE_LISTEN_HOST", "127.0.0.1")
        self.listen_port = int(os.environ.get("CAPTURE_LISTEN_PORT", "8765"))
        self.chunk_size = int(os.environ.get("CAPTURE_CHUNK_SIZE", "1024"))
        default_fixture_dir = pathlib.Path(__file__).resolve().parents[1] / "fixtures" / "providers"
        self.fixture_root = pathlib.Path(os.environ.get("CAPTURE_FIXTURE_DIR", str(default_fixture_dir))).resolve()
        force_default = "48" if "truncated" in self.case else ""
        force_value = os.environ.get("CAPTURE_FORCE_MAX_TOKENS", force_default)
        self.force_max_tokens = int(force_value) if force_value else None


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


class CaptureHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "turnturn-capture-proxy/0.1"

    def do_GET(self) -> None:  # noqa: N802
        self._handle()

    def do_POST(self) -> None:  # noqa: N802
        self._handle()

    def do_PUT(self) -> None:  # noqa: N802
        self._handle()

    def do_PATCH(self) -> None:  # noqa: N802
        self._handle()

    def do_DELETE(self) -> None:  # noqa: N802
        self._handle()

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), fmt % args))

    def _handle(self) -> None:
        config: CaptureConfig = self.server.config  # type: ignore[attr-defined]
        started = time.time()
        fixture_dir = make_fixture_dir(config)
        request_body = self._read_request_body()
        rewritten_body, rewrite = maybe_rewrite_request_body(request_body, config)
        fixture_body, body_scrub = scrub_request_body(rewritten_body)
        write_bytes(fixture_dir / "request.body", fixture_body)
        write_json(
            fixture_dir / "request.json",
            {
                "method": self.command,
                "path": self.path,
                "headers": headers_to_json(self.headers.items(), redact=True),
                "bodyFile": "request.body",
                "bodyScrub": body_scrub,
                "rewrite": rewrite,
            },
        )

        upstream_response: Optional[http.client.HTTPResponse] = None
        response_started = False
        response_bytes = 0
        error: Optional[str] = None
        try:
            conn = self._connect_upstream(config)
            upstream_path = upstream_request_path(config.upstream, self.path)
            conn.request(
                self.command,
                upstream_path,
                body=rewritten_body if rewritten_body else None,
                headers=forward_headers(self.headers.items(), config.upstream.netloc, len(rewritten_body)),
            )
            upstream_response = conn.getresponse()
            response_started = True
            self.send_response(upstream_response.status, upstream_response.reason)
            for key, value in upstream_response.getheaders():
                if key.lower() not in HOP_BY_HOP_HEADERS:
                    self.send_header(key, value)
            self.send_header("Connection", "close")
            self.end_headers()

            with open(fixture_dir / "response.sse", "wb") as response_file:
                while True:
                    chunk = upstream_response.read1(config.chunk_size)
                    if not chunk:
                        break
                    response_file.write(chunk)
                    response_file.flush()
                    response_bytes += len(chunk)
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except Exception as exc:  # pragma: no cover - defensive capture path
            error = repr(exc)
            if not response_started:
                self.send_error(502, explain=error)
        finally:
            duration_ms = round((time.time() - started) * 1000)
            if upstream_response is not None:
                status = upstream_response.status
                reason = upstream_response.reason
                response_headers = headers_to_json(upstream_response.getheaders(), redact=True)
            else:
                status = None
                reason = None
                response_headers = []
            write_json(
                fixture_dir / "meta.json",
                omit_none({
                    "provider": config.provider,
                    "case": config.case,
                    "source": config.source,
                    "wire": config.wire,
                    "purpose": config.purpose,
                    "backend": config.backend,
                    "model": config.model,
                    "apiVersion": config.api_version,
                    "capturedAt": _dt.datetime.now(_dt.timezone.utc).isoformat(),
                    "upstream": config.upstream.geturl(),
                    "method": self.command,
                    "path": self.path,
                    "status": status,
                    "reason": reason,
                    "responseHeaders": response_headers,
                    "responseBytes": response_bytes,
                    "durationMs": duration_ms,
                    "synthetic": False,
                    "error": error,
                }),
            )
            sys.stderr.write("captured %s %s -> %s (%s bytes) at %s\n" % (self.command, self.path, status, response_bytes, fixture_dir))
            self.close_connection = True

    def _read_request_body(self) -> bytes:
        length = self.headers.get("content-length")
        if not length:
            return b""
        return self.rfile.read(int(length))

    def _connect_upstream(self, config: CaptureConfig) -> http.client.HTTPSConnection:
        return http.client.HTTPSConnection(config.upstream.netloc, timeout=120)


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit("%s is required" % name)
    return value


def make_fixture_dir(config: CaptureConfig) -> pathlib.Path:
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    fixture_dir = config.fixture_root / config.provider / config.case / stamp
    fixture_dir.mkdir(parents=True, exist_ok=True)
    return fixture_dir


def maybe_rewrite_request_body(body: bytes, config: CaptureConfig) -> Tuple[bytes, Dict[str, object]]:
    if not body or config.force_max_tokens is None:
        return body, {"applied": False}
    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception:
        return body, {"applied": False, "reason": "body was not utf8 json"}
    if not isinstance(payload, dict):
        return body, {"applied": False, "reason": "body was not a json object"}

    changed: Dict[str, object] = {}
    for key in ("max_tokens", "max_output_tokens"):
        if key in payload:
            changed[key] = {"from": payload[key], "to": config.force_max_tokens}
            payload[key] = config.force_max_tokens
    if not changed:
        return body, {"applied": False, "reason": "no max token field present"}
    rewritten = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return rewritten, {"applied": True, "fields": changed}


def scrub_request_body(body: bytes) -> Tuple[bytes, Dict[str, object]]:
    if not body:
        return body, {"applied": False}
    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception:
        return body, {"applied": False, "reason": "body was not utf8 json"}
    scrubbed, paths = scrub_json_secrets(payload)
    if not paths:
        return body, {"applied": False}
    return json.dumps(scrubbed, separators=(",", ":"), ensure_ascii=False).encode("utf-8"), {
        "applied": True,
        "paths": paths,
    }


def scrub_json_secrets(value: object, path: str = "$") -> Tuple[object, list]:
    if isinstance(value, dict):
        output: Dict[str, object] = {}
        paths = []
        for key, entry in value.items():
            child_path = "%s.%s" % (path, key)
            if is_secret_json_key(key):
                output[key] = "[REDACTED]"
                paths.append(child_path)
            else:
                scrubbed, child_paths = scrub_json_secrets(entry, child_path)
                output[key] = scrubbed
                paths.extend(child_paths)
        return output, paths
    if isinstance(value, list):
        output = []
        paths = []
        for index, entry in enumerate(value):
            scrubbed, child_paths = scrub_json_secrets(entry, "%s[%s]" % (path, index))
            output.append(scrubbed)
            paths.extend(child_paths)
        return output, paths
    return value, []


def is_secret_json_key(key: str) -> bool:
    lower = key.lower().replace("-", "_")
    return lower in SECRET_JSON_KEYS or any(fragment in lower for fragment in SECRET_HEADER_FRAGMENTS)


def forward_headers(headers: Iterable[Tuple[str, str]], upstream_host: str, body_length: int) -> Dict[str, str]:
    output: Dict[str, str] = {}
    for key, value in headers:
        lower = key.lower()
        if lower in HOP_BY_HOP_HEADERS or lower == "host" or lower == "content-length":
            continue
        output[key] = value
    output["Host"] = upstream_host
    if body_length:
        output["Content-Length"] = str(body_length)
    return output


def upstream_request_path(upstream: urllib.parse.ParseResult, incoming_path: str) -> str:
    base = upstream.path.rstrip("/")
    return "%s%s" % (base, incoming_path)


def headers_to_json(headers: Iterable[Tuple[str, str]], redact: bool = False) -> list:
    return [{"name": key, "value": redact_header_value(key, value) if redact else value} for key, value in headers]


def redact_header_value(name: str, value: str) -> str:
    lower = name.lower()
    if lower in SECRET_HEADER_NAMES or any(fragment in lower for fragment in SECRET_HEADER_FRAGMENTS):
        return "[REDACTED]"
    return value


def omit_none(value: Dict[str, object]) -> Dict[str, object]:
    return {key: entry for key, entry in value.items() if entry is not None}


def write_json(path: pathlib.Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_bytes(path: pathlib.Path, value: bytes) -> None:
    path.write_bytes(value)


def main() -> None:
    config = CaptureConfig()
    server = ThreadingHTTPServer((config.listen_host, config.listen_port), CaptureHandler)
    server.config = config  # type: ignore[attr-defined]
    print("capture proxy listening on http://%s:%s -> %s" % (config.listen_host, config.listen_port, config.upstream.geturl()))
    print("provider=%s case=%s fixtureRoot=%s" % (config.provider, config.case, config.fixture_root))
    server.serve_forever()


if __name__ == "__main__":
    main()
