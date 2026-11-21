"""Store participant measurements separately from the frozen S4 inputs and model."""
import json
import hashlib
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from uuid import UUID


def save_photo(root, name, data):
    if not data.startswith(b"\xff\xd8\xff") or not data.endswith(b"\xff\xd9") or hashlib.sha256(data).hexdigest()+".jpg" != name:
        raise ValueError("Invalid shutter image")
    folder = root / "S4/alignment-photos"
    folder.mkdir(exist_ok=True)
    if not (folder / name).exists():
        with NamedTemporaryFile(dir=folder, delete=False) as temp:
            temp.write(data)
        Path(temp.name).replace(folder / name)


def save_record(root, data):
    if not isinstance(data, dict) or data.get("protocol") != "s4-alignment-1":
        raise ValueError("Invalid alignment protocol")
    profile = data.get("profile")
    if not isinstance(profile, str) or not re.fullmatch("[a-f0-9]{64}", profile):
        raise ValueError("Invalid alignment plan")
    session = data.get("session")
    if not isinstance(session, str) or str(UUID(session)) != session:
        raise ValueError("Invalid session")
    plan = json.loads((root / "S4/alignment-plans" / (profile + ".json")).read_text(encoding="utf-8"))
    for key, allowed in (("groups", {g["id"] for g in plan["groups"]}), ("parts", plan["targets"])):
        entries = data.get(key)
        if not isinstance(entries, dict) or any(k not in allowed or not isinstance(v, dict)
                                                or not isinstance(v.get("verified"), bool) for k,v in entries.items()):
            raise ValueError("Invalid measurement")
    if not isinstance(data.get("events"), list) or not all(isinstance(e,dict) for e in data["events"]):
        raise ValueError("Invalid events")
    for part, item in data["parts"].items():
        provisional = item.get("provisional") is True
        if not item["verified"] and not provisional:
            continue
        group = plan["targets"][part]["group"]
        group_result = data["groups"].get(group, {})
        if (item["verified"] and not group_result.get("verified")) or (provisional and not group_result.get("matrix")):
            raise ValueError("Part without checked group")
        single = item.get("method") == "single-point" and data.get("interactionVersion") == 4
        for key in ("first", "predicted", "localPoint", "offset") + (() if single else ("repeat",)):
            p = item.get(key)
            if not isinstance(p, list) or len(p) != 3 or not all(type(x) in (float, int) and math.isfinite(x) for x in p):
                raise ValueError("Invalid pointing measurement")
        if single:
            matrices=[item.get("basis")]
            if "viewerMatrix" in item:
                matrices.append(item["viewerMatrix"])
            if any(not isinstance(m,list) or len(m)!=16 or not all(type(x) in (float,int) and math.isfinite(x) for x in m)
                   for m in matrices) or not isinstance(item.get("step"),str):
                raise ValueError("Invalid pointing reference")
        if not single and not math.isclose(math.dist(item["first"], item["repeat"]), item.get("error", -1), abs_tol=1e-8):
            raise ValueError("Inconsistent repeat distance")
    for e in data["events"]:
        if e.get("type")=="part-confirmed" and (e.get("id") not in plan["targets"] or not isinstance(e.get("result"),dict)
                                                or not isinstance(e.get("step"),str)):
            raise ValueError("Invalid confirmed part")
    for item in [*data["parts"].values(), *(e["result"] for e in data["events"] if e.get("type")=="part-confirmed")]:
        photo = item.get("photo")
        if photo is not None and (not isinstance(photo,str) or not re.fullmatch(r"[0-9a-f]{64}\.jpg",photo)
                                  or not (root / "S4/alignment-photos" / photo).is_file()):
            raise ValueError("Missing shutter image")
    folder = root / "S4/alignment-records"
    folder.mkdir(exist_ok=True)
    file = folder / (session + ".json")
    if file.is_file():
        if json.loads(file.read_text(encoding="utf-8"))["record"] != data:
            raise ValueError("Session already saved")
        return
    body = json.dumps(dict(received=datetime.now(timezone.utc).isoformat(), record=data),
                      ensure_ascii=False, allow_nan=False)
    with NamedTemporaryFile(dir=folder, delete=False, mode="w", encoding="utf-8") as temp:
        temp.write(body)
    Path(temp.name).replace(file)


def latest_record(root):
    files = (root / "S4/alignment-records").glob("*.json")
    latest = max(files, key=lambda file: file.stat().st_mtime_ns, default=None)
    if not latest:
        return None
    saved = json.loads(latest.read_text(encoding="utf-8"))
    record = saved["record"]
    plan = json.loads((root / "S4/alignment-plans" / (record["profile"] + ".json")).read_text(encoding="utf-8"))
    parts = []
    for key, item in record["parts"].items():
        row = dict(label=plan["targets"][key]["label"], verified=item["verified"], provisional=item.get("provisional", False))
        if row["verified"] or row["provisional"]:
            row.update(correction=math.dist(item["first"], item["predicted"]), repeat=item.get("error"))
        parts.append(row)
    photos = [dict(file=e["result"]["photo"],label=plan["targets"][e["id"]]["label"],step=e["step"])
              for e in record["events"] if e.get("type")=="part-confirmed" and e.get("result",{}).get("photo")]
    return dict(received=saved["received"], revision=plan["revision"], session=record["session"],parts=parts,photos=photos,
                groups=[g["label"] for g in plan["groups"] if record["groups"].get(g["id"], {}).get("verified")],
                provisionalGroups=[g["label"] for g in plan["groups"] if record["groups"].get(g["id"], {}).get("matrix")
                                   and not record["groups"][g["id"]]["verified"]])
