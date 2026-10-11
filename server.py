"""Local static-site server with loopback-only OCR and test publishing endpoints.

Run with: python3 server.py --port 8081
The server binds to loopback only and writes published tests inside this project.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import traceback
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MAX_IMAGE_BYTES = 24 * 1024 * 1024
MAX_TEST_BYTES = 85 * 1024 * 1024
MAX_SCAN_BYTES = 200 * 1024 * 1024
# The server-side PDF converter lives outside this repository (it needs
# poppler/Tesseract and cannot run in the browser), so it is imported by
# path rather than vendored into the site.
SCAN_SOURCE_DIR = "/data/data/com.termux/files/home"


def publish_test_payload(payload: dict) -> tuple[int, dict]:
    """Persist a validated published-test JSON package and update its catalog."""
    test = payload.get("test")
    replace = payload.get("replace") is True
    if not isinstance(test, dict):
        return 400, {"error": "Missing test object."}
    test_id = str(test.get("id", ""))
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}", test_id):
        return 400, {"error": "Test ID must contain 2–64 letters, numbers, hyphens or underscores."}
    questions = test.get("questions")
    if not isinstance(questions, list) or not questions:
        return 400, {"error": "The test must contain questions."}
    if test.get("category") not in {"rts", "allen", "mathongo", "pw", "practice", "custom"}:
        return 400, {"error": "Choose a supported test category."}
    source_numbers = [str(q.get("sourceQuestionNo")) for q in questions
                      if isinstance(q, dict) and q.get("sourceQuestionNo") is not None]
    if len(source_numbers) != len(set(source_numbers)):
        return 400, {"error": "Duplicate source question numbers require review."}
    try:
        expected_count = int(test.get("expectedQuestionCount") or 0)
    except (TypeError, ValueError):
        return 400, {"error": "Expected question count must be a whole number."}
    if expected_count and len(questions) != expected_count:
        return 400, {"error": f"Expected {expected_count} questions but found {len(questions)}."}
    if expected_count and sorted(int(n) for n in source_numbers if n.isdigit()) != list(range(1, expected_count + 1)):
        return 400, {"error": f"Source numbering must run from 1 to {expected_count}."}
    for index, question in enumerate(questions, 1):
        if not isinstance(question, dict):
            return 400, {"error": f"Question {index} is malformed."}
        if question.get("id") != index:
            return 400, {"error": f"Question {index} has invalid numbering."}
        if question.get("subject") not in {"Physics", "Chemistry", "Mathematics"}:
            return 400, {"error": f"Question {index} needs a supported subject."}
        if not str(question.get("text", "")).strip() or not str(question.get("solution", "")).strip():
            return 400, {"error": f"Question {index} needs question text and its own explanation."}
        if question.get("reviewReasons"):
            return 400, {"error": f"Question {index} is marked REVIEW REQUIRED."}
        if not (question.get("answerVerified") or question.get("answerSourceVerified")):
            return 400, {"error": f"Question {index} answer has not been verified or source matched."}
        kind, answer = question.get("type"), str(question.get("answer", ""))
        if kind in {"mcq", "multi"}:
            options = question.get("options")
            answers = answer.split(",")
            if not isinstance(options, list) or len(options) < 4 or any(not str(x).strip() for x in options[:4]):
                return 400, {"error": f"Question {index} needs four MCQ options."}
            if any(not re.fullmatch(r"[1-4]", x) for x in answers) or len(set(answers)) != len(answers) or (kind == "mcq" and len(answers) != 1):
                return 400, {"error": f"Question {index} has an invalid correct option."}
        elif kind in {"integer", "decimal"}:
            if not re.fullmatch(r"-?(?:\d+(?:\.\d*)?|\.\d+)", answer):
                return 400, {"error": f"Question {index} needs a valid numerical answer."}
        else:
            return 400, {"error": f"Question {index} has an unsupported question type."}
        if not (question.get("solutionVerified") or question.get("solutionSourceVerified")):
            return 400, {"error": f"Question {index} explanation has not been reviewed or source matched."}
        for field in ("maxMarks", "negativeMarks", "unansweredMarks"):
            try:
                value = float(question.get(field, 0))
                if not __import__("math").isfinite(value) or value < 0:
                    raise ValueError
            except (TypeError, ValueError):
                return 400, {"error": f"Question {index} has invalid {field}."}
    try:
        published = dict(test)
        published["draft"] = False
        test_bytes = json.dumps({"format": "rks-jee-published-test", "version": 1, "test": published},
                                ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError):
        return 400, {"error": "Test data is not valid JSON."}
    if len(test_bytes) > MAX_TEST_BYTES:
        return 413, {"error": "Test package exceeds the 85 MB local publishing limit."}
    target = ROOT / "published-tests"
    target.mkdir(exist_ok=True)
    catalog_path = target / "catalog.json"
    try:
        catalog = json.loads(catalog_path.read_text("utf-8")) if catalog_path.exists() else {"version": 1, "tests": []}
    except (OSError, json.JSONDecodeError):
        return 500, {"error": "The existing test catalog could not be read; no files were changed."}
    if not isinstance(catalog, dict) or catalog.get("version") != 1 or not isinstance(catalog.get("tests"), list):
        return 500, {"error": "The existing test catalog has an unsupported format."}
    tests = catalog["tests"]
    existing = next((i for i, item in enumerate(tests) if isinstance(item, dict) and item.get("id") == test_id), None)
    test_path = target / f"{test_id}.json"
    if (existing is not None or test_path.exists()) and not replace:
        return 409, {"error": "This test ID is already published. Select Replace explicitly to update it."}
    entry = {"id": test_id, "name": str(test.get("name") or test_id),
             "category": str(test.get("category") or "rts"), "date": str(test.get("date") or ""),
             "path": f"published-tests/{test_id}.json", "questions": len(questions),
             "updatedAt": datetime.now(timezone.utc).isoformat()}
    if existing is None:
        tests.append(entry)
    else:
        tests[existing] = entry
    catalog_bytes = (json.dumps(catalog, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    written = []
    try:
        for path, data in ((test_path, test_bytes), (catalog_path, catalog_bytes)):
            fd, temp_name = tempfile.mkstemp(prefix=".publish-", dir=target)
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            written.append((Path(temp_name), path))
        for temp_path, path in written:
            os.replace(temp_path, path)
    except OSError as error:
        for temp_path, _ in written:
            temp_path.unlink(missing_ok=True)
        return 500, {"error": f"Could not write the local test package: {error}"}
    return 200, {"ok": True, "id": test_id, "questions": len(questions), "path": entry["path"]}


def _multipart_boundary(content_type: str):
    """Return the multipart boundary from a Content-Type header, or None."""
    if not content_type or not content_type.lower().startswith("multipart/form-data"):
        return None
    match = re.search(r'boundary\s*=\s*"([^"]+)"', content_type) or \
        re.search(r"boundary\s*=\s*([^;]+)", content_type)
    if not match:
        return None
    boundary = match.group(1).strip()
    return boundary.encode("ascii", "ignore") if boundary else None


def _header_param(value: str, name: str):
    """Read a single parameter out of a Content-Disposition header value."""
    if not value:
        return None
    # The lookbehind stops "name" from matching the tail of "filename".
    match = re.search(rf'(?<![\w-]){name}\s*=\s*"([^"]*)"', value, re.I) or \
        re.search(rf"(?<![\w-]){name}\s*=\s*([^;]+)", value, re.I)
    return match.group(1).strip() if match else None


def parse_multipart(body: bytes, boundary: bytes) -> dict:
    """Parse a multipart/form-data body into {field: (filename, bytes)}.

    A deliberately small parser: split on the boundary, split each part on
    the blank line separating its headers from its body, and read the field
    name and filename from Content-Disposition.  It raises ValueError on
    anything malformed so the caller can answer 400 instead of crashing.
    """
    if not boundary:
        raise ValueError("The upload boundary is missing.")
    delimiter = b"--" + boundary
    fields = {}
    for chunk in body.split(delimiter):
        # Skip the leading CRLF before the first part and the closing "--".
        if chunk.startswith(b"--"):
            break
        chunk = chunk.lstrip(b"\r\n")
        if not chunk:
            continue
        split = chunk.find(b"\r\n\r\n")
        if split < 0:
            split = chunk.find(b"\n\n")
            separator = 2
        else:
            separator = 4
        if split < 0:
            raise ValueError("A form part has no header/body separator.")
        raw_headers, data = chunk[:split], chunk[split + separator:]
        if data.endswith(b"\r\n"):
            data = data[:-2]
        elif data.endswith(b"\n"):
            data = data[:-1]
        name = filename = None
        for line in raw_headers.replace(b"\r\n", b"\n").split(b"\n"):
            if line.lower().startswith(b"content-disposition:"):
                value = line.split(b":", 1)[1].decode("utf-8", "replace")
                name = _header_param(value, "name")
                filename = _header_param(value, "filename")
        if not name:
            continue
        fields[name] = (filename, data)
    return fields


def _figure_site_path(test_id: str, path) -> str:
    """Return the browser-facing site path for a cropped figure."""
    if not path:
        return ""
    if path.startswith("/tests/"):
        return path
    return f"/tests/{test_id}/figures/{os.path.basename(str(path))}"


def scan_paper_payload(fields: dict) -> tuple[int, dict]:
    """Run the external converter and persist a scanned paper as a test."""
    paper = fields.get("paper")
    if not paper or not paper[1]:
        return 400, {"error": "Upload the question paper PDF in the 'paper' field."}
    if not paper[1].startswith(b"%PDF-"):
        return 400, {"error": "The uploaded question paper is not a PDF."}
    solutions = fields.get("solutions")
    if solutions and solutions[1] and not solutions[1].startswith(b"%PDF-"):
        return 400, {"error": "The uploaded solutions file is not a PDF."}
    test_id = str((fields.get("testId") or (None, b""))[1].decode("utf-8", "replace")).strip()
    name = str((fields.get("name") or (None, b""))[1].decode("utf-8", "replace")).strip()
    category = str((fields.get("category") or (None, b""))[1].decode("utf-8", "replace")).strip()
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}", test_id):
        return 400, {"error": "Test ID must contain 2–64 letters, numbers, hyphens or underscores."}
    if not name:
        return 400, {"error": "A test name is required."}
    if category not in {"rts", "allen", "mathongo", "pw", "practice", "custom"}:
        return 400, {"error": "Choose a supported test category."}

    temp_dir = tempfile.mkdtemp(prefix="scan-paper-")
    try:
        paper_path = os.path.join(temp_dir, "paper.pdf")
        with open(paper_path, "wb") as stream:
            stream.write(paper[1])
        solution_path = None
        if solutions and solutions[1]:
            solution_path = os.path.join(temp_dir, "solutions.pdf")
            with open(solution_path, "wb") as stream:
                stream.write(solutions[1])

        if SCAN_SOURCE_DIR not in sys.path:
            sys.path.insert(0, SCAN_SOURCE_DIR)
        try:
            import scan_paper
        except Exception as error:  # noqa: BLE001 - report any import failure as 500
            return 500, {"error": "The server-side PDF converter could not be loaded.",
                         "detail": "".join(traceback.format_exception_only(type(error), error)).strip()[-600:]}
        try:
            detected = scan_paper.detect_type(paper_path)
            package = scan_paper.scan(paper_path, test_id, name, category,
                                      spdf=solution_path, outbase=temp_dir)
        except Exception as error:  # noqa: BLE001 - converter failures are 500s
            return 500, {"error": "The server-side PDF converter failed.",
                         "detail": "".join(traceback.format_exception(type(error), error, error.__traceback__)).strip()[-1200:]}
        if not isinstance(package, dict) or not isinstance(package.get("test"), dict):
            return 500, {"error": "The converter returned an unexpected result."}
        test = package["test"]
        questions = test.get("questions")
        if not isinstance(questions, list) or not questions:
            return 500, {"error": "The converter found no questions in this paper."}

        # Move the cropped figures into the site tree and point every question
        # at the published location.
        target_dir = ROOT / "tests" / test_id
        figures_dir = target_dir / "figures"
        source_figures = Path(temp_dir) / "figures"
        if source_figures.is_dir():
            figures_dir.mkdir(parents=True, exist_ok=True)
            for entry in source_figures.iterdir():
                if entry.is_file() and entry.suffix.lower() == ".png":
                    shutil.move(str(entry), str(figures_dir / entry.name))
        for question in questions:
            if not isinstance(question, dict):
                continue
            question["image"] = _figure_site_path(test_id, question.get("image"))
            option_images = question.get("optionImages")
            if isinstance(option_images, list):
                question["optionImages"] = [_figure_site_path(test_id, item) for item in option_images]
            question["solutionImage"] = _figure_site_path(test_id, question.get("solutionImage"))

        test.setdefault("slug", test_id)
        test.setdefault("date", "Practice test")
        test.setdefault("exam", "JEE Main")
        published = ROOT / "published-tests"
        published.mkdir(exist_ok=True)
        try:
            (published / f"{test_id}.json").write_text(
                json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except OSError as error:
            return 500, {"error": f"Could not write the scanned test package: {error}"}
        return 200, {"test": test, "type": detected}
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


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
        if self.path == "/api/publish-test":
            if self.client_address[0] not in {"127.0.0.1", "::1"}:
                self._json(403, {"error": "Local publishing is only available from this device."})
                return
            origin = self.headers.get("Origin")
            host = self.headers.get("Host", "")
            if origin and origin not in {f"http://{host}", f"https://{host}"}:
                self._json(403, {"error": "Cross-origin publishing is not allowed."})
                return
            if self.headers.get_content_type() != "application/json":
                self._json(415, {"error": "Send the test package as application/json."})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if not 2 <= length <= MAX_TEST_BYTES:
                self._json(413, {"error": "The test package is empty or exceeds the local limit."})
                return
            try:
                payload = json.loads(self.rfile.read(length))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._json(400, {"error": "Request body is not valid JSON."})
                return
            if not isinstance(payload, dict):
                self._json(400, {"error": "Request body must be a JSON object."})
                return
            status, result = publish_test_payload(payload)
            self._json(status, result)
            return
        if self.path == "/api/scan-paper":
            if self.client_address[0] not in {"127.0.0.1", "::1"}:
                self._json(403, {"error": "Local scanning is only available from this device."})
                return
            origin = self.headers.get("Origin")
            host = self.headers.get("Host", "")
            if origin and origin not in {f"http://{host}", f"https://{host}"}:
                self._json(403, {"error": "Cross-origin scanning is not allowed."})
                return
            boundary = _multipart_boundary(self.headers.get("Content-Type", ""))
            if not boundary:
                self._json(415, {"error": "Send the paper as multipart/form-data."})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if not 2 <= length <= MAX_SCAN_BYTES:
                self._json(413, {"error": "The uploaded PDFs are empty or exceed the 200 MB local limit."})
                return
            body = self.rfile.read(length)
            try:
                fields = parse_multipart(body, boundary)
            except ValueError as error:
                self._json(400, {"error": f"Could not read the upload: {error}"})
                return
            status, result = scan_paper_payload(fields)
            self._json(status, result)
            return
        if self.path == "/api/process-shift-pdf":
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if length <= 0 or length > MAX_TEST_BYTES:
                self._json(413, {"error": "PDF is empty or exceeds limit."})
                return
            body = self.rfile.read(length)
            pdf_bytes = body
            # Handle multipart/form-data
            if b"%PDF-" in body:
                idx = body.find(b"%PDF-")
                pdf_bytes = body[idx:]
                end_idx = pdf_bytes.rfind(b"%%EOF")
                if end_idx > 0:
                    pdf_bytes = pdf_bytes[:end_idx + 6]
            
            # Process shift PDF dynamically without hardcoded paper hijacking
            self._json(400, {"error": "Generic shift processing: use client-side Tesseract.js engine."})
            return

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
