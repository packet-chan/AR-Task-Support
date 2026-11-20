import json
import tempfile
import unittest
from contextlib import closing
from importlib.util import find_spec
from pathlib import Path
from unittest.mock import patch

import production
import serve


class ProductionTest(unittest.TestCase):
    @unittest.skipUnless(find_spec("mcp") and find_spec("pymupdf"), "Uses the manual-tool runtime")
    def test_s2_partial_saves_keep_s1_step_ids_and_order(self):
        from generation import manual_tools
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            (work / "S1").mkdir()
            guide = {"tasks": [{"steps": [{"id": "fill"}, {"id": "wait"}]}, {"steps": [{"id": "empty"}]}]}
            (work / "S1/task_step.json").write_text(json.dumps(guide))
            production.prepare_bindings(work)
            with patch.object(manual_tools, "work", work, create=True):
                part = manual_tools.Part(name="Tank", node="Tank", figures=[], clips=[])
                target = manual_tools.Step(target_part="tank", clips=[])
                manual_tools.save_bindings(parts={"tank": part}, steps={"fill": target})
                production.prepare_bindings(work)
                manual_tools.save_bindings(steps={"empty": target}, notes=[manual_tools.Note(text="Check", part="tank")])
                saved = manual_tools.read_bindings()
                self.assertEqual(list(saved["steps"]), ["fill", "wait", "empty"])
                self.assertEqual(saved["steps"]["wait"], {"target_part": None, "clips": []})
                self.assertEqual(saved["steps"]["fill"], target.model_dump())
                self.assertEqual(saved["parts"]["tank"], part.model_dump())
                self.assertEqual(saved["notes"], [{"text": "Check", "part": "tank"}])
                with self.assertRaises(ValueError):
                    manual_tools.save_bindings(parts={}, steps={"new": target})
                self.assertEqual(manual_tools.read_bindings(), saved)

    def test_step_can_play_lid_before_lifting_tank(self):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            parts = {key: {"name": key, "node": key, "figures": [], "clips": [clip]}
                     for key, clip in [("Lid", "open"), ("Tank", "lift")]}
            step = {"target_part": "Tank", "clips": ["open", "lift"]}
            bindings = {"parts": parts, "steps": {"remove": step}, "notes": []}
            nodes = [{"name": key, "shape": "box", "size": [1, 1, 1]} for key in parts]
            animations = [{"name": part["clips"][0], "tracks": [
                {"node": key, "path": "position", "times": [0, 1], "values": [[0, 0, 0], [0, 1, 0]]}]}
                for key, part in parts.items()]
            (work / "S2").mkdir()
            (work / "S2/bindings.json").write_text(json.dumps(bindings))
            production.build_model(work, {"nodes": nodes, "animations": animations})
            production.check_s2(work / "S2", {"remove"}, set())
            step["clips"].append("missing")
            (work / "S2/bindings.json").write_text(json.dumps(bindings))
            with self.assertRaises(ValueError):
                production.check_s2(work / "S2", {"remove"}, set())

    def test_import_template_survives_duplicate_add_and_model_selection(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "manuals.sqlite3"
            args = (path, "generation", "pdf-example")
            initial = production.import_workspace(*args, b"original")
            self.assertEqual(production.import_workspace(*args, b"duplicate"), initial)
            template = production.read_json(initial / "S1/task_step.json")
            self.assertEqual(template["model"], "")
            self.assertEqual(template["tasks"][0]["steps"][0]["id"], "")
            self.assertEqual(list((initial / "S1/figure").iterdir()), [])
            selected = production.select_workspace(*args, "TEST-1", b"original")
            self.assertFalse(initial.exists())
            self.assertEqual((selected / "manual.pdf").read_bytes(), b"original")
            self.assertEqual(production.read_json(selected / "S1/task_step.json"), {**template, "model": "TEST-1"})

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
                    self.assertEqual(production.read_json(work / "S1/task_step.json")["model"], model)
                    (work / "S1/task_step.json").write_text(json.dumps(guide))
                    return
                part = {"name": "Body", "node": "Body", "figures": [], "clips": []}
                self.assertEqual(work, root)
                saved = production.read_json(work / "S2/bindings.json")
                if stages.count("s2") == 1:
                    self.assertEqual(saved, {"steps": {"wait": {"target_part": None, "clips": []}},
                                             "parts": {}, "notes": []})
                else:
                    self.assertEqual(saved["steps"]["wait"]["target_part"], "missing")
                target = "missing" if stages.count("s2") == 1 else None
                bindings = {"parts": {"body": part}, "steps": {"wait": {"target_part": target, "clips": []}},
                            "notes": []}
                scene = {"nodes": [{"name": "Body", "shape": "box", "size": [1, 1, 1]}], "animations": []}
                (work / "S2/bindings.json").write_text(json.dumps(bindings))
                production.build_model(work, scene)

            with patch.object(production, "run_generator", generate):
                serve.produce(path, token, identifier)
                self.assertTrue((root / "S2/bindings.json").is_file())
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
