"""Serve the equipment library and keep imported manuals outside the web root."""
import argparse
import json
import re
import shutil
import sqlite3
import subprocess
from contextlib import closing
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PureWindowsPath
from threading import Lock
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import UUID, uuid4

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
MAX_PDF = 128 * 1024 * 1024
USER_ID = r"[A-Z0-9][A-Z0-9_-]{0,31}"
LIBRARY_PATH = re.compile(rf"/users/({USER_ID})/")
MANUAL_PATH = re.compile(rf"/api/users/({USER_ID})/manuals(?:/(pdf-[0-9a-f]{{32}})/(pdf|cover))?")
USER_PATH = re.compile(rf"/api/users/({USER_ID})")
library_lock = Lock()


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
    except sqlite3.Error:
        db.close()
        raise
    return db


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
        self.send_header("X-Content-Type-Options", "nosniff")
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
        match = MANUAL_PATH.fullmatch(path)
        if not match or not user_id(match[1]):
            return self.send_error(404)
        try:
            with library_lock, closing(open_library(library_path(self.server.database, match[1]))) as db:
                if not match[2]:
                    rows = db.execute("SELECT id,name,model,cover IS NOT NULL FROM manuals ORDER BY rowid DESC")
                    listing = [dict(id=i, name=n, model=m, cover=bool(c)) for i,n,m,c in rows]
                    generation = db.execute("SELECT generation FROM identity").fetchone()[0]
                else:
                    column = match[3]
                    row = db.execute(f"SELECT {column} FROM manuals WHERE id=?", (match[2],)).fetchone()
        except FileNotFoundError:
            return self.send_error(404)
        if not match[2]:
            return self.json_response(200, listing, generation)
        if row and row[0]:
            return self.payload(200, "application/pdf" if column == "pdf" else "image/png", row[0])
        self.send_error(404)

    def do_POST(self):
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
        except FileNotFoundError:
            return self.json_response(404, {"error": "ユーザーは削除されました。"})
        except sqlite3.Error:
            return self.json_response(503, {"error": "保存できませんでした。もう一度追加してください。"})
        self.json_response(201, {"id": identifier})

    def do_DELETE(self):
        match = USER_PATH.fullmatch(self.path)
        if not match or not user_id(match[1]):
            return self.send_error(404)
        if self.headers.get("Origin") != f"http://{self.headers['Host']}":
            return self.send_error(403)
        path = library_path(self.server.database, match[1])
        try:
            with library_lock:
                with closing(open_library(path)) as db:
                    generation = db.execute("SELECT generation FROM identity").fetchone()[0]
                if self.headers.get("X-Library-Generation") != generation:
                    return self.json_response(409, {"error": "ユーザー情報が変わりました。一覧を開き直してください。"})
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
