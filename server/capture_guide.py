"""Bind one capture request to its manual evidence, in manual order."""
import json
from pathlib import Path

from production import read_json


DATA = Path(__file__).resolve().parents[1] / "generation"
CUES = json.loads((DATA / "capture-cues-ja.json").read_text(encoding="utf-8"))
MANUAL_JA = json.loads((DATA / "capture-manual-ja.json").read_text(encoding="utf-8"))


def localized(text):
    if text and not text.get("ja") and text.get("en") in MANUAL_JA:
        return {**text, "ja": MANUAL_JA[text["en"]]}
    return text


def capture_guide(root, bindings=None):
    manual = read_json(root / "S1/task_step.json")
    if bindings is None:
        bindings = read_json(root / "S2/bindings.json")
    parts = bindings["parts"]
    steps = [(task, step, bindings["steps"][step["id"]])
             for task in manual["tasks"] for step in task["steps"]]

    def build(key, index, row, note, relation):
        task, step, link = row or ({}, {}, {})
        part_id = (note or {}).get("part") or link.get("target_part")
        part = parts.get(part_id, {})
        name = part.get("name", "手順図の対象")
        cue = CUES.get((note or {}).get("text"))
        clips = link.get("clips", [])
        mode = cue["mode"] if cue else "video" if clips else "photo"
        focus = cue["focus"] if cue else name + ("の動く部分と周囲" if clips else "の形と表示")
        action = (focus + "を、手順の動作中に短い動画で撮ってください。" if mode == "video"
                  else focus + "を、今見える状態で写真に撮ってください。")
        if focus.endswith("角度"):
            action = ("動作が見えるよう、" if mode == "video" else "") + focus + "から" + (
                "短い動画を撮ってください。" if mode == "video" else "写真を撮ってください。")
        marks = {f["file"]: f for f in part.get("figures", [])}
        files = dict.fromkeys([*step.get("figures", []), *marks])
        ordinal = next((i for i, s in enumerate(task.get("steps", []), 1) if s is step), None)
        precautions = [{**n, "text": localized(n["text"])} for n in task.get("precautions", [])]
        return dict(key=key, noteIndex=index, note=note, task=task.get("id"), title=localized(task.get("title")), ordinal=ordinal,
                    step=step.get("id"), relation=relation, text=localized(step.get("text")), source=manual.get("source_language", "ja"),
                    pages=step.get("pages", []), precautions=precautions, figures=[marks.get(f, {"file": f}) for f in files],
                    part=part_id, name=name, node=part.get("node"), clips=clips if mode == "video" else [],
                    mode=mode, request=action)

    requests = []
    for i, note in enumerate(bindings["notes"]):
        part = parts.get(note.get("part"), {})
        def score(row):
            step, link = row[1:]
            if "step" in note:
                return 4 if step["id"] == note["step"] else 0
            shared = bool(set(part.get("clips", [])) & set(link["clips"]))
            direct = bool(note.get("part") and link["target_part"] == note["part"])
            return 2 * shared + direct
        pos = max(range(len(steps)), key=lambda j: score(steps[j]), default=None)
        if pos is None or not score(steps[pos]):
            pos = len(steps)
        row = steps[pos] if pos < len(steps) else None
        relation = "step" if "step" in note else "part-step" if row else "part"
        requests.append((pos, build(f"n{i}", i, row, note, relation)))
    if not requests:
        requests = [(i, build(f"s{i}", None, row, None, "step")) for i, row in enumerate(steps)]
    ordered = [item for _, item in sorted(requests, key=lambda pair: pair[0])]
    first = {"C7070":"Body","CD-SE50":"body","HD8943":"Tray","MOR-1550":"Cabinet",
             "PN-L652B":"Logo","PRO-6600":"Status"}.get(manual.get("model","").upper())
    ordered = sorted(ordered,key=lambda g: (g["mode"]=="video",g["part"]!=first))
    if ordered and ordered[0]["mode"]=="photo":
        ordered[0]["request"] = "機器は今の状態のままで大丈夫です。"+ordered[0]["request"]
    return ordered
