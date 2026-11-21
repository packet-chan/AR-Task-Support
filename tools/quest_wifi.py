"""Serve the existing loopback app to a paired browser over local HTTPS."""
import argparse
import http.client
import ipaddress
import json
import re
import secrets
import shutil
import ssl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
from urllib.parse import parse_qs

from server.device_pairing import DevicePairing, digest

COOKIE = "__Host-quest-device"
GUEST_COOKIE = "__Host-quest-guest"
GUEST_PAGE = "/venue/DEMO/"
GUEST_ASSETS = {
    "/support.css", "/support.js", "/language.js", "/viewer.js", "/quest-controls.svg", "/quest-lock.png",
    "/library.js", "/library.css", "/venue-session.js", "/capture-entry.js", "/capture-panel.js",
    "/capture-voice.js", "/model-motion.js", "/hands/left.glb", "/hands/right.glb",
    "/node_modules/three/build/three.module.js", "/node_modules/three/build/three.core.js",
    "/node_modules/three/examples/jsm/loaders/GLTFLoader.js", "/node_modules/three/examples/jsm/controls/OrbitControls.js",
    "/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js",
}
GUEST_VIEW = re.compile(r"/api/venue-view/(pdf-[0-9a-f]{32})/workflow(/S1/task_step\.json|/S1/figure/p[0-9]{3,}-[0-9]{2,}\.png|/S2/bindings\.json|/S2/model\.glb|/S3/guide\.json)?")
PAIR_PAGE = (Path(__file__).with_name("pair.html")).read_text(encoding="utf-8")
JOIN_PAGE = (Path(__file__).with_name("join.html")).read_text(encoding="utf-8")
GUEST_FILE = re.compile(r"/api/venue-view/(pdf-[0-9a-f]{32})/(pdf|cover|captures(?:/[0-9a-f]{32})?)")


class QuestWiFi(BaseHTTPRequestHandler):
    timeout = 45

    def remember(self, token, guest=False):
        name = GUEST_COOKIE if guest else COOKIE
        self.send_header("Set-Cookie", f"{name}={token}; Path=/; Max-Age=34560000; Secure; HttpOnly; SameSite=Strict")

    def pairing_page(self, failed=False, pending=None, has_demo=False):
        heading = "QRで参加"
        message = "配信PCに表示されたQRをこの端末で読み取ってください。"
        detail = '<p role="alert">このQRは使えません。配信PCで新しいQRを表示してください。</p>' if failed else ""
        if pending is not None:
            heading = "個人端末の承認待ち"
            message = f"申請 #{pending}"
            detail = "<p>配信PCでこの番号の申請を承認すると、自動で個人画面が開きます。</p>"
            if has_demo:
                detail += f'<a href="{GUEST_PAGE}">DEMOを開く</a>'
        body = PAIR_PAGE.replace("{{heading}}", heading).replace("{{message}}", message).replace("{{detail}}", detail).encode()
        self.send_response(401 if failed else 200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if pending is not None:
            self.send_header("Refresh", "4;url=/approval")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def redirect(self, location, token=None, guest=False):
        self.send_response(303)
        self.send_header("Location", location)
        self.send_header("Cache-Control", "no-store")
        if token:
            self.remember(token, guest)
        self.end_headers()

    def forward(self):
        host = self.headers.get("Host", "")
        if host != self.server.authority or not self.path.startswith("/") or self.path.startswith("//"):
            return self.send_error(403)
        path = self.path.partition("?")[0]
        if self.command == "DELETE" or path in ("/api/device-qr", "/api/devices") or path.startswith(("/api/venue/", "/api/devices/")):
            return self.send_error(403)
        method = self.command
        headers = {}
        origin = self.headers.get("Origin")
        if method in ("POST", "DELETE") or origin:
            if origin != f"https://{host}":
                return self.send_error(403)
            headers["Origin"] = f"http://127.0.0.1:{self.server.upstream_port}"
        if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) > 1:
            return self.send_error(400)
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.send_error(400)
        if length < 0 or length > 128 * 1024 * 1024:
            return self.send_error(413)
        for key in ("Content-Type", "X-Import-ID", "X-Manual-Name", "X-Model", "X-Production",
                    "X-Library-Generation", "X-Capture-Note", "X-Capture-Request", "Range", "If-Modified-Since"):
            if key in self.headers:
                headers[key] = self.headers[key]
        if method == "POST":
            headers["Content-Length"] = str(length)
        elif length:
            return self.send_error(400)
        join = self.path in ("/join", "/join/device")
        if self.path == "/pair" and method == "POST":
            return self.send_error(405)
        if join and method in ("GET", "HEAD"):
            nonce = secrets.token_urlsafe(20)
            body = JOIN_PAGE.replace("NONCE", nonce).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "same-origin")
            self.send_header("Content-Security-Policy", f"default-src 'none'; script-src 'nonce-{nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers()
            if method == "GET":
                self.wfile.write(body)
            return
        cookies = SimpleCookie()
        try:
            cookies.load(self.headers.get("Cookie", ""))
        except CookieError:
            cookies.clear()
        token = cookies[COOKIE].value if COOKIE in cookies else ""
        guest = cookies[GUEST_COOKIE].value if GUEST_COOKIE in cookies else ""
        if join and method == "POST":
            if self.headers.get_content_type() != "application/x-www-form-urlencoded" or not 0 < length <= 128:
                return self.send_error(400)
            form = parse_qs(self.rfile.read(length).decode("ascii", errors="replace"))
            invites = form.get("invite", [])
            if len(invites) != 1 or not re.fullmatch(r"[A-Za-z0-9_-]{43}", invites[0]):
                return self.pairing_page(True)
            demo = self.path == "/join"
            store = self.server.pairing
            credential = store.join_venue(invites[0], guest) if demo else store.register_device(invites[0], token)
            if not credential:
                return self.pairing_page(True)
            self.record_access(credential)
            return self.redirect(GUEST_PAGE if demo else "/approval", credential, guest=demo)
        personal = self.server.pairing.personal_status(token)
        approved = bool(personal and personal[1])
        if self.path == "/approval" and method in ("GET", "HEAD"):
            if not personal:
                return self.redirect("/pair")
            if approved:
                return self.redirect("/")
            self.record_access(token)
            return self.pairing_page(pending=personal[0], has_demo=bool(self.server.pairing.guest_scope(guest)))
        if personal and not approved and self.path in ("/", "/pair") and method in ("GET", "HEAD"):
            return self.redirect("/approval")
        scope = None
        target = self.path
        demo_route = path == GUEST_PAGE or path.startswith("/api/venue-view") or (path == "/support.html" and "demo=1" in self.path)
        if demo_route or not approved:
            scope = self.server.pairing.guest_scope(guest)
            if not scope:
                if method in ("GET", "HEAD") and self.path == "/pair":
                    return self.pairing_page()
                if method in ("GET", "HEAD") and not self.path.startswith("/api/"):
                    return self.redirect("/pair")
                return self.send_error(401)
            self.record_access(guest)
            file = GUEST_FILE.fullmatch(path)
            upload = method == "POST" and file and file[2].startswith("captures/")
            if method not in ("GET", "HEAD") and not upload:
                return self.send_error(403)
            if self.path in ("/", "/pair"):
                return self.redirect(GUEST_PAGE)
            if self.path == "/api/venue-view/session":
                self.send_response(204)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            catalog, generation = scope
            if self.path == "/api/venue-view":
                body = json.dumps(catalog, ensure_ascii=False).encode()
                self.send_response(200)
                if approved:
                    self.send_header("X-Personal-Access", "1")
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("X-Library-Generation", generation)
                self.end_headers()
                if method == "GET":
                    self.wfile.write(body)
                return
            view = GUEST_VIEW.fullmatch(path)
            if self.path == GUEST_PAGE:
                target = "/users/DEMO/"
            elif view and method == "GET" and any(item["id"] == view[1] for item in catalog):
                headers["X-Venue-Generation"] = generation
                target = f"/api/users/DEMO/manuals/{view[1]}/workflow" + (view[2] or "")
            elif file and (method == "GET" or upload) and any(item["id"] == file[1] for item in catalog):
                if upload and not 0 < length <= 64 * 1024 * 1024:
                    return self.send_error(413)
                headers["X-Venue-Generation"] = generation
                headers["X-Venue-Guest"] = digest(guest).hex()
                target = f"/api/users/DEMO/manuals/{file[1]}/{file[2]}"
            elif not re.fullmatch(r"/support\.html\?demo=1&id=pdf-[0-9a-f]{32}", self.path) and path not in GUEST_ASSETS:
                return self.send_error(403)
        else:
            self.record_access(token)
        if self.path == "/pair":
            return self.redirect("/")
        upstream = http.client.HTTPConnection("127.0.0.1", self.server.upstream_port, timeout=60)
        started = False
        try:
            upstream.putrequest(method, target)
            for key, value in headers.items():
                upstream.putheader(key, value)
            upstream.endheaders()
            while length:
                chunk = self.rfile.read(min(256 * 1024, length))
                if not chunk:
                    return self.send_error(400)
                upstream.send(chunk)
                length -= len(chunk)
            with upstream.getresponse() as response:
                self.send_response(response.status)
                if scope:
                    self.send_header("Cache-Control", "no-store")
                    if response.getheader("Content-Type", "").startswith("text/html"):
                        self.remember(guest, guest=True)
                elif response.getheader("Content-Type", "").startswith("text/html"):
                    self.remember(token)
                for key in ("Content-Type", "Content-Length", "Location", "Last-Modified", "Cache-Control",
                            "X-Library-Generation", "Content-Range", "Accept-Ranges", "X-Content-Type-Options"):
                    if key in response.headers and not (scope and key == "Cache-Control"):
                        self.send_header(key, response.headers[key])
                self.end_headers()
                started = True
                if method != "HEAD":
                    shutil.copyfileobj(response, self.wfile)
        except (OSError, http.client.HTTPException):
            if not started:
                self.send_error(502)
        finally:
            upstream.close()

    def record_access(self, token):
        agent = self.headers.get("User-Agent", "").lower()
        label = next((name for key, name in (
            ("quest", "Meta Quest"), ("oculus", "Meta Quest"), ("pico", "PICO"),
            ("iphone", "iPhone"), ("ipad", "iPad"), ("android", "Android"),
            ("windows", "Windows"), ("macintosh", "Mac"), ("linux", "Linux")
        ) if key in agent), "")
        self.server.pairing.record_access(token, self.client_address[0], label)

    do_GET = do_HEAD = do_POST = do_DELETE = forward


class LabServer(ThreadingHTTPServer):
    def get_request(self):
        sock, peer = super().get_request()
        return self.tls.wrap_socket(sock, server_side=True, do_handshake_on_connect=False), peer


def serve_wifi(address, port, upstream_port, cert, key, pairing_db):
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.minimum_version = ssl.TLSVersion.TLSv1_2
    tls.load_cert_chain(cert, key)
    with LabServer((str(address), port), QuestWiFi) as server:
        server.authority = f"{address}:{server.server_port}"
        server.pairing = DevicePairing(pairing_db)
        if not address.is_loopback or not server.pairing.entry(upstream_port):
            server.pairing.register_entry(upstream_port, f"https://{server.authority}")
        server.upstream_port = upstream_port
        server.tls = tls
        server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--address", required=True, type=ipaddress.IPv4Address)
    parser.add_argument("--port", type=int, default=52394)
    parser.add_argument("--upstream-port", type=int, default=52393)
    parser.add_argument("--cert", type=Path, required=True)
    parser.add_argument("--key", type=Path, required=True)
    parser.add_argument("--pairing-db", type=Path, required=True)
    args = parser.parse_args()
    serve_wifi(**vars(args))
