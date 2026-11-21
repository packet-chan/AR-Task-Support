import json
import tempfile
import unittest
from contextlib import closing
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from uuid import uuid4

import production
import serve


class CaptureTest(unittest.TestCase):
    def test_capture_stays_with_its_note_and_generation_on_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            database = Path(temp) / "manuals.sqlite3"
            path = serve.library_path(database, "P1")
            manual = "pdf-" + uuid4().hex
            with closing(serve.open_library(path, create=True)) as db, db:
                token = db.execute("SELECT generation FROM identity").fetchone()[0]
                db.execute("INSERT INTO manuals VALUES (?,?,?,?,?)", (manual, "Coffee", "HD8943", b"", None))
                db.execute("INSERT INTO production(id,stage) VALUES (?, 'ready')", (manual,))
            root = production.stage_root(path, token, manual, "HD8943")
            (root / "S2").mkdir(parents=True)
            note = {"part": "spout", "text": "Show the outlet moving."}
            (root / "S2/bindings.json").write_text(json.dumps({"notes": [note]}))
            with ThreadingHTTPServer(("127.0.0.1", 0), serve.Library) as server:
                server.database = database
                thread = Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    prefix = f"/api/users/P1/manuals/{manual}/captures"
                    url = prefix + "/" + uuid4().hex
                    body = bytes.fromhex("1a45dfa3") + b"fixture"
                    headers = {"Origin": f"http://127.0.0.1:{server.server_port}", "Content-Type": "video/webm",
                               "X-Library-Generation": token, "X-Capture-Note": "0"}

                    def request(method, target, data=None, **overrides):
                        with closing(HTTPConnection("127.0.0.1", server.server_port, timeout=5)) as client:
                            client.request(method, target, data, headers | overrides)
                            response = client.getresponse()
                            return response.status, response.read()

                    self.assertEqual(request("POST", url, body, Origin="http://example.invalid")[0], 403)
                    self.assertEqual(request("POST", url, body, **{"X-Library-Generation": "stale"})[0], 409)
                    self.assertEqual(request("POST", url, body, **{"X-Capture-Note": "99"})[0], 400)
                    self.assertEqual(request("POST", url, b"invalid")[0], 422)
                    self.assertEqual(request("GET", prefix), (200, b"[]"))
                    status, first = request("POST", url, body)
                    self.assertEqual(status, 201)
                    self.assertEqual(request("POST", url, body), (200, first))
                    entries = json.loads(request("GET", prefix)[1])
                    self.assertEqual(entries, [json.loads(first)])
                    self.assertEqual(entries[0]["note"], note)
                    self.assertEqual(request("GET", url), (200, body))
                    # A saved guide is resolved from the host's S1/S2 pair.
                    (root / "S1").mkdir()
                    step = {"id": "open", "text": {"ja": "ふたを開く"}, "pages": [3], "figures": []}
                    (root / "S1/task_step.json").write_text(json.dumps({"tasks": [
                        {"id": "t", "title": {"ja": "準備"}, "precautions": [], "steps": [step]}]}))
                    (root / "S2/bindings.json").write_text(json.dumps({
                        "notes": [note], "parts": {"spout": {"name": "注ぎ口", "node": "Spout", "clips": ["move"]}},
                        "steps": {"open": {"target_part": "spout", "clips": ["move"]}}}))
                    guide = json.loads(request("GET", prefix.replace("/captures", "/workflow/S3/guide.json"))[1])[0]
                    self.assertEqual((guide["mode"], guide["step"], guide["clips"]), ("video", "open", ["move"]))
                    photo = prefix + "/" + uuid4().hex
                    info = {"X-Capture-Request": guide["key"], "Content-Type": "image/jpeg"}
                    jpeg = bytes.fromhex("ffd8ffe0") + b"fixture"
                    self.assertEqual(request("POST", photo, jpeg, **(info | {"X-Capture-Request": "n99"}))[0], 400)
                    self.assertEqual(request("POST", photo, body, **info)[0], 422)
                    status, saved = request("POST", photo, jpeg, **info)
                    self.assertEqual(status, 201)
                    self.assertEqual(request("POST", photo, jpeg, **info), (200, saved))
                    self.assertEqual(json.loads(saved)["guide"]["step"], "open")
                    self.assertEqual(request("GET", photo), (200, jpeg))
                finally:
                    server.shutdown()
                    thread.join()
