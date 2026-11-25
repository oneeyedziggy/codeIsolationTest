#!/usr/bin/sh
# DEPRECATED: superseded by the Node/Express setup (server.mjs + build.mjs).
# Use `npm run dev` (watch + live reload), `npm run build`, or `npm start` instead.
# Kept for reference only.
python3 -c '
import os, posixpath, urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(".")

SANDBOX_CSP = "; ".join([
    "sandbox allow-scripts",
    "default-src '\''none'\''",
    "script-src data:",
    "style-src '\''self'\'' '\''unsafe-inline'\''",
    "connect-src '\''none'\''",
    "img-src '\''none'\''",
    "font-src '\''none'\''",
    "media-src '\''none'\''",
    "frame-src '\''none'\''",
    "object-src '\''none'\''",
    "base-uri '\''none'\''",
    "form-action '\''none'\''",
    "webrtc '\''block'\''",
    "frame-ancestors '\''self'\'' http://localhost:8000 http://*.localhost:8000",
])

HOST_CSP = "; ".join([
    "default-src '\''self'\''",
    "script-src '\''self'\''",
    "style-src '\''self'\'' '\''unsafe-inline'\''",
    "frame-src http://*.localhost:8000",
])

class NestedSubdomainHandler(SimpleHTTPRequestHandler):
    def _subdomain_labels(self):
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        if not host.endswith(".localhost"):
            return []
        prefix = host[: -len(".localhost")]
        labels = [lbl for lbl in prefix.split(".") if lbl]
        if not labels or any(
            lbl in (".", "..") or not all(ch.isalnum() or ch in ("-", "_") for ch in lbl)
            for lbl in labels
        ):
            return []
        return labels

    def _is_iso_subdomain(self):
        labels = self._subdomain_labels()
        return bool(labels and labels[0].startswith("iso"))

    def translate_path(self, path):
        base = ROOT
        labels = self._subdomain_labels()
        if labels:
            candidate = os.path.realpath(os.path.join(ROOT, *labels))
            if candidate.startswith(ROOT + os.sep) and os.path.isdir(candidate):
                base = candidate

        clean_path = urllib.parse.urlparse(path).path
        clean_path = posixpath.normpath(urllib.parse.unquote(clean_path))
        parts = [p for p in clean_path.split("/") if p and p not in (".", "..")]
        resolved = os.path.realpath(os.path.join(base, *parts))
        if not (resolved == base or resolved.startswith(base + os.sep)):
            return os.path.join(base, "__nonexistent__")
        return resolved

    def do_POST(self):
        # <a ping> exfil probe: hyperlink-auditing pings are POSTs. If this logs,
        # the browser sent the ping despite connect-src "none" in the sandbox CSP.
        if urllib.parse.urlparse(self.path).path == "/__ping_probe__":
            body_len = int(self.headers.get("Content-Length") or 0)
            self.rfile.read(body_len)
            print(">>> <a ping> PROBE RECEIVED -- hyperlink auditing bypassed the sandbox CSP <<<")
            self.send_response(204)
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()

    def end_headers(self):
        if self._is_iso_subdomain():
            self.send_header("Content-Security-Policy", SANDBOX_CSP)
            # DNS lookups are not fetches, so CSP cannot govern them; this blocks
            # dns-prefetch exfil (data encoded into looked-up hostnames).
            self.send_header("X-DNS-Prefetch-Control", "off")
            self.send_header("Access-Control-Allow-Origin", "*")
        else:
            self.send_header("Content-Security-Policy", HOST_CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

os.makedirs(os.path.join(ROOT, "iso"), exist_ok=True)
print("Serving on http://localhost:8000 (sandbox CSP only for *.localhost starting with \"iso\")")
ThreadingHTTPServer(("127.0.0.1", 8000), NestedSubdomainHandler).serve_forever()
'