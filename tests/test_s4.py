import base64
import copy
import tempfile
import unittest
from pathlib import Path

import production
from tools import s4


class RevisionTest(unittest.TestCase):
    def test_freeze_review_replay_and_reject_changed_inputs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ("S1/figure", "S2", "S3/captures/" + "a"*32):
                (root / name).mkdir(parents=True)
            (root / "manual.pdf").write_bytes(b"fixture")
            step = {"id": "s", "text": {"ja": "開ける"}, "pages": [1], "figures": []}
            s4.write(root / "S1/task_step.json", {"model": "test", "pdf_id": "pdf-test", "parts_figures": [],
                     "source_language": "ja", "tasks": [{"id": "t", "title": {"ja": "開閉"}, "steps": [step]}]})
            note = {"part": "lid", "text": "Check the lid."}
            s4.write(root / "S2/bindings.json", {"parts": {"lid": {"name": "ふた", "node": "Lid", "figures": [],
                     "clips": ["Open"]}}, "steps": {"s": {"target_part": "lid", "clips": ["Open"]}}, "notes": [note]})
            production.build_model(root, {"nodes": [{"name": "Lid", "shape": "box", "size": [1,1,1]}],
                "animations": [{"name": "Open", "tracks": [{"node": "Lid", "path": "rotation", "times": [0,1],
                                                            "values": [[0,0,0], [0,0,90]]}]}]})
            cid = "a"*32
            photo = root / "S3/captures" / cid / "photo.jpg"
            photo.write_bytes(base64.b64decode("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAIAAgBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+v//Z"))
            s4.write(photo.with_name("capture.json"), {"id": cid, "file": photo.name, "bytes": photo.stat().st_size,
                                                       "mime": "image/jpeg", "note": note})
            frozen = s4.prepare(root, [cid])
            review = s4.read(frozen / "review-template.json")
            review["reviewer"] = "fixture"
            item = review["findings"][0]
            item.update(region=[0,0,1,1], property="surface", baseline="opaque", observation="transparent",
                        decision="revise", edits=[{"op":"material", "node":"Lid", "rgba":[1,1,1,.4]}], remainingNote=None)
            review_file = root / "review.json"
            s4.write(review_file, review)
            result = s4.apply(frozen, review_file)
            self.assertEqual(result, s4.apply(frozen, review_file))
            self.assertEqual(s4.read(root / "S2/bindings.json")["notes"], [note])
            self.assertEqual(s4.read(result / "S2/bindings.json")["notes"], [])
            self.assertEqual(s4.read(result / "verification.json")["steps"], 1)
            self.assertEqual(s4.read(frozen / "manifest.json")["files"]["S2/model.glb"], s4.digest(root / "S2/model.glb"))
            for change in ({"decision":"unresolved"}, {"region":[.7,0,.3,1]}):
                invalid = copy.deepcopy(review)
                invalid["findings"][0].update(change)
                s4.write(review_file, invalid)
                with self.assertRaises(ValueError):
                    s4.apply(frozen, review_file)
            s4.write(review_file, review)
            photo.write_bytes(photo.read_bytes()+b"changed")
            with self.assertRaisesRegex(ValueError, "Input changed"):
                s4.apply(frozen, review_file)
            self.assertEqual(list(result.parent.iterdir()), [result])