"""Serve the equipment library and keep imported manuals outside the web root."""
import argparse
import json
import re
import shutil
import sqlite3
import subprocess
import tempfile
from contextlib import closing, nullcontext
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PureWindowsPath
from threading import Lock, Semaphore, Thread
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import UUID, uuid4

import production as prod
from server.capture_guide import capture_guide
from server.gemini_live import issue_token
from server.device_pairing import DevicePairing
from server.alignment_store import latest_record, save_record, save_photo

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
MAX_PDF = 128 * 1024 * 1024
MAX_VIDEO = 64 * 1024 * 1024
USER_ID = r"[A-Z0-9][A-Z0-9_-]{0,31}"
LIBRARY_PATH = re.compile(rf"/users/({USER_ID})/")
MANUAL_PATH = re.compile(rf"/api/users/({USER_ID})/manuals(?:/(pdf-[0-9a-f]{{32}})/(pdf|cover))?")
USER_PATH = re.compile(rf"/api/users/({USER_ID})")
CAPTURE_PATH = re.compile(rf"/api/users/({USER_ID})/manuals/(pdf-[0-9a-f]{{32}})/captures(?:/([0-9a-f]{{32}}))?")
S4_ASSET = r"S4/(?:alignment\.json|alignment-(?:record|latest)\.json|alignment-records/[a-f0-9-]{36}\.json|alignment-photos/[a-f0-9]{64}\.jpg|[a-f0-9]{16}/revisions/[a-f0-9]{16}/S2/(?:bindings\.json|model\.glb))"
WORK_PATH = re.compile(rf"/api/users/({USER_ID})/manuals/(pdf-[0-9a-f]{{32}})/workflow(?:/(S1/task_step\.json|S1/figure/p[0-9]{{3,}}-[0-9]{{2,}}\.png|S2/bindings\.json|S2/model\.glb|S3/guide\.json|{S4_ASSET}))?")
library_lock = Lock()
active = set()
generation_slot = Semaphore(1)
demo_upload_slots = Semaphore(3)
DEMO_STORAGE_LIMIT = 2 * 1024**3


def user_id(value):
    value = value.strip()
    if not value.isascii() or not re.fullmatch(USER_ID, value.upper()) or PureWindowsPath(value).is_reserved():
        return None
    return value.upper()


def library_path(shared_database, participant):
    # Older installations used one shared DB. Keep its contents under a distinct ID.
    return shared_database if participant == "LEGACY" else shared_database.parent / "users" / participant / "manuals.sqlite3"


def open_library(path, create=False):
    if create:
        path.parent.mkdir(parents=True, exist_ok=True)
    elif not path.is_file():
        raise FileNotFoundError(path)
    db = sqlite3.connect(path.resolve().as_uri() + ("?mode=rwc" if create else "?mode=rw"), uri=True)
    try:
        with db:
            db.execute("CREATE TABLE IF NOT EXISTS manuals (id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT NOT NULL, pdf BLOB NOT NULL, cover BLOB)")
            db.execute("CREATE TABLE IF NOT EXISTS identity (generation TEXT NOT NULL)")
            db.execute("INSERT INTO identity SELECT ? WHERE NOT EXISTS (SELECT 1 FROM identity)", (uuid4().hex,))
            db.execute("""CREATE TABLE IF NOT EXISTS production (
                id TEXT PRIMARY KEY, stage TEXT NOT NULL, candidates TEXT NOT NULL DEFAULT '[]',
                error TEXT NOT NULL DEFAULT '')""")
    except sqlite3.Error:
        db.close()
        raise
    return db


def still_current(db, token, identifier, stage):
    return db.execute("""SELECT 1 FROM identity, production WHERE generation=? AND id=? AND stage=?""",
                      (token, identifier, stage)).fetchone()


def produce(path, token, identifier):
    with generation_slot:
        while True:
            with library_lock:
                if not path.is_file():
                    return
                with closing(open_library(path)) as db:
                    row = db.execute("""SELECT stage, name, model, pdf FROM production JOIN manuals USING(id), identity
                        WHERE id=? AND generation=? AND error='' AND stage IN ('models','s1','s2')""",
                                     (identifier, token)).fetchone()
                if not row:
                    return
            stage, name, model, pdf = row
            root = prod.stage_root(path, token, identifier, model)
            try:
                with (tempfile.TemporaryDirectory(prefix="manual-stage-") if stage == "models" else nullcontext(root)) as temp:
                    work = Path(temp)
                    inputs = {"pdf_id": identifier, "name": name, "model": model}
                    with library_lock:
                        if stage == "models":
                            (work / "manual.pdf").write_bytes(pdf)
                            (work / "input.json").write_text(json.dumps(inputs, ensure_ascii=False), encoding="utf-8")
                        else:
                            with closing(open_library(path)) as db:
                                if not still_current(db, token, identifier, stage):
                                    return
                            if stage == "s1":
                                prod.select_workspace(path, token, identifier, model, pdf)
                            else:
                                if not (root / "manual.pdf").exists():
                                    (root / "manual.pdf").write_bytes(pdf)
                                prod.prepare_bindings(root)  # Also resume S2 imports created before templates existed.
                    page_count = prod.run_generator(stage, work)
                    choices = []
                    if stage == "models":
                        choices = prod.candidates(work)
                        next_stage = "select"
                    elif stage == "s1":
                        folder = prod.directory(work / "S1")
                        prod.check_s1(folder, identifier, model, page_count)
                        next_stage = "s2"
                    else:
                        folder = prod.directory(work / "S2")
                        prod.check_s2(folder, *prod.check_s1(root / "S1", identifier, model))
                        next_stage = "ready"
                    with library_lock, closing(open_library(path)) as db, db:
                        if not still_current(db, token, identifier, stage):
                            return
                        if next_stage == "s2":
                            prod.prepare_bindings(root)
                        db.execute("UPDATE production SET stage=?, candidates=? WHERE id=?",
                                   (next_stage, json.dumps(choices, ensure_ascii=False), identifier))
            except Exception as exc:
                if isinstance(exc, subprocess.TimeoutExpired):
                    error = "生成が制限時間に達しました。再試行できます。"
                elif isinstance(exc, ValueError) and not isinstance(exc, json.JSONDecodeError):
                    error = str(exc)[:300]
                else:
                    error = "成果物が揃わないか、読み取れませんでした。再試行できます。"
                with library_lock:
                    if path.is_file():
                        with closing(open_library(path)) as db, db:
                            if still_current(db, token, identifier, stage):
                                db.execute("UPDATE production SET error=? WHERE id=?", (error, identifier))
                return


def schedule(path, token, identifier):
    # Called with the library lock. Opening the page resumes interrupted stages.
    key = (path, token, identifier)
    if key in active:
        return
    active.add(key)

    def worker():
        try:
            produce(*key)
        finally:
            with library_lock:
                active.discard(key)

    Thread(target=worker, daemon=True).start()


class Library(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def parse_request(self):
        if not super().parse_request():
            return False
        if self.headers.get("Host") not in {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}:
            self.send_error(403)
            return False
        return True

    def end_headers(self):
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Host-Management-Version", "11")
        if getattr(self, "path", "").partition("?")[0] in {
            "/support.html", "/support.css", "/support.js", "/viewer.js", "/quest-controls.svg", "/quest-lock.png"
        }:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def json_response(self, status, data, generation=None):
        self.payload(status, "application/json; charset=utf-8", json.dumps(data, ensure_ascii=False).encode(), generation)

    def payload(self, status, mime, body, generation=None):
        self.send_response(status)
        if generation:
            self.send_header("X-Library-Generation", generation)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlsplit(self.path)
        path = url.path
        if path == "/enter":
            participant = user_id(parse_qs(url.query).get("id", [""])[0])
            if participant:
                with library_lock, closing(open_library(library_path(self.server.database, participant), create=True)):
                    pass
            self.send_response(303)
            self.send_header("Location", f"/users/{participant}/" if participant else "/?invalid")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        library = LIBRARY_PATH.fullmatch(path)
        if library and user_id(library[1]):
            if not library_path(self.server.database, library[1]).is_file():
                self.send_response(303)
                self.send_header("Location", "/")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            self.path = "/library.html"
            return super().do_GET()
        if path == "/library.html" or path.startswith("/users/"):
            return self.send_error(404)
        if not path.startswith("/api/"):
            return super().do_GET()
        capture = CAPTURE_PATH.fullmatch(path)
        if capture and user_id(capture[1]):
            return self.captures(capture, False)
        workflow = WORK_PATH.fullmatch(path)
        if workflow and user_id(workflow[1]):
            return self.workflow(workflow, False)
        match = MANUAL_PATH.fullmatch(path)
        if not match or not user_id(match[1]):
            return self.send_error(404)
        try:
            with library_lock, closing(open_library(library_path(self.server.database, match[1]))) as db:
                if not match[2]:
                    rows = db.execute("""SELECT id,name,model,cover IS NOT NULL,stage,error FROM manuals
                        LEFT JOIN production USING(id) ORDER BY manuals.rowid DESC""")
                    listing = [dict(id=i, name=n, model=m, cover=bool(c), stage=s, failed=bool(e))
                               for i,n,m,c,s,e in rows]
                    generation = db.execute("SELECT generation FROM identity").fetchone()[0]
                else:
                    column = match[3]
                    scope = self.headers.get("X-Venue-Generation")
                    if scope is not None and (match[1] != "DEMO" or not still_current(db, scope, match[2], "ready")):
                        return self.send_error(403)
                    row = db.execute(f"SELECT {column} FROM manuals WHERE id=?", (match[2],)).fetchone()
        except FileNotFoundError:
            return self.send_error(404)
        if not match[2]:
            return self.json_response(200, listing, generation)
        if row and row[0]:
            return self.payload(200, "application/pdf" if column == "pdf" else "image/png", row[0])
        self.send_error(404)

    def do_POST(self):
        if self.path == "/api/capture-live-token":
            if self.headers.get("Origin") != f"http://{self.headers['Host']}" or self.headers.get("X-Venue-Guest"):
                return self.send_error(403)
            context = None
            try:
                size=int(self.headers.get("Content-Length", "0"))
                if not 0 <= size <= 24000: raise ValueError
                if size:
                    context=json.loads(self.rfile.read(size))["questionContext"]
                    if not isinstance(context,str) or not 0<len(context)<=6000: raise ValueError
            except (ValueError,TypeError,KeyError,UnicodeError):
                return self.send_error(400)
            try:
                return self.json_response(200, issue_token(context) if context is not None else issue_token())
            except (OSError, ValueError, KeyError):
                return self.json_response(503, {"error": "Gemini音声に接続できません。配信PCのキーと通信を確認してください。"})
        device = re.fullmatch(r"/api/devices/([1-9][0-9]{0,14})/(rename|revoke|approve|deny)", self.path)
        if self.path in ("/api/devices", "/api/devices/pending") or device:
            if not self.local_management_request():
                return self.send_error(403)
            store = DevicePairing(self.server.database.parent / "quest-wifi" / "pairing.sqlite3")
            if not device:
                return self.json_response(200, store.browsers(pending=self.path.endswith("/pending")))
            identifier = int(device[1])
            if device[2] == "rename":
                try:
                    size = int(self.headers.get("Content-Length", "0"))
                    if self.headers.get_content_type() != "application/json" or not 0 < size <= 1024:
                        raise ValueError
                    data = json.loads(self.rfile.read(size))
                    name = data.get("name") if isinstance(data, dict) else None
                    if not isinstance(name, str) or len(name.strip()) > 64 or not name.isprintable() and name:
                        raise ValueError
                except (ValueError, UnicodeError):
                    return self.send_error(400)
                found = store.rename(identifier, name.strip())
            elif device[2] in ("approve", "deny"):
                found = store.review_personal(identifier, device[2] == "approve")
            else:
                found = store.revoke(identifier)
            return self.json_response(200, {}) if found else self.send_error(404)
        venue = self.path == "/api/venue/qr"
        if venue or self.path in {"/api/device-qr", "/api/venue/status", "/api/venue/end"}:
            if not self.local_management_request():
                return self.send_error(403)
            store = DevicePairing(self.server.database.parent / "quest-wifi" / "pairing.sqlite3")
            if venue or self.path == "/api/device-qr":
                origin = store.entry(self.server.server_port)
                if not origin:
                    return self.json_response(503, {"error": "Wi-Fi配信を起動してください。"})
                if not venue:
                    personal = store.invite_device()
                    return self.json_response(200, {"url": origin + "/join/device#" + personal["invite"],
                                                    "expires": personal["expires"]})
                try:
                    with library_lock, closing(open_library(library_path(self.server.database, "DEMO"))) as db:
                        rows = db.execute("""SELECT id, name, model FROM manuals JOIN production USING(id)
                            WHERE stage='ready' ORDER BY manuals.rowid DESC""").fetchall()
                        if not rows:
                            return self.send_error(404)
                        generation = db.execute("SELECT generation FROM identity").fetchone()[0]
                        catalog = [dict(id=i, name=n, model=m, stage="ready") for i, n, m in rows]
                        result = store.venue_code(catalog, generation)
                        if result:
                            result["url"] = origin + "/join#" + result.pop("code")
                except FileNotFoundError:
                    return self.send_error(404)
                return self.json_response(200, result) if result else self.send_error(409)
            if self.path.endswith("/end"):
                store.end_venue()
            return self.json_response(200, store.venue_status())
        capture = CAPTURE_PATH.fullmatch(self.path)
        if capture and capture[3] and user_id(capture[1]):
            if self.headers.get("X-Venue-Guest"):
                if not demo_upload_slots.acquire(blocking=False):
                    return self.send_error(429)
                try:
                    return self.captures(capture, True)
                finally:
                    demo_upload_slots.release()
            return self.captures(capture, True)
        workflow = WORK_PATH.fullmatch(self.path)
        if workflow and (workflow[3] in (None, "S4/alignment-record.json") or workflow[3].startswith("S4/alignment-photos/")) and user_id(workflow[1]):
            return self.workflow(workflow, True)
        match = MANUAL_PATH.fullmatch(self.path)
        if not match or match[2] or not user_id(match[1]):
            return self.send_error(404)
        if self.headers.get("Origin") != f"http://{self.headers['Host']}":
            return self.send_error(403)
        if self.headers.get_content_type() != "application/pdf":
            return self.json_response(415, {"error": "PDFを選んでください。"})
        try:
            size = int(self.headers["Content-Length"])
            identifier = "pdf-" + UUID(self.headers["X-Import-ID"]).hex
            name = unquote(self.headers["X-Manual-Name"]).strip()
            model = unquote(self.headers.get("X-Model", "")).strip()
            if not name:
                raise ValueError
        except (ValueError, TypeError, AttributeError):
            return self.json_response(400, {"error": "機器名とファイルを確認してください。"})
        if not 0 < size <= MAX_PDF:
            return self.json_response(413, {"error": "128 MB以下のPDFを選んでください。"})
        pdf = self.rfile.read(size)
        if len(pdf) != size or b"%PDF-" not in pdf[:1024] or b"%%EOF" not in pdf[-4096:]:
            return self.json_response(422, {"error": "PDFを読み取れませんでした。ファイルを確認してください。"})
        cover = None
        if executable := shutil.which("pdftoppm"):
            try:
                result = subprocess.run([executable, "-f", "1", "-l", "1", "-singlefile", "-scale-to", "480", "-png", "-"],
                                        input=pdf, capture_output=True, timeout=12)
                if result.returncode == 0 and result.stdout.startswith(b"\x89PNG"):
                    cover = result.stdout
            except (OSError, subprocess.TimeoutExpired):
                pass
        try:
            with library_lock, closing(open_library(library_path(self.server.database, match[1]))) as db, db:
                generation = self.headers.get("X-Library-Generation")
                if generation and generation != db.execute("SELECT generation FROM identity").fetchone()[0]:
                    return self.json_response(409, {"error": "ユーザーが変更されました。ユーザー選択から開き直してください。"})
                db.execute("INSERT INTO manuals VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
                           (identifier, name, model, pdf, cover))
                if self.headers.get("X-Production") == "v1":
                    db.execute("INSERT OR IGNORE INTO production(id,stage) VALUES (?,'models')", (identifier,))
                    token = db.execute("SELECT generation FROM identity").fetchone()[0]
                    path = library_path(self.server.database, match[1])
                    if db.execute("SELECT stage FROM production WHERE id=?", (identifier,)).fetchone()[0] in ("models", "select"):
                        original = db.execute("SELECT pdf FROM manuals WHERE id=?", (identifier,)).fetchone()[0]
                        prod.import_workspace(path, token, identifier, original)
                    schedule(path, token, identifier)
        except FileNotFoundError:
            return self.json_response(404, {"error": "ユーザーは削除されました。"})
        except (sqlite3.Error, OSError):
            return self.json_response(503, {"error": "保存できませんでした。もう一度追加してください。"})
        self.json_response(201, {"id": identifier})

    def captures(self, match, post):
        participant, identifier, take = match.groups()
        path = library_path(self.server.database, participant)
        guest = self.headers.get("X-Venue-Guest")
        if guest is not None and (participant != "DEMO" or not re.fullmatch("[0-9a-f]{64}", guest)):
            return self.send_error(403)
        if post and self.headers.get("Origin") != f"http://{self.headers['Host']}":
            return self.send_error(403)
        try:
            with library_lock, closing(open_library(path)) as db:
                row = db.execute("""SELECT generation, model FROM identity, manuals JOIN production USING(id)
                                     WHERE id=? AND stage='ready'""", (identifier,)).fetchone()
                if not row:
                    return self.send_error(404)
                token, model = row
                if guest and self.headers.get("X-Venue-Generation") != token:
                    return self.send_error(403)
                root = prod.stage_root(path, token, identifier, model)
                folder = root / "S3" / "captures"
                if not post:
                    if not take:
                        entries = [prod.read_json(f) for f in folder.glob("*/capture.json")]
                        if guest:
                            entries = [item for item in entries if item.get("guest") == guest]
                        return self.json_response(200, sorted(entries, key=lambda c: c["time"], reverse=True))
                    meta = prod.read_json(folder / take / "capture.json")
                    if guest and meta.get("guest") != guest:
                        return self.send_error(404)
                    video = (folder / take / meta["file"]).open("rb")
                else:
                    if self.headers.get("X-Library-Generation") != token:
                        return self.send_error(409)
                    bindings = prod.read_json(root / "S2" / "bindings.json")
                    notes = bindings["notes"]
                    request_id = self.headers.get("X-Capture-Request")
                    guide = None
                    if request_id is not None:
                        guide = next((item for item in capture_guide(root, bindings) if item["key"] == request_id), None)
                        if guide is None:
                            return self.send_error(400)
            if not post:
                with video:
                    self.send_response(200)
                    self.send_header("Content-Type", meta["mime"])
                    self.send_header("Content-Length", str(meta["bytes"]))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    shutil.copyfileobj(video, self.wfile)
                return
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= MAX_VIDEO:
                return self.send_error(413)
            mime = self.headers.get_content_type()
            if mime not in ("video/webm", "video/mp4", "image/jpeg"):
                return self.send_error(415)
            note = self.headers.get("X-Capture-Note", "")
            if note != "overview" and not (re.fullmatch(r"[0-9]{1,8}", note) and int(note) < len(notes)):
                return self.send_error(400)
            if guide and note != ("overview" if guide["noteIndex"] is None else str(guide["noteIndex"])):
                return self.send_error(400)
            filename = "photo.jpg" if mime == "image/jpeg" else "video." + mime.split("/")[1]
            # Stage on the same volume, outside the participant tree while receiving.
            with tempfile.TemporaryDirectory(dir=self.server.database.parent) as temp:
                staged = Path(temp) / take
                staged.mkdir()
                with (staged / filename).open("wb") as out:
                    remaining = size
                    while remaining:
                        block = self.rfile.read(min(remaining, 256 * 1024))
                        if not block:
                            return self.send_error(400)
                        out.write(block)
                        remaining -= len(block)
                with (staged / filename).open("rb") as source:
                    header = source.read(12)
                valid = {"image/jpeg": header.startswith(b"\xff\xd8\xff"), "video/mp4": header[4:8] == b"ftyp",
                         "video/webm": header.startswith(bytes.fromhex("1a45dfa3"))}
                if not valid[mime]:
                    return self.send_error(422)
                meta = dict(id=take, time=datetime.now(timezone.utc).isoformat(), file=filename, mime=mime,
                            bytes=size, note=None if note == "overview" else notes[int(note)])
                if guest:
                    meta["guest"] = guest
                if guide:
                    meta["guide"] = {k: guide[k] for k in ("key", "task", "step", "part", "name", "pages", "request", "mode")}
                (staged / "capture.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
                with library_lock, closing(open_library(path)) as db:
                    if not still_current(db, token, identifier, "ready"):
                        return self.send_error(409)
                    if guest:
                        store = DevicePairing(self.server.database.parent / "quest-wifi" / "pairing.sqlite3")
                        if not store.guest_active(guest, token):
                            return self.send_error(403)
                    folder.mkdir(parents=True, exist_ok=True)
                    if (folder / take).exists():
                        existing = prod.read_json(folder / take / "capture.json")
                        if guest and existing.get("guest") != guest:
                            return self.send_error(409)
                        return self.json_response(200, existing)
                    if guest:
                        captures = root.parent.glob("*/S3/captures/*/*")
                        if size + sum(f.stat().st_size for f in captures if f.name != "capture.json") > DEMO_STORAGE_LIMIT:
                            return self.send_error(507)
                    staged.rename(folder / take)
            return self.json_response(201, meta)
        except FileNotFoundError:
            return self.send_error(404)
        except ValueError:
            return self.send_error(400)
        except (sqlite3.Error, OSError):
            return self.send_error(503)

    def workflow(self, match, post):
        participant, identifier, asset = match.groups()
        photo = (asset or "").startswith("S4/alignment-photos/")
        path = library_path(self.server.database, participant)
        if post:
            if self.headers.get("Origin") != f"http://{self.headers['Host']}":
                return self.send_error(403)
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= (4*1024**2 if photo else 512 * 1024 if asset == "S4/alignment-record.json" else 2048):
                    raise ValueError
                body = self.rfile.read(size)
                action = None if photo else json.loads(body)
                if not photo and not isinstance(action, dict):
                    raise ValueError
            except (ValueError, UnicodeError):
                return self.send_error(400)
        try:
            with library_lock, closing(open_library(path)) as db, db:
                row = db.execute("""SELECT name, model, stage, candidates, error, generation FROM
                    manuals LEFT JOIN production USING(id), identity WHERE manuals.id=?""", (identifier,)).fetchone()
                if not row:
                    return self.send_error(404)
                name, model, stage, encoded, error, token = row
                guest = self.headers.get("X-Venue-Generation")
                if guest is not None and (participant != "DEMO" or post or stage != "ready" or guest != token):
                    return self.send_error(403)
                if guest is not None and not asset:
                    return self.json_response(200, dict(name=name, model=model, stage=stage))
                choices = json.loads(encoded or "[]")
                if asset:
                    if guest is not None and asset.startswith("S4/"):
                        return self.send_error(403)
                    available = stage == "ready" or (stage == "s2" and asset.startswith("S1/"))
                    if not available:
                        return self.send_error(404)
                    root = prod.stage_root(path, token, identifier, model)
                    if photo and post:
                        if self.headers.get("X-Library-Generation") != token:
                            return self.send_error(409)
                        try:
                            save_photo(root, Path(asset).name, body)
                        except ValueError:
                            return self.send_error(400)
                        return self.json_response(200, {"saved":True})
                    if asset == "S4/alignment-record.json":
                        if not post or self.headers.get("X-Library-Generation") != token:
                            return self.send_error(409 if post else 405)
                        try:
                            save_record(root, action)
                        except (ValueError, TypeError):
                            return self.send_error(400)
                        return self.json_response(200, {"saved": True})
                    if post:
                        return self.send_error(405)
                    if asset == "S4/alignment-latest.json":
                        return self.json_response(200, latest_record(root), token)
                    if asset == "S3/guide.json":
                        return self.json_response(200, capture_guide(root), token)
                    body = (root / asset).read_bytes()
                    mime = {".png": "image/png", ".jpg":"image/jpeg", ".json": "application/json", ".glb": "model/gltf-binary"}
                    return self.payload(200, mime[Path(asset).suffix], body)
                if post:
                    if self.headers.get("X-Library-Generation") != token:
                        return self.json_response(409, {"error": "参加者の一覧を開き直してください。"})
                    command = action.get("action")
                    if command == "start" and not stage:
                        stage = "models"
                        prod.import_workspace(path, token, identifier,
                                              db.execute("SELECT pdf FROM manuals WHERE id=?", (identifier,)).fetchone()[0])
                        db.execute("INSERT INTO production(id,stage) VALUES (?,?)", (identifier, stage))
                    elif command == "select" and stage == "select":
                        selected = action.get("model")
                        if not isinstance(selected, str) or not 0 < len(selected.strip()) <= 160:
                            return self.json_response(400, {"error": "型番を選択または入力してください。"})
                        model = selected.strip()
                        if choices and model not in {item["model"] for item in choices}:
                            return self.json_response(400, {"error": "候補から型番を選んでください。"})
                        stage = "s1"
                        prod.select_workspace(path, token, identifier, model,
                                              db.execute("SELECT pdf FROM manuals WHERE id=?", (identifier,)).fetchone()[0])
                        db.execute("UPDATE manuals SET model=? WHERE id=?", (model, identifier))
                        db.execute("UPDATE production SET stage=? WHERE id=?", (stage, identifier))
                    elif command == "retry" and error:
                        error = ""
                        db.execute("UPDATE production SET error='' WHERE id=?", (identifier,))
                    else:
                        return self.json_response(409, {"error": "状態が変わりました。再読み込みしてください。"})
                if stage in prod.STAGES and not error:
                    schedule(path, token, identifier)
                alignment = stage == "ready" and (prod.stage_root(path, token, identifier, model) / "S4/alignment.json").is_file()
            return self.json_response(200, dict(name=name, model=model, stage=stage, models=choices, error=error, alignment=alignment), token)
        except FileNotFoundError:
            return self.send_error(404)
        except (sqlite3.Error, OSError):
            return self.json_response(503, {"error": "生成状態を取得できませんでした。"})

    def local_management_request(self):
        return (self.client_address[0] == "127.0.0.1"
                and self.headers.get("Origin") == f"http://{self.headers['Host']}"
                and self.headers.get("X-Host-Management") == "1")

    def do_DELETE(self):
        match = USER_PATH.fullmatch(self.path)
        if not match or not user_id(match[1]):
            return self.send_error(404)
        if not self.local_management_request():
            return self.send_error(403)
        path = library_path(self.server.database, match[1])
        try:
            with library_lock:
                with closing(open_library(path)) as db:
                    generation = db.execute("SELECT generation FROM identity").fetchone()[0]
                if self.headers.get("X-Library-Generation") != generation:
                    return self.json_response(409, {"error": "ユーザー情報が変わりました。一覧を開き直してください。"})
                generated = path.parent / "devices" / generation
                if generated.is_dir():
                    shutil.rmtree(generated)
                    if not any(generated.parent.iterdir()):
                        generated.parent.rmdir()
                path.unlink()
                if match[1] != "LEGACY" and not any(path.parent.iterdir()):
                    path.parent.rmdir()
        except FileNotFoundError:
            pass  # A retry after successful deletion is already complete.
        except (sqlite3.Error, OSError):
            return self.json_response(503, {"error": "削除できませんでした。もう一度お試しください。"})
        self.send_response(204)
        self.end_headers()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=52393)
    parser.add_argument("--database", type=Path, default=ROOT / ".local/manuals.sqlite3")
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", args.port), Library) as server:
        server.database = args.database
        print(f"http://127.0.0.1:{server.server_port}/", flush=True)
        server.serve_forever()
