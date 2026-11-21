"""Host-managed personal credentials and short-lived QR invitations to DEMO."""
import hashlib
import hmac
import json
import secrets
import sqlite3
import time
from contextlib import closing


class DevicePairing:
    def __init__(self, database):
        self.database = database
        database.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(database)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("CREATE TABLE IF NOT EXISTS device_invitation (id INTEGER PRIMARY KEY, digest BLOB, expires INTEGER)")
            db.execute("CREATE TABLE IF NOT EXISTS devices (digest BLOB PRIMARY KEY)")
            db.execute("""CREATE TABLE IF NOT EXISTS demo_event (
                id INTEGER PRIMARY KEY, catalog TEXT, generation TEXT, invitation BLOB,
                admission INTEGER, ends INTEGER)""")
            db.execute("CREATE TABLE IF NOT EXISTS demo_guests (digest BLOB PRIMARY KEY)")
            db.execute("CREATE TABLE IF NOT EXISTS wifi_entry (port INTEGER PRIMARY KEY, origin TEXT NOT NULL)")
            if not db.execute("SELECT 1 FROM sqlite_master WHERE name='browsers'").fetchone():
                db.execute("""CREATE TABLE browsers (id INTEGER PRIMARY KEY, digest BLOB UNIQUE NOT NULL,
                    role TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT '',
                    ip TEXT NOT NULL DEFAULT '', created INTEGER, last_seen INTEGER, revoked INTEGER)""")
                db.execute("INSERT INTO browsers(digest,role) SELECT digest,'personal' FROM devices")
                db.execute("""INSERT INTO browsers(digest,role) SELECT digest,'demo' FROM demo_guests
                    WHERE EXISTS (SELECT 1 FROM demo_event WHERE ends>?)""", (time.time(),))
                db.execute("DELETE FROM demo_event WHERE ends<=?", (time.time(),))
            if "approved_at" not in {c[1] for c in db.execute("PRAGMA table_info(browsers)")}:
                # Earlier personal QR redemptions did not record host approval.
                db.execute("ALTER TABLE browsers ADD COLUMN approved_at INTEGER")

    def browsers(self, pending=False):
        with closing(sqlite3.connect(self.database)) as db:
            db.row_factory = sqlite3.Row
            condition = "role='personal' AND approved_at IS NULL" if pending else "(role='demo' OR approved_at IS NOT NULL)"
            return [dict(row) for row in db.execute("""SELECT id,role,name,agent,ip,created,last_seen
                FROM browsers WHERE revoked IS NULL AND """ + condition + " ORDER BY last_seen DESC, id DESC")]

    def review_personal(self, identifier, approve):
        with closing(sqlite3.connect(self.database)) as db, db:
            column = "approved_at" if approve else "revoked"
            return bool(db.execute(f"""UPDATE browsers SET {column}=? WHERE id=? AND role='personal'
                AND revoked IS NULL AND approved_at IS NULL""", (int(time.time()), identifier)).rowcount)

    def rename(self, identifier, name):
        with closing(sqlite3.connect(self.database)) as db, db:
            return bool(db.execute("UPDATE browsers SET name=? WHERE id=? AND revoked IS NULL", (name, identifier)).rowcount)

    def revoke(self, identifier):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT role,revoked FROM browsers WHERE id=?", (identifier,)).fetchone()
            if not row:
                return False
            if row[1] is None:
                db.execute("UPDATE browsers SET revoked=? WHERE id=?", (int(time.time()), identifier))
                if row[0] == "demo":
                    db.execute("UPDATE demo_event SET invitation=NULL, admission=0")
                else:
                    db.execute("DELETE FROM device_invitation")
            return True

    def record_access(self, token, ip, agent):
        now = int(time.time())
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("""UPDATE browsers SET last_seen=?,ip=?,agent=? WHERE digest=? AND revoked IS NULL
                AND (last_seen IS NULL OR last_seen<? OR ip!=? OR agent!=?)""",
                (now, ip, agent, digest(token), now - 14, ip, agent))

    def register_entry(self, port, origin):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("INSERT OR REPLACE INTO wifi_entry VALUES (?,?)", (port, origin))

    def entry(self, port):
        with closing(sqlite3.connect(self.database)) as db:
            row = db.execute("SELECT origin FROM wifi_entry WHERE port=?", (port,)).fetchone()
            return row[0] if row else None

    def venue_code(self, catalog, generation):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            now = int(time.time())
            snapshot = json.dumps(catalog, ensure_ascii=False)
            expires = now + 120
            code = secrets.token_urlsafe(32)
            db.execute("INSERT OR REPLACE INTO demo_event VALUES (1,?,?,?,?,NULL)",
                       (snapshot, generation, digest(code), expires))
            return {"code": code, "expires": expires}

    def join_venue(self, code, previous=""):
        if len(code) != 43:
            return None
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT invitation FROM demo_event WHERE admission>?", (time.time(),)).fetchone()
            if not row:
                return None
            if not hmac.compare_digest(row[0], digest(code)):
                return None
            return register_browser(db, "demo", previous)

    def guest_scope(self, token):
        if len(token) != 43:
            return None
        with closing(sqlite3.connect(self.database)) as db:
            row = db.execute("""SELECT catalog, generation FROM demo_event, browsers
                WHERE digest=? AND role='demo' AND revoked IS NULL""", (digest(token),)).fetchone()
            if row:
                return json.loads(row[0]), row[1]

    def venue_status(self):
        with closing(sqlite3.connect(self.database)) as db:
            row = db.execute("SELECT admission FROM demo_event").fetchone()
            return {"active": bool(row), "admission": row[0] if row else 0}

    def guest_active(self, fingerprint, generation):
        with closing(sqlite3.connect(self.database)) as db:
            return db.execute("""SELECT 1 FROM demo_event, browsers
                WHERE generation=? AND digest=? AND role='demo' AND revoked IS NULL""",
                (generation, bytes.fromhex(fingerprint))).fetchone() is not None

    def end_venue(self):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("DELETE FROM demo_event")
            db.execute("UPDATE browsers SET revoked=? WHERE role='demo' AND revoked IS NULL", (int(time.time()),))

    def invite_device(self):
        invitation = secrets.token_urlsafe(32)
        expires = int(time.time()) + 120
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("INSERT OR REPLACE INTO device_invitation VALUES (1, ?, ?)", (digest(invitation), expires))
        return {"invite": invitation, "expires": expires}

    def register_device(self, invitation, previous=""):
        if len(invitation) != 43:
            return None
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            consumed = db.execute("DELETE FROM device_invitation WHERE digest=? AND expires>?",
                                  (digest(invitation), time.time()))
            if not consumed.rowcount:
                return None
            return register_browser(db, "personal", previous)

    def personal_status(self, token):
        if len(token) != 43:
            return None
        with closing(sqlite3.connect(self.database)) as db:
            return db.execute("""SELECT id,approved_at IS NOT NULL FROM browsers
                WHERE digest=? AND role='personal' AND revoked IS NULL""", (digest(token),)).fetchone()

    def recognizes(self, token):
        status = self.personal_status(token)
        return bool(status and status[1])


def register_browser(db, role, previous):
    if len(previous) == 43 and db.execute(
        "SELECT 1 FROM browsers WHERE digest=? AND role=? AND revoked IS NULL", (digest(previous), role)
    ).fetchone():
        return previous
    token = secrets.token_urlsafe(32)
    db.execute("INSERT INTO browsers(digest,role,created) VALUES (?,?,?)", (digest(token), role, int(time.time())))
    return token


def digest(value):
    return hashlib.sha256(value.encode()).digest()
