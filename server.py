"""Local static-site server with an optional localhost Tesseract OCR endpoint.

Run with: python3 server.py --port 8081
The server binds to loopback only; /api/ocr is not exposed to the network.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MAX_IMAGE_BYTES = 24 * 1024 * 1024


class SiteHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/api/ocr-status":
            engine = shutil.which("tesseract")
            self._json(200, {"available": bool(engine), "engine": "Tesseract OCR" if engine else None})
            return
        super().do_GET()

    def do_POST(self):
        if self.path != "/api/ocr":
            self._json(404, {"error": "Unknown local endpoint."})
            return
        if self.headers.get_content_type() != "image/png":
            self._json(415, {"error": "Send a rendered PDF page as image/png."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 8 <= length <= MAX_IMAGE_BYTES:
            self._json(413, {"error": "OCR page image is empty or exceeds the 24 MB limit."})
            return
        image = self.rfile.read(length)
        if not image.startswith(b"\x89PNG\r\n\x1a\n"):
            self._json(415, {"error": "Invalid PNG page image."})
            return
        engine = shutil.which("tesseract")
        if not engine:
            self._json(503, {"error": "Tesseract is not installed on this device."})
            return
        try:
            result = subprocess.run(
                [engine, "stdin", "stdout", "-l", "eng", "--psm", "3"],
                input=image, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=60, check=False,
            )
        except subprocess.TimeoutExpired:
            self._json(504, {"error": "OCR timed out for this page."})
            return
        if result.returncode:
            detail = result.stderr.decode("utf-8", "replace")[-600:]
            self._json(500, {"error": "OCR failed.", "detail": detail})
            return
        self._json(200, {"text": result.stdout.decode("utf-8", "replace")})

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))


def main():
    parser = argparse.ArgumentParser(description="Serve the JEE site and local PDF OCR endpoint")
    parser.add_argument("--port", type=int, default=8081)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), SiteHandler)
    print(f"Serving {ROOT} at http://127.0.0.1:{args.port}/")
    print("Local OCR:", "available" if shutil.which("tesseract") else "unavailable (install Tesseract)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping server")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
