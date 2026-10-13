"""Local static-site server with loopback-only OCR and test publishing endpoints.

Run with: python3 server.py --port 8081
The server binds to loopback only and writes published tests inside this project.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
MAX_IMAGE_BYTES = 24 * 1024 * 1024
MAX_TEST_BYTES = 85 * 1024 * 1024
MAX_SCAN_BYTES = 200 * 1024 * 1024
# The server-side PDF converter lives outside this repository (it needs
# poppler/Tesseract and cannot run in the browser), so it is imported by
# path rather than vendored into the site.
SCAN_SOURCE_DIR = "/data/data/com.termux/files/home"
# A whole-paper conversion is many minutes of Gemini calls, so it runs on a
# worker thread and is polled; the job record is durable because the cache it
# resumes from is (`~/.paper_to_test/<content-hash>/`).
CONVERT_DIR = Path(SCAN_SOURCE_DIR) / ".paper_to_test" / "jobs"
# A draft sent for review is written here, never into `published-tests/`: the
# whole point of the handoff is that a flagged draft can leave the editor
# without reaching the site.
REVIEW_DIR = Path(SCAN_SOURCE_DIR) / ".paper_to_test" / "review"
CONVERT_JOBS: dict[str, dict] = {}
CONVERT_LOCK = threading.Lock()
CONVERT_ACTIVE: dict[str, str | None] = {"job": None}


def test_problems(test) -> list[str]:
    """Every reason this test cannot be published, in the order they are checked.

    `publish_test_payload` wants only the first -- it reports one problem at a
    time, which is right for a person fixing their own draft.  The review
    handoff wants all of them: a draft is sent over precisely to learn
    everything standing between it and the site, and learning the second
    problem only after fixing the first is what makes that loop slow.

    The messages and their order are the ones `publish_test_payload` has always
    sent, so `problems[0]` is exactly what it used to return.
    """
    if not isinstance(test, dict):
        return ["Missing test object."]
    problems: list[str] = []
    test_id = str(test.get("id", ""))
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}", test_id):
        problems.append("Test ID must contain 2–64 letters, numbers, hyphens or underscores.")
    questions = test.get("questions")
    if not isinstance(questions, list) or not questions:
        return problems + ["The test must contain questions."]
    if test.get("category") not in {"rts", "alline", "mathongo", "pw", "practice", "custom"}:
        problems.append("Choose a supported test category.")
    source_numbers = [str(q.get("sourceQuestionNo")) for q in questions
                      if isinstance(q, dict) and q.get("sourceQuestionNo") is not None]
    if len(source_numbers) != len(set(source_numbers)):
        problems.append("Duplicate source question numbers require review.")
    try:
        expected_count = int(test.get("expectedQuestionCount") or 0)
    except (TypeError, ValueError):
        problems.append("Expected question count must be a whole number.")
        expected_count = 0
    # A count that is simply wrong is the more useful thing to say, and saying
    # both at once reads as two faults where there is one.
    if expected_count and len(questions) != expected_count:
        problems.append(f"Expected {expected_count} questions but found {len(questions)}.")
    elif expected_count and sorted(int(n) for n in source_numbers if n.isdigit()) != list(range(1, expected_count + 1)):
        problems.append(f"Source numbering must run from 1 to {expected_count}.")
    for index, question in enumerate(questions, 1):
        if not isinstance(question, dict):
            problems.append(f"Question {index} is malformed.")
            continue
        if question.get("id") != index:
            problems.append(f"Question {index} has invalid numbering.")
        if question.get("subject") not in {"Physics", "Chemistry", "Mathematics"}:
            problems.append(f"Question {index} needs a supported subject.")
        if not str(question.get("text", "")).strip() or not str(question.get("solution", "")).strip():
            problems.append(f"Question {index} needs question text and its own explanation.")
        if question.get("reviewReasons"):
            problems.append(f"Question {index} is marked REVIEW REQUIRED.")
        if not (question.get("answerVerified") or question.get("answerSourceVerified")):
            problems.append(f"Question {index} answer has not been verified or source matched.")
        kind, answer = question.get("type"), str(question.get("answer", ""))
        if kind in {"mcq", "multi"}:
            options = question.get("options")
            answers = answer.split(",")
            if not isinstance(options, list) or len(options) < 4 or any(not str(x).strip() for x in options[:4]):
                problems.append(f"Question {index} needs four MCQ options.")
            if any(not re.fullmatch(r"[1-4]", x) for x in answers) or len(set(answers)) != len(answers) or (kind == "mcq" and len(answers) != 1):
                problems.append(f"Question {index} has an invalid correct option.")
        elif kind in {"integer", "decimal"}:
            if not re.fullmatch(r"-?(?:\d+(?:\.\d*)?|\.\d+)", answer):
                problems.append(f"Question {index} needs a valid numerical answer.")
        else:
            problems.append(f"Question {index} has an unsupported question type.")
        if not (question.get("solutionVerified") or question.get("solutionSourceVerified")):
            problems.append(f"Question {index} explanation has not been reviewed or source matched.")
        for field in ("maxMarks", "negativeMarks", "unansweredMarks"):
            try:
                value = float(question.get(field, 0))
                if not math.isfinite(value) or value < 0:
                    raise ValueError
            except (TypeError, ValueError):
                problems.append(f"Question {index} has invalid {field}.")
    return problems


def publish_test_payload(payload: dict) -> tuple[int, dict]:
    """Persist a validated published-test JSON package and update its catalog."""
    test = payload.get("test")
    replace = payload.get("replace") is True
    problems = test_problems(test)
    if problems:
        return 400, {"error": problems[0]}
    test_id = str(test.get("id", ""))
    questions = test.get("questions")
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


def _excerpt(value, limit: int = 240) -> str:
    """One line of a field, short enough to read in a list."""
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def review_markdown(test: dict, problems: list[str]) -> str:
    """The reviewer's reading of a draft: what blocks it, then what to check.

    It leads with the blockers, because they are the reason the draft is here
    and they are what the editor's own publish button would refuse.  Then every
    flagged question in turn, carrying enough of each to recognise it without
    opening the JSON, and finally the questions that are only waiting on a tick
    -- those block publication too, but nothing about them needs changing.
    """
    questions = [q for q in test.get("questions") or [] if isinstance(q, dict)]
    flagged = [q for q in questions if q.get("reviewReasons")]

    def all_verified(q):
        return ((q.get("answerVerified") or q.get("answerSourceVerified"))
                and (q.get("solutionVerified") or q.get("solutionSourceVerified")))

    # Flagged questions are listed above; what is left here blocks publication
    # on a tick alone, so the reviewer only needs their numbers.
    awaiting = [q for q in questions if not q.get("reviewReasons") and not all_verified(q)]
    out = ["# Review packet: %s" % (test.get("name") or test.get("id") or "untitled"),
           "",
           "- id: `%s`" % test.get("id"),
           "- category: %s   exam: %s   questions: %d"
           % (test.get("category"), test.get("exam") or "—", len(questions)),
           "- received: %s" % datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "",
           "## Blocking publication (%d)" % len(problems),
           ""]
    if problems:
        out += ["%d. %s" % (i, p) for i, p in enumerate(problems, 1)]
    else:
        out.append("Nothing — this draft passes every check publishing makes.")
    out += ["", "## Flagged for review (%d)" % len(flagged), ""]
    if not flagged:
        out.append("None.")
    for q in flagged:
        out += ["### Q%s (source %s) — %s, %s" % (
                    q.get("id"), q.get("sourceQuestionNo") or "—",
                    q.get("subject") or "—", q.get("type") or "—"),
                "",
                "- answer: `%s`   answer verified: %s   solution verified: %s"
                % (q.get("answer"), bool(q.get("answerVerified") or q.get("answerSourceVerified")),
                   bool(q.get("solutionVerified") or q.get("solutionSourceVerified"))),
                "- flags:"]
        out += ["  - %s" % r for r in q.get("reviewReasons") or []]
        out += ["- text: %s" % _excerpt(q.get("text")),
                "- solution (%d chars): %s" % (len(str(q.get("solution") or "")),
                                               _excerpt(q.get("solution"))),
                ""]
    out += ["## Awaiting verification only (%d)" % len(awaiting), ""]
    if awaiting:
        out += ["No content change needed; these block publication until ticked.",
                "",
                "`%s`" % "`, `".join(str(q.get("id")) for q in awaiting)]
    else:
        out.append("None.")
    out += ["", "## Finishing", "",
            "    python3 ~/cf/review_packet.py --check %s" % test.get("id"),
            "    python3 ~/cf/review_packet.py --publish %s" % test.get("id"),
            ""]
    return "\n".join(out)


def review_request_payload(payload: dict) -> tuple[int, dict]:
    """Record a draft for review, without publishing it.

    The owner's workflow is to send a draft over and have it come back fixed,
    so this writes what a reviewer needs -- the draft itself, and a reading of
    it that says what stands in the way -- and touches nothing under
    `published-tests/`.  Publishing stays a separate, deliberate call.

    A draft is allowed to be one that cannot be published.  That is the point:
    the flags that would stop `publish_test_payload` are exactly what is being
    asked about, so this endpoint validates only enough to write a file.
    """
    test = payload.get("test")
    if not isinstance(test, dict):
        return 400, {"error": "Missing test object."}
    test_id = str(test.get("id", ""))
    # The id becomes a directory name, so it is held to the same shape the
    # publishing path allows; a leading "." or a "/" never gets this far.
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}", test_id):
        return 400, {"error": "Test ID must contain 2–64 letters, numbers, hyphens or underscores."}
    questions = test.get("questions")
    if not isinstance(questions, list) or not questions:
        return 400, {"error": "The test must contain questions."}
    problems = test_problems(test)
    folder = REVIEW_DIR / test_id
    try:
        folder.mkdir(parents=True, exist_ok=True)
        draft = folder / "draft.json"
        if draft.exists():
            # A resend must not destroy the copy the reviewer may be reading.
            os.replace(draft, folder / "draft.previous.json")
        draft.write_text(json.dumps({"test": test, "replace": True}, ensure_ascii=False),
                         "utf-8")
        (folder / "review.md").write_text(review_markdown(test, problems), "utf-8")
    except OSError as error:
        return 500, {"error": f"Could not write the review packet: {error}"}
    return 200, {"ok": True, "id": test_id, "questions": len(questions),
                 "flagged": sum(1 for q in questions
                                if isinstance(q, dict) and q.get("reviewReasons")),
                 "problems": problems, "path": str(folder),
                 "receivedAt": datetime.now(timezone.utc).isoformat()}


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
    if category not in {"rts", "alline", "mathongo", "pw", "practice", "custom"}:
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


def _field(fields: dict, name: str, default: str = "") -> str:
    """A text form field's value, decoded."""
    entry = fields.get(name)
    if not entry:
        return default
    raw = entry[1] if isinstance(entry, tuple) else entry
    return raw.decode("utf-8", "replace").strip()


def _job_path(job_id: str) -> Path:
    return CONVERT_DIR / f"{job_id}.json"


def _job_write(record: dict) -> None:
    """Persist a job record atomically.  Call with CONVERT_LOCK held."""
    CONVERT_DIR.mkdir(parents=True, exist_ok=True)
    target = _job_path(record["job"])
    tmp = target.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, target)


def _job_read(job_id: str) -> dict | None:
    try:
        return json.loads(_job_path(job_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def convert_status(job_id: str) -> tuple[int, dict]:
    """The current state of a conversion job, for the editor's progress bar."""
    with CONVERT_LOCK:
        record = CONVERT_JOBS.get(job_id) or _job_read(job_id)
    if not record:
        return 404, {"error": "Unknown conversion job."}
    out = {key: record.get(key) for key in
           ("job", "state", "stage", "done", "total", "current", "note",
            "testId", "warnings", "error")}
    if record.get("state") == "done":
        out["test"] = record.get("test")
    return 200, out


def _convert_worker(job_id: str, pdf_path: str, test_id: str, name: str,
                    category: str, kind: str | None,
                    subjects: set | None, workers: int) -> None:
    """Run the conversion off the request thread and record its progress."""
    record = CONVERT_JOBS[job_id]

    def progress(stage, a, b, subject, note):
        with CONVERT_LOCK:
            record["stage"] = stage
            record["current"] = subject
            record["note"] = note
            if isinstance(a, int):
                record["done"] = a
            if b:
                record["total"] = b
            _job_write(record)

    try:
        # Imported here, not at module scope: the converter pulls in Pillow and
        # Tesseract bindings, and the server must start fast.
        for path in (os.path.join(SCAN_SOURCE_DIR, "cf"), SCAN_SOURCE_DIR):
            if path not in sys.path:
                sys.path.insert(0, path)
        import paper_to_test as converter
        result = converter.convert(pdf_path, test_id, name, category,
                                   kind=kind, on_progress=progress,
                                   subjects=subjects, workers=workers)
        with CONVERT_LOCK:
            record["test"] = result["test"]
            record["warnings"] = result["warnings"]
            record["state"] = "done"
    except Exception as error:                       # noqa: BLE001
        with CONVERT_LOCK:
            record["state"] = "error"
            record["error"] = f"{type(error).__name__}: {error}"
            record["traceback"] = traceback.format_exc()[-2000:]
    finally:
        with CONVERT_LOCK:
            _job_write(record)
            if CONVERT_ACTIVE.get("job") == job_id:
                CONVERT_ACTIVE["job"] = None


def convert_paper_payload(fields: dict) -> tuple[int, dict]:
    """Start a whole-paper conversion.  Returns (status, {"job": id})."""
    entry = fields.get("pdf")
    if not entry or not entry[1]:
        return 400, {"error": "Attach the paper PDF as the 'pdf' field."}
    pdf_bytes = entry[1]
    if not pdf_bytes.startswith(b"%PDF-"):
        return 415, {"error": "The upload is not a PDF."}
    test_id = _field(fields, "testId")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}", test_id):
        return 400, {"error": "Test ID must contain 2-64 letters, numbers, "
                              "hyphens or underscores."}
    name = _field(fields, "name") or test_id
    category = _field(fields, "category") or "practice"
    if category not in {"rts", "alline", "mathongo", "pw", "practice", "custom"}:
        return 400, {"error": "Choose a supported test category."}
    kind = _field(fields, "kind") or None
    if kind not in (None, "jrts", "mpdf", "scan"):
        return 400, {"error": "Family must be jrts, mpdf or scan."}
    raw_subjects = _field(fields, "subjects")
    subjects = {s.strip() for s in raw_subjects.split(",") if s.strip()} or None
    # Pages are converted several at a time: one page is minutes of the model
    # writing its answer, so a serial 24-page scan runs for over an hour.
    try:
        workers = int(_field(fields, "workers") or 4)
    except ValueError:
        workers = 4
    workers = max(1, min(6, workers))

    # Name the upload after its content, so re-uploading the same paper resumes
    # the existing cache instead of re-spending the whole API budget.
    digest = hashlib.sha256(pdf_bytes).hexdigest()[:16]
    uploads = Path(SCAN_SOURCE_DIR) / ".paper_to_test" / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    pdf_path = uploads / f"{digest}.pdf"
    if not pdf_path.exists():
        tmp = pdf_path.with_suffix(".pdf.tmp")
        tmp.write_bytes(pdf_bytes)
        os.replace(tmp, pdf_path)

    with CONVERT_LOCK:
        running = CONVERT_ACTIVE.get("job")
        if running:
            return 409, {"error": "A conversion is already running. Wait for it "
                                  "to finish before starting another.",
                         "job": running}
        job_id = os.urandom(6).hex()
        CONVERT_ACTIVE["job"] = job_id
        CONVERT_JOBS[job_id] = {
            "job": job_id, "state": "running", "stage": "starting",
            "done": 0, "total": 0, "current": "", "note": "",
            "testId": test_id, "name": name, "category": category,
            "kind": kind, "started": time.time(),
        }
        _job_write(CONVERT_JOBS[job_id])

    threading.Thread(
        target=_convert_worker,
        args=(job_id, str(pdf_path), test_id, name, category, kind, subjects,
              workers),
        daemon=True,
    ).start()
    return 202, {"job": job_id, "testId": test_id}


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

    def _local_only(self, what: str) -> bool:
        """Reject anything not from this device, or not from this page.

        Every endpoint that can write to the repository or spend the Gemini
        quota says the same two things in the same order; only the noun
        changes, so only the noun is a parameter.  Returns False once the
        refusal has been sent.
        """
        if self.client_address[0] not in {"127.0.0.1", "::1"}:
            self._json(403, {"error": f"Local {what} is only available from this device."})
            return False
        origin = self.headers.get("Origin")
        host = self.headers.get("Host", "")
        if origin and origin not in {f"http://{host}", f"https://{host}"}:
            self._json(403, {"error": f"Cross-origin {what} is not allowed."})
            return False
        return True

    def _json_body(self, limit: int) -> dict | None:
        """The request body as a JSON object, or None once the error is sent."""
        if self.headers.get_content_type() != "application/json":
            self._json(415, {"error": "Send the test package as application/json."})
            return None
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 2 <= length <= limit:
            self._json(413, {"error": "The test package is empty or exceeds the local limit."})
            return None
        try:
            payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._json(400, {"error": "Request body is not valid JSON."})
            return None
        if not isinstance(payload, dict):
            self._json(400, {"error": "Request body must be a JSON object."})
            return None
        return payload

    def do_GET(self):
        if self.path == "/api/ocr-status":
            engine = shutil.which("tesseract")
            self._json(200, {"available": bool(engine), "engine": "Tesseract OCR" if engine else None})
            return
        if self.path.startswith("/api/convert-status"):
            if not self._local_only("conversion"):
                return
            query = parse_qs(urlparse(self.path).query)
            job_id = (query.get("job") or [""])[0]
            if not re.fullmatch(r"[0-9a-f]{12}", job_id):
                self._json(400, {"error": "Missing or malformed job id."})
                return
            status, result = convert_status(job_id)
            self._json(status, result)
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/publish-test":
            if not self._local_only("publishing"):
                return
            payload = self._json_body(MAX_TEST_BYTES)
            if payload is None:
                return
            status, result = publish_test_payload(payload)
            self._json(status, result)
            return
        if self.path == "/api/review-request":
            if not self._local_only("review"):
                return
            payload = self._json_body(MAX_TEST_BYTES)
            if payload is None:
                return
            status, result = review_request_payload(payload)
            self._json(status, result)
            return
        if self.path == "/api/scan-paper":
            if not self._local_only("scanning"):
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
        if self.path == "/api/convert-paper":
            if not self._local_only("conversion"):
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
                self._json(413, {"error": "The uploaded paper is empty or exceeds the 200 MB local limit."})
                return
            try:
                fields = parse_multipart(self.rfile.read(length), boundary)
            except ValueError as error:
                self._json(400, {"error": f"Could not read the upload: {error}"})
                return
            status, result = convert_paper_payload(fields)
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
