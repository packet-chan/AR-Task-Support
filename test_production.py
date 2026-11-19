import json
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import production
import serve


class ProductionTest(unittest.TestCase):
    def test_retry_keeps_s1_and_accepts_steps_without_targets(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "manuals.sqlite3"
            identifier, model = "pdf-example", "TEST-1"
            with closing(serve.open_library(path, create=True)) as db, db:
                db.execute("INSERT INTO manuals VALUES (?,?,?,?,?)", (identifier, "Test", model, b"pdf", None))
                db.execute("INSERT INTO production(id,stage) VALUES (?,'s1')", (identifier,))
                token = db.execute("SELECT generation FROM identity").fetchone()[0]
            root = production.stage_root(path, token, identifier, model)
            stages = []

            def generate(stage, work):
                stages.append(stage)
                if stage == "s1":
                    step = {"id": "wait", "text": {"en": "Wait."}, "pages": [1], "figures": []}
                    guide = {"pdf_id": identifier, "model": model, "source_language": "en", "parts_figures": [],
                             "tasks": [{"id": "t1", "title": {"en": "Test"}, "steps": [step]}]}
                    (work / "S1/figure").mkdir(parents=True)
                    (work / "S1/task_step.json").write_text(json.dumps(guide))
                    return
                part = {"name": "Body", "node": "Body", "figures": [], "clips": []}
                target = "missing" if stages.count("s2") == 1 else None
                bindings = {"parts": {"body": part}, "steps": {"wait": {"target_part": target, "clips": []}},
                            "notes": []}
                scene = {"nodes": [{"name": "Body", "shape": "box", "size": [1, 1, 1]}], "animations": []}
                answer = {"bindings": bindings, "scene": scene}
                (work / "answer.json").write_text(json.dumps(answer))
                production.build_model(work, answer)

            with patch.object(production, "run_generator", generate):
                serve.produce(path, token, identifier)
                self.assertFalse((root / "S2").exists())
                original = (root / "S1/task_step.json").read_bytes()
                with closing(serve.open_library(path)) as db, db:
                    stage, error = db.execute("SELECT stage,error FROM production").fetchone()
                    self.assertEqual(stage, "s2")
                    self.assertTrue(error)
                    db.execute("UPDATE production SET error=''")
                serve.produce(path, token, identifier)
            self.assertEqual(stages, ["s1", "s2", "s2"])
            self.assertEqual(original, (root / "S1/task_step.json").read_bytes())
            self.assertTrue((root / "S2/model.glb").is_file())
            with closing(serve.open_library(path)) as db:
                self.assertEqual(db.execute("SELECT stage,error FROM production").fetchone(), ("ready", ""))

    def test_deleted_participant_cannot_receive_old_generation(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "manuals.sqlite3"
            identifier = "pdf-example"
            with closing(serve.open_library(path, create=True)) as db, db:
                db.execute("INSERT INTO manuals VALUES (?,?,?,?,?)", (identifier, "Test", "", b"pdf", None))
                db.execute("INSERT INTO production(id,stage) VALUES (?,'models')", (identifier,))
                token = db.execute("SELECT generation FROM identity").fetchone()[0]

            def replace_participant(stage, work):
                path.unlink()
                with closing(serve.open_library(path, create=True)):
                    pass
                (work / "answer.json").write_text('{"models":[]}')

            with patch.object(production, "run_generator", replace_participant):
                serve.produce(path, token, identifier)
            with closing(serve.open_library(path)) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM production").fetchone()[0], 0)
            self.assertFalse((path.parent / "devices").exists())
