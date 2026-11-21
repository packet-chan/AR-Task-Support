import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from unittest.mock import patch

import production
import serve
from server.device_pairing import DevicePairing, digest
from tools.quest_wifi import QuestWiFi, COOKIE


class Upstream(BaseHTTPRequestHandler):
    def do_POST(self):
        self.server.received = (self.path, self.headers, self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(201)
        self.send_header("X-Library-Generation", "fixture")
        self.end_headers()
        self.wfile.write(b"saved")


class WifiTest(unittest.TestCase):
    def test_venue_viewer_only_receives_selected_guide(self):
        with tempfile.TemporaryDirectory() as temp, ThreadingHTTPServer(("127.0.0.1", 0), serve.Library) as host, \
                ThreadingHTTPServer(("127.0.0.1", 0), QuestWiFi) as entry:
            host.database = Path(temp) / "manuals.sqlite3"
            path = serve.library_path(host.database, "DEMO")
            manual = "pdf-" + "a" * 32
            with closing(serve.open_library(path, create=True)) as db, db:
                generation = db.execute("SELECT generation FROM identity").fetchone()[0]
                db.execute("INSERT INTO manuals VALUES (?,?,?,?,?)", (manual, "Demo", "M1", b"private", None))
                db.execute("INSERT INTO production(id,stage) VALUES (?,'ready')", (manual,))
                other = "pdf-" + "b" * 32
                db.execute("INSERT INTO manuals VALUES (?,?,?,?,?)", (other, "Second", "M2", b"private", None))
                db.execute("INSERT INTO production(id,stage) VALUES (?,'ready')", (other,))
            root = production.stage_root(path, generation, manual, "M1")
            (root / "S2").mkdir(parents=True)
            (root / "S2/bindings.json").write_text('{"parts":{},"steps":{},"notes":["private"]}')
            entry.authority = f"127.0.0.1:{entry.server_port}"
            entry.upstream_port = host.server_port
            entry.pairing = DevicePairing(Path(temp) / "quest-wifi" / "pairing.sqlite3")
            entry.pairing.register_entry(host.server_port, "https://" + entry.authority)
            threads = [Thread(target=s.serve_forever, daemon=True) for s in (host, entry)]
            for worker in threads:
                worker.start()

            def request(server, method, target, data=None, **headers):
                with closing(HTTPConnection("127.0.0.1", server.server_port, timeout=5)) as client:
                    client.request(method, target, data, headers)
                    response = client.getresponse()
                    return response.status, response.headers, response.read()

            admin = {"Origin": f"http://127.0.0.1:{host.server_port}", "X-Host-Management": "1"}
            enroll = {"Origin": "https://" + entry.authority, "Content-Type": "application/x-www-form-urlencoded"}
            start = "/api/venue/qr"
            try:
                self.assertEqual(request(host, "POST", start)[0], 403)
                url = json.loads(request(host, "POST", start, **admin)[2])["url"]
                prefix, code = url.split("#")
                self.assertEqual(prefix, "https://" + entry.authority + "/join")
                self.assertEqual(request(entry, "GET", "/api/venue-view")[0], 401)
                self.assertNotIn(b"<input", request(entry, "GET", "/pair")[2])
                self.assertEqual(request(entry, "POST", "/pair", "code=12345678", **enroll)[0], 405)
                self.assertEqual(request(host, "POST", "/api/pairing-code", **admin)[0], 404)
                self.assertEqual(request(host, "POST", "/api/device-qr")[0], 403)
                personal = json.loads(request(host, "POST", "/api/device-qr", **admin)[2])
                device_url, invitation = personal["url"].split("#")
                self.assertEqual(device_url, "https://" + entry.authority + "/join/device")
                self.assertEqual(request(entry, "POST", "/join", "invite=" + invitation, **enroll)[0], 401)
                self.assertEqual(request(entry, "POST", "/join/device", "invite=" + code, **enroll)[0], 401)
                self.assertEqual(request(entry, "POST", "/join/device", "invite=12345678", **enroll)[0], 401)
                guests = []
                for _ in range(2):
                    status, headers, _ = request(entry, "POST", "/join", "invite=" + code, **enroll)
                    self.assertEqual(status, 303)
                    self.assertEqual(headers["Location"], "/venue/DEMO/")
                    guests.append(headers["Set-Cookie"].split(";")[0])
                self.assertNotEqual(*guests)
                for side in ("left", "right"):
                    status, _, model = request(entry, "GET", f"/hands/{side}.glb", Cookie=guests[0])
                    self.assertEqual((status, model[:4]), (200, b"glTF"))
                for cookie in guests:
                    status, headers, body = request(entry, "GET", "/api/venue-view", Cookie=cookie)
                    self.assertEqual((status, headers["Cache-Control"]), (200, "no-store"))
                    self.assertEqual({r["name"] for r in json.loads(body)}, {"Second", "Demo"})
                    for item in (other, manual):
                        self.assertEqual(request(entry, "GET", f"/api/venue-view/{item}/workflow", Cookie=cookie)[0], 200)
                    bindings = request(entry, "GET", f"/api/venue-view/{manual}/workflow/S2/bindings.json", Cookie=cookie)
                    self.assertEqual(json.loads(bindings[2])["notes"], ["private"])
                    self.assertEqual(request(entry, "GET", f"/api/venue-view/{manual}/pdf", Cookie=cookie)[0], 200)
                    self.assertEqual(request(entry, "GET", "/", Cookie=cookie)[1]["Location"], "/venue/DEMO/")
                    self.assertEqual(request(entry, "GET", "/venue/DEMO/", Cookie=cookie)[0], 200)
                    for route in ("/api/users/P1/manuals", "/api/users/P2/manuals",
                                  "/api/venue-view/pdf-" + "f" * 32 + "/workflow",
                                  f"/api/users/P1/manuals/{manual}/pdf", f"/api/users/P1/manuals/{manual}/captures"):
                        self.assertEqual(request(entry, "GET", route, Cookie=cookie)[0], 403)
                    for route in (start, "/api/venue/end", "/api/venue-view", "/api/users/P1/manuals", "/api/capture-live-token"):
                        self.assertEqual(request(entry, "POST", route, Cookie=cookie, **enroll)[0], 403)
                records = f"/api/venue-view/{manual}/captures"
                take = records + "/" + "c" * 32
                upload = enroll | {"Content-Type": "video/webm", "X-Library-Generation": generation, "X-Capture-Note": "overview"}
                video = bytes.fromhex("1a45dfa3") + b"demo video"
                self.assertEqual(request(entry, "POST", take, video, Cookie=guests[0], **upload)[0], 201)
                self.assertEqual(request(entry, "GET", take, Cookie=guests[0])[2], video)
                self.assertEqual(request(entry, "GET", take, Cookie=guests[1])[0], 404)
                self.assertEqual(json.loads(request(entry, "GET", records, Cookie=guests[1])[2]), [])
                # Register a personal credential in a browser already authorized for DEMO.
                status, headers, _ = request(entry, "POST", "/join/device", "invite=" + invitation,
                                              Cookie=guests[0], **enroll)
                self.assertEqual(status, 303)
                self.assertEqual(len(headers.get_all("Set-Cookie")), 1)
                personal_cookie = headers["Set-Cookie"].split(";")[0]
                both = personal_cookie + "; " + guests[0]
                self.assertEqual(headers["Location"], "/approval")
                pending = json.loads(request(host, "POST", "/api/devices/pending", **admin)[2])
                self.assertEqual(len(pending), 1)
                personal_id = pending[0]["id"]
                approval = f"/api/devices/{personal_id}/approve"
                self.assertIn(f"#{personal_id}".encode(), request(entry, "GET", "/approval", Cookie=both)[2])
                self.assertEqual(request(entry, "GET", "/api/users/DEMO/manuals", Cookie=personal_cookie)[0], 401)
                self.assertEqual(request(entry, "GET", "/api/users/DEMO/manuals", Cookie=both)[0], 403)
                self.assertEqual(request(entry, "GET", "/api/venue-view", Cookie=both)[0], 200)
                self.assertEqual(request(entry, "POST", approval, Cookie=both, **enroll)[0], 403)
                self.assertEqual(request(host, "POST", approval)[0], 403)
                self.assertEqual(request(host, "POST", approval, **admin)[0], 200)
                self.assertEqual(request(entry, "GET", "/approval", Cookie=personal_cookie)[1]["Location"], "/")
                self.assertEqual(request(entry, "GET", "/", Cookie=both)[0], 200)
                self.assertEqual(request(entry, "GET", "/api/venue-view", Cookie=both)[0], 200)
                self.assertEqual(request(entry, "GET", take, Cookie=both)[2], video)
                self.assertEqual(request(entry, "POST", "/api/devices", Cookie=guests[0], **enroll)[0], 403)
                self.assertEqual(request(host, "POST", "/api/devices")[0], 403)
                devices = json.loads(request(host, "POST", "/api/devices", **admin)[2])
                self.assertEqual(sorted(d["role"] for d in devices), ["demo", "demo", "personal"])
                self.assertTrue(all(d["ip"] == "127.0.0.1" and d["last_seen"] for d in devices))
                identifier = min(d["id"] for d in devices)
                route = f"/api/devices/{identifier}"
                self.assertEqual(request(host, "POST", route + "/rename", '{"name":"Lab Quest"}',
                                         **(admin | {"Content-Type": "application/json"}))[0], 200)
                listed = json.loads(request(host, "POST", "/api/devices", **admin)[2])
                self.assertEqual(next(d["name"] for d in listed if d["id"] == identifier), "Lab Quest")
                self.assertEqual(request(host, "POST", route + "/revoke", **admin)[0], 200)
                self.assertNotIn(identifier, [d["id"] for d in json.loads(request(host, "POST", "/api/devices", **admin)[2])])
                self.assertEqual(request(entry, "GET", "/", Cookie=both)[0], 200)
                self.assertEqual(request(entry, "GET", "/api/venue-view", Cookie=both)[0], 401)
                self.assertEqual(request(entry, "GET", "/api/venue-view", Cookie=guests[0])[0], 401)
                self.assertEqual(request(entry, "GET", "/api/venue-view", Cookie=guests[1])[0], 200)
                self.assertEqual(request(entry, "POST", "/join", "invite=" + code, **enroll)[0], 401)
                request(host, "POST", "/api/venue/end", **admin)
                for cookie in guests:
                    self.assertEqual(request(entry, "GET", "/api/venue-view", Cookie=cookie)[0], 401)
            finally:
                for server in (entry, host):
                    server.shutdown()
                for worker in threads:
                    worker.join()

    def test_shared_admission_and_group_revocation(self):
        with tempfile.TemporaryDirectory() as temp:
            store = DevicePairing(Path(temp) / "paired.sqlite3")
            owner = store.register_device(store.invite_device()["invite"])
            self.assertTrue(store.review_personal(store.personal_status(owner)[0], True))
            scope = ([{"id": "pdf-" + "a" * 32, "name": "Demo"}], "generation")
            with patch("server.device_pairing.time.time", return_value=1000):
                issued = store.venue_code(*scope)
                self.assertEqual(issued["expires"], 1120)
                with ThreadPoolExecutor(8) as pool:
                    guests = list(pool.map(store.join_venue, [issued["code"]] * 32))
                self.assertEqual(len(set(guests)), 32)
                self.assertEqual(store.join_venue(issued["code"], guests[0]), guests[0])
            with patch("server.device_pairing.time.time", return_value=1120):
                self.assertIsNone(store.join_venue(issued["code"]))
                self.assertTrue(all(store.guest_scope(token) == scope for token in guests))
                replacement = store.venue_code(*scope)
                self.assertIsNone(store.join_venue("incorrect"))
                again = store.venue_code(*scope)
                self.assertIsNone(store.join_venue(replacement["code"]))
                self.assertEqual(store.guest_scope(store.join_venue(again["code"])), scope)
            with patch("server.device_pairing.time.time", return_value=1000 + 90 * 86400):
                self.assertEqual(DevicePairing(store.database).guest_scope(guests[0]), scope)
                self.assertIsNone(store.join_venue(again["code"]))
            with patch("server.device_pairing.time.time", return_value=1121):
                store.end_venue()
                self.assertIsNone(store.join_venue(again["code"]))
                store.venue_code(*scope)
                self.assertTrue(all(store.guest_scope(token) is None for token in guests))
                self.assertTrue(store.recognizes(owner))

    def test_legacy_personal_cookie_needs_explicit_approval_once(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "pairing.sqlite3"
            cookie = "a" * 43
            with closing(sqlite3.connect(path)) as db, db:
                db.execute("""CREATE TABLE browsers (id INTEGER PRIMARY KEY, digest BLOB UNIQUE, role TEXT,
                    name TEXT, agent TEXT, ip TEXT, created INTEGER, last_seen INTEGER, revoked INTEGER)""")
                db.execute("INSERT INTO browsers VALUES (1,?,'personal','Lab Quest','','',1,2,NULL)", (digest(cookie),))
            store = DevicePairing(path)
            self.assertFalse(store.recognizes(cookie))
            self.assertEqual(store.browsers(), [])
            self.assertEqual(store.browsers(pending=True)[0]["name"], "Lab Quest")
            self.assertTrue(store.review_personal(1, True))
            self.assertTrue(DevicePairing(path).recognizes(cookie))

    def test_pairing_lifetime_and_one_use(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "paired.sqlite3"
            store = DevicePairing(path)
            issued = store.invite_device()
            with patch("server.device_pairing.time.time", return_value=issued["expires"] + 1):
                self.assertIsNone(store.register_device(issued["invite"]))
            code = store.invite_device()["invite"]
            self.assertIsNone(store.register_device(issued["invite"]))
            with ThreadPoolExecutor(2) as pool:
                results = list(pool.map(store.register_device, [code, code]))
            tokens = [t for t in results if t]
            self.assertEqual(len(tokens), 1)
            reopened = DevicePairing(path)
            self.assertFalse(reopened.recognizes(tokens[0]))
            identifier = reopened.personal_status(tokens[0])[0]
            self.assertTrue(reopened.review_personal(identifier, False))
            self.assertFalse(reopened.review_personal(identifier, True))
            self.assertIsNone(reopened.personal_status(tokens[0]))

    def test_authenticated_upload_reaches_the_original_server_once(self):
        with tempfile.TemporaryDirectory() as temp, ThreadingHTTPServer(("127.0.0.1", 0), Upstream) as backend, \
                ThreadingHTTPServer(("127.0.0.1", 0), QuestWiFi) as entry:
            entry.authority = f"127.0.0.1:{entry.server_port}"
            entry.pairing = DevicePairing(Path(temp) / "paired.sqlite3")
            entry.upstream_port = backend.server_port
            threads = [Thread(target=s.serve_forever, daemon=True) for s in (backend, entry)]
            for worker in threads:
                worker.start()
            try:
                target = "/api/users/P1/manuals/pdf-" + "a" * 32 + "/captures/" + "b" * 32
                headers = {"Origin": "https://" + entry.authority, "X-Capture-Note": "0",
                           "Content-Type": "video/webm", "X-Library-Generation": "fixture"}

                def post(data, source_ip="127.0.0.1"):
                    with closing(HTTPConnection("127.0.0.1", entry.server_port, timeout=5,
                                                source_address=(source_ip, 0))) as client:
                        client.request("POST", target, data, headers)
                        response = client.getresponse()
                        return response.status, response.getheader("X-Library-Generation"), response.read()

                self.assertEqual(post(b"")[0], 401)
                with closing(HTTPConnection("127.0.0.1", entry.server_port, timeout=5)) as client:
                    invite = entry.pairing.invite_device()["invite"]
                    client.request("POST", "/join/device", "invite=" + invite, {"Content-Type": "application/x-www-form-urlencoded",
                                                                    "Origin": "https://" + entry.authority})
                    paired = client.getresponse()
                    self.assertEqual(paired.status, 303)
                    cookie = paired.getheader("Set-Cookie")
                    for flag in (COOKIE, "HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age="):
                        self.assertIn(flag, cookie)
                    headers["Cookie"] = cookie.split(";")[0]
                self.assertEqual(post(b"")[0], 401)
                self.assertTrue(entry.pairing.review_personal(entry.pairing.browsers(pending=True)[0]["id"], True))
                for method, route in [("DELETE", "/api/users/P1"), ("POST", "/api/device-qr")]:
                    with closing(HTTPConnection("127.0.0.1", entry.server_port, timeout=5)) as client:
                        client.request(method, route, headers=headers | {"X-Host-Management": "1"})
                        self.assertEqual(client.getresponse().status, 403)
                headers["Origin"] = "https://different.invalid"
                self.assertEqual(post(b"")[0], 403)
                self.assertFalse(hasattr(backend, "received"))
                headers["Origin"] = "https://" + entry.authority
                headers["X-Capture-Request"] = "n0"
                video = b"video" * 80000
                self.assertEqual(post(video, "127.0.0.2"), (201, "fixture", b"saved"))
                path, forwarded, body = backend.received
                self.assertEqual((path, body), (target, video))
                self.assertEqual(forwarded["Origin"], f"http://127.0.0.1:{backend.server_port}")
                self.assertEqual(forwarded["X-Capture-Note"], "0")
                self.assertEqual(forwarded["X-Capture-Request"], "n0")
                self.assertNotIn("Authorization", forwarded)
                self.assertNotIn("Cookie", forwarded)
            finally:
                for server in (entry, backend):
                    server.shutdown()
                for worker in threads:
                    worker.join()
