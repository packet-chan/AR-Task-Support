"""Freeze a capture round, then apply a reviewed, evidence-linked S2 revision."""
import argparse
import base64
import copy
import hashlib
import json
import platform
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import av

import production
from tools.s4_model import Model, need, vector

ROOT = Path(__file__).resolve().parents[1]
RULES = ["generation/s4.md", "docs/s4.md", "tools/s4.py", "tools/s4_model.py", "tools/s4-replay.mjs",
         "tools/s4-compare.html", "web/model-motion.js", "web/package-lock.json", "production.py"]
MEDIA = {"image/jpeg": "photo.jpg", "video/webm": "video.webm", "video/mp4": "video.mp4"}
read = production.read_json


def digest(path):
    with production.regular(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def key(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def write(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")


def publish(stage, destination):
    try:
        stage.rename(destination)
    except OSError:
        if not destination.is_dir():
            raise
        def inventory(folder):
            return {p.relative_to(folder): digest(p) for p in folder.rglob("*") if p.is_file()}
        need(inventory(stage) == inventory(destination), "Existing run differs; refusing overwrite")


def inspect_media(path):
    with av.open(str(path)) as media:
        stream = media.streams.video[0]
        frames = 0
        end = 0
        for frame in media.decode(stream):
            frames += 1
            if frame.time is not None:
                end = max(end, float(frame.time))
        need(frames > 0, "Empty capture")
        return dict(width=stream.width, height=stream.height, frames=frames, lastFrameSeconds=end)


def verify(root, manifest):
    for rel, expected in manifest["files"].items():
        need(digest(root / rel) == expected, "Input changed: " + rel)
    for rel, expected in manifest["tools"].items():
        need(digest(ROOT / rel) == expected, "Protocol/tool changed: " + rel)


def prepare(root, selected):
    root = root.resolve()
    s1 = read(root / "S1/task_step.json")
    steps, figures = production.check_s1(root / "S1", s1["pdf_id"], s1["model"])
    production.check_s2(root / "S2", steps, figures)
    files = ["manual.pdf", "S1/task_step.json", "S2/bindings.json", "S2/model.glb",
             *["S1/figure/" + f for f in sorted(figures)]]
    captures = {}
    selected = selected or [p.parent.name for p in (root / "S3/captures").glob("*/capture.json")]
    need(selected and len(set(selected)) == len(selected), "Choose distinct captures")
    for cid in sorted(selected):
        need(re.fullmatch("[a-f0-9]{32}", cid), "Invalid capture ID")
        folder = root / "S3/captures" / cid
        meta = read(folder / "capture.json")
        need(meta["id"] == cid and MEDIA.get(meta["mime"]) == meta["file"], "Invalid capture metadata")
        path = folder / meta["file"]
        need(path.stat().st_size == meta["bytes"], "Capture size mismatch")
        captures[cid] = dict(mime=meta["mime"], note=meta.get("note"), guide=meta.get("guide"), **inspect_media(path))
        files.extend(p.relative_to(root).as_posix() for p in (path, folder / "capture.json"))
    manifest = dict(protocol="S4-v1", model=s1["model"], pdf=s1["pdf_id"], captures=captures,
                    files={p: digest(root / p) for p in files}, tools={p: digest(ROOT / p) for p in RULES},
                    runtime=dict(python=platform.python_version(), av=av.__version__,
                                 node=subprocess.check_output(["node", "--version"], text=True).strip(),
                                 three=read(ROOT / "web/node_modules/three/package.json")["version"]))
    round_id = key(manifest)
    parent = root / "S4"
    parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=parent) as temp:
        stage = Path(temp) / "round"
        stage.mkdir()
        write(stage / "manifest.json", manifest)
        shutil.copyfile(ROOT / RULES[0], stage / "prompt.md")
        shutil.copyfile(ROOT / RULES[1], stage / "protocol.md")
        findings = []
        for cid, cap in captures.items():
            location = {"seconds": []} if cap["mime"].startswith("video/") else {"region": []}
            findings.append(dict(capture=cid, **location, property="", baseline="", observation="", decision=""))
        write(stage / "review-template.json", dict(round=round_id, reviewer="", findings=findings))
        verify(root, manifest)
        destination = parent / round_id[:16]
        # Published revisions live underneath the round; compare only its immutable inputs.
        if destination.exists():
            for f in stage.iterdir():
                need(digest(f) == digest(destination / f.name), "Frozen round was changed")
        else:
            publish(stage, destination)
    return destination


def data_uri(data, mime):
    return "data:" + mime + ";base64," + base64.b64encode(data).decode()


def comparison(root, stage, first):
    vendor = ROOT / "web/node_modules/three"
    sources = {"core": vendor / "build/three.core.js", "three": vendor / "build/three.module.js",
               "loader": vendor / "examples/jsm/loaders/GLTFLoader.js",
               "utils": vendor / "examples/jsm/utils/BufferGeometryUtils.js", "motion": ROOT / "web/model-motion.js"}
    imports = {}
    for name, path in sources.items():
        js = path.read_bytes().replace(b"'./three.core.js'", b"'core'").replace(b"'../utils/BufferGeometryUtils.js'", b"'utils'")
        imports[name] = data_uri(js, "text/javascript")
    guide = read(root / "S1/task_step.json")
    def label(text):
        return text.get("ja") or text[guide["source_language"]]
    steps = [dict(id=s["id"], title=label(t["title"]), text=label(s["text"])) for t in guide["tasks"] for s in t["steps"]]
    versions = [dict(steps=read(p / "bindings.json")["steps"], glb=base64.b64encode((p / "model.glb").read_bytes()).decode())
                for p in (root / "S2", stage / "S2")]
    payload = json.dumps(dict(model=guide["model"], versions=versions, steps=steps, first=first or steps[0]["id"]),
                         ensure_ascii=False).replace("<", "\\u003c")
    template = (ROOT / "tools/s4-compare.html").read_text(encoding="utf-8")
    (stage / "compare.html").write_text(template.replace("IMPORT_MAP", json.dumps({"imports": imports})).replace("PAYLOAD", payload),
                                        encoding="utf-8")


def apply(round_dir, review_file):
    root = round_dir.parents[1]
    manifest, review = read(round_dir / "manifest.json"), read(review_file)
    round_id = key(manifest)
    need(round_dir.parent.name == "S4" and round_dir.name == round_id[:16] and review["round"] == round_id, "Wrong frozen round")
    verify(root, manifest)
    need(digest(round_dir / "prompt.md") == manifest["tools"]["generation/s4.md"] and
         digest(round_dir / "protocol.md") == manifest["tools"]["docs/s4.md"], "Frozen instructions differ")
    need(isinstance(review["reviewer"], str) and review["reviewer"].strip(), "Reviewer required")
    captures = manifest["captures"]
    guide = read(root / "S1/task_step.json")
    ids, figures = production.check_s1(root / "S1", manifest["pdf"], manifest["model"])
    baseline = read(root / "S2/bindings.json")
    bindings = copy.deepcopy(baseline)
    model = Model(root / "S2/model.glb")
    covered, edited, notes = set(), set(), {}
    geometry = False
    for finding in review["findings"]:
        cid = finding["capture"]
        cap = captures[cid]
        covered.add(cid)
        need(all(isinstance(finding[k], str) and finding[k].strip() for k in ("property", "baseline", "observation")),
             "Each decision needs a property, baseline and observation")
        need(finding["decision"] in ("confirmed", "revise", "unresolved"), "Unknown decision")
        if cap["mime"].startswith("video/"):
            lo, hi = vector(finding["seconds"], 2)
            need(0 <= lo < hi <= cap["lastFrameSeconds"]+.001, "Interval outside video")
        else:
            x1,y1,x2,y2 = vector(finding["region"], 4)
            need(0 <= x1 < x2 <= 1 and 0 <= y1 < y2 <= 1, "Invalid photo region")
        edits = finding.get("edits", [])
        need(bool(edits) == (finding["decision"] == "revise"), "Physical edits require a revise decision")
        for e in edits:
            kind = e["op"]
            target = (kind, e.get("clip"), e.get("node"), e.get("path"), e.get("id"))
            need(target not in edited, "Conflicting edits")
            edited.add(target)
            if kind == "track":
                model.track(e)
                geometry = True
            elif kind == "material":
                model.material(e)
                geometry = True
            elif kind in ("parts", "steps"):
                need(e["id"] in bindings[kind], "Unknown binding")
                bindings[kind][e["id"]] = e["value"]
            else:
                raise ValueError("Unsupported local edit: " + kind)
        if "remainingNote" in finding:
            note = cap["note"]
            matches = [i for i,n in enumerate(baseline["notes"]) if n == note]
            need(len(matches) == 1, "Cannot uniquely identify original note")
            i = matches[0]
            new = finding["remainingNote"]
            need(new is None or isinstance(new,str) and new.strip(), "Invalid remaining note")
            need(i not in notes or notes[i] == new, "Conflicting follow-up notes")
            notes[i] = new
    need(covered == set(captures), "Review must address every selected capture")
    bindings["notes"] = [dict(n, text=notes.get(i,n["text"])) for i,n in enumerate(baseline["notes"])
                         if i not in notes or notes[i] is not None]
    parent = round_dir / "revisions"
    parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=parent) as temp:
        stage = Path(temp) / "revision"
        output = stage / "S2"
        output.mkdir(parents=True)
        if geometry:
            model.save(output / "model.glb")
        else:
            shutil.copyfile(root / "S2/model.glb", output / "model.glb")
        write(output / "bindings.json", bindings)
        write(stage / "review.json", review)
        production.check_s2(output, ids, figures)
        replay = subprocess.run(["node", str(ROOT / "tools/s4-replay.mjs"), str(root / "S2"), str(output)],
                                capture_output=True, text=True, encoding="utf-8", timeout=120)
        need(replay.returncode == 0, "Replay failed: " + replay.stderr[-1500:])
        verification = json.loads(replay.stdout)
        first = next((s["step"] for s in verification["playback"] if s["changedSampledNodes"] or s["before"] != s["after"]), None)
        comparison(root, stage, first)
        verification.update(round=round_id, review=key(review), sha256={f.name:digest(f) for f in output.iterdir()},
                            originalSha256={f:manifest["files"]["S2/"+f] for f in ("model.glb","bindings.json")})
        write(stage / "verification.json", verification)
        verify(root, manifest)
        result = parent / key(review)[:16]
        publish(stage, result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("device", type=Path)
    p.add_argument("--capture", action="append")
    p = sub.add_parser("apply")
    p.add_argument("round", type=Path)
    p.add_argument("review", type=Path)
    args = parser.parse_args()
    print(prepare(args.device, args.capture) if args.action == "prepare" else apply(args.round.resolve(), args.review))
