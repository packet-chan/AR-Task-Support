"""Fixed PDF production stages. Only validated delivery files are published."""
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

GENERATION = Path(__file__).resolve().parent / "generation"
FIGURE = re.compile(r"p[0-9]{3,}-[0-9]{2,}\.png")
STAGES = {"models": "型番候補", "s1": "S1", "s2": "S2"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def stage_root(database, generation, identifier, model):
    slug = re.sub(r"[^a-z0-9_-]+", "-", model.lower()).strip("-")[:48] or "device"
    return database.resolve().parent / "devices" / generation / (slug + "-" + identifier)


def import_workspace(database, generation, identifier, pdf):
    root = database.resolve().parent / "devices" / generation / identifier
    if root.is_dir():
        return root
    root.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=root.parent) as tmp:
        work = Path(tmp) / "import"
        (work / "S1/figure").mkdir(parents=True)
        (work / "manual.pdf").write_bytes(pdf)
        template = {"pdf_id": identifier, "model": "", "source_language": "", "parts_figures": [],
                    "tasks": [{"id": "", "title": {"en": ""}, "precautions": [],
                               "steps": [{"id": "", "text": {"en": ""}, "pages": [], "figures": []}]}]}
        (work / "S1/task_step.json").write_text(json.dumps(template, indent=2), encoding="utf-8")
        work.rename(root)
    return root


def select_workspace(database, generation, identifier, model, pdf):
    root = stage_root(database, generation, identifier, model)
    if not root.exists():
        import_workspace(database, generation, identifier, pdf).rename(root)
    guide_path = root / "S1/task_step.json"
    guide = read_json(guide_path)
    if guide["model"] != model:
        guide["model"] = model
        pending = guide_path.with_suffix(".tmp")
        pending.write_text(json.dumps(guide, ensure_ascii=False, indent=2), encoding="utf-8")
        pending.replace(guide_path)
    return root


def run_codex(work, prompt, options):
    cli = shutil.which("codex.exe") or shutil.which("codex")
    require(cli, "Codex CLIを配信PCに用意してください。")
    args = [cli, "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
            "--cd", str(work), *options, "-"]
    result = subprocess.run(args, input=prompt.encode(), cwd=work, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, timeout=3600)
    require(result.returncode == 0, "Codexで生成できませんでした。CLIのログイン・接続・入力サイズを確認してください。")


MANUAL_TOOLS = {
    "s1": ("read_manual", "view_page", "save_figures", "save_guide"),
    "s2": ("read_manual", "view_page", "view_figure", "read_bindings", "save_bindings", "save_model"),
}


def prepare_bindings(root):
    path = root / "S2/bindings.json"
    if path.exists():
        return  # Resume with any edits already saved by Astra.
    guide = read_json(root / "S1/task_step.json")
    steps = {step["id"]: {"target_part": None, "clips": []}
             for task in guide["tasks"] for step in task["steps"]}
    path.parent.mkdir(exist_ok=True)
    pending = path.with_suffix(".tmp")
    pending.write_text(json.dumps({"parts": {}, "steps": steps, "notes": []}, indent=2, ensure_ascii=False),
                       encoding="utf-8")
    pending.replace(path)


def build_model(work, scene):
    node = shutil.which("node")
    require(node, "GLBの作成にNode.jsが必要です。")
    folder = work / "S2"
    with tempfile.TemporaryDirectory(dir=folder) as tmp:
        source = Path(tmp) / "scene.json"
        source.write_text(json.dumps({"scene": scene}), encoding="utf-8")
        model = Path(tmp) / "model.glb"
        built = subprocess.run([node, str(GENERATION / "build-model.mjs"), str(source), str(model)],
                               capture_output=True, timeout=120)
        require(built.returncode == 0, "モデルの形状・動作の組立に失敗しました。" +
                built.stderr.decode("utf-8", errors="replace")[-1200:])
        model.replace(folder / "model.glb")


def run_generator(stage, work):
    if stage in MANUAL_TOOLS:
        page_count = None
        if stage == "s1":
            info = subprocess.run(["pdfinfo", "manual.pdf"], cwd=work, capture_output=True, timeout=120, check=True)
            pages = re.search(rb"^Pages:\s*(\d+)", info.stdout, re.MULTILINE)
            require(pages, "PDFのページ数を取得できませんでした。")
            page_count = int(pages[1])
        runtime = GENERATION.parent / ".local/s1-runtime" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        python = str(runtime) if runtime.is_file() else sys.executable
        tool_args = [str(GENERATION / "manual_tools.py"), str(work.resolve()), stage]
        options = ["--model", "gpt-6.2-astra", "--sandbox", "read-only", "--disable", "shell_tool",
                   "-c", "mcp_servers.manual.command=" + json.dumps(python, ensure_ascii=False),
                   "-c", "mcp_servers.manual.args=" + json.dumps(tool_args, ensure_ascii=False),
                   "-c", "mcp_servers.manual.required=true"]
        for tool in MANUAL_TOOLS[stage]:
            options.extend(["-c", f'mcp_servers.manual.tools.{tool}.approval_mode="approve"'])
        run_codex(work, (GENERATION / (stage + ".md")).read_text(encoding="utf-8"), options)
        return page_count

    renderer, extractor = shutil.which("pdftoppm"), shutil.which("pdftotext")
    require(renderer and extractor, "配信PCにPoppler（pdftoppm・pdftotext）が必要です。")
    subprocess.run([renderer, "-scale-to", "1400", "-png", "manual.pdf", "page"],
                   cwd=work, capture_output=True, timeout=240, check=True)
    pages = sorted(work.glob("page-*.png"), key=lambda p: int(p.stem.split("-")[1]))
    require(pages, "PDFを画像化できませんでした。")
    text = subprocess.run([extractor, "-layout", "-enc", "UTF-8", "manual.pdf", "-"],
                          cwd=work, capture_output=True, timeout=120, check=True).stdout.decode("utf-8")
    inputs = read_json(work / "input.json")
    inputs["images_in_order"] = [p.name for p in pages]
    inputs["pdf_pages"] = text.rstrip("\f").split("\f")
    prompt = (GENERATION / "models.md").read_text(encoding="utf-8")
    prompt += ("\nUse only the attached images and the input data below. "
               "Do not run tools or access files. Return only the requested JSON object.\n")
    args = ["--sandbox", "read-only", "-o", "answer.json"]
    for page in pages:
        args.extend(["-i", page.name])
    run_codex(work, prompt + json.dumps(inputs, ensure_ascii=False), args)
    require(all(row["page"] <= len(pages) for row in candidates(work)), "型番候補の出典ページが範囲外です。")


def regular(path):
    require(path.is_file() and not path.is_symlink() and not getattr(path.stat(), "st_file_attributes", 0) & 1024,
            "成果物に通常のファイルが必要です。")
    return path


def directory(path):
    require(path.is_dir() and not path.is_symlink() and not getattr(path.stat(), "st_file_attributes", 0) & 1024,
            "成果物のフォルダがありません。")
    return path


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def candidates(work):
    rows = read_json(regular(work / "answer.json"))["models"]
    require(isinstance(rows, list), "型番候補の形式を確認してください。")
    seen = set()
    for row in rows:
        model = row["model"]
        require(nonempty(model) and len(model) <= 160 and model not in seen and
                type(row["page"]) is int and row["page"] > 0, "型番候補か出典ページが不正です。")
        seen.add(model)
    return rows


def check_s1(folder, identifier, model, page_count=None):
    guide = read_json(regular(folder / "task_step.json"))
    require(guide["pdf_id"] == identifier and guide["model"] == model, "PDFまたは型番が一致しません。")
    lang = guide["source_language"]
    task_ids, step_ids, images = set(), set(), set()

    def figures(names):
        require(isinstance(names, list) and all(isinstance(n, str) and FIGURE.fullmatch(n) for n in names),
                "図のファイル名が不正です。")
        images.update(names)

    figures(guide["parts_figures"])
    require(nonempty(lang) and isinstance(guide["tasks"], list) and guide["tasks"], "作業がありません。")
    for task in guide["tasks"]:
        require(nonempty(task["id"]) and task["id"] not in task_ids and nonempty(task["title"][lang]),
                "作業IDか原文タイトルが不正です。")
        task_ids.add(task["id"])
        precautions = task.get("precautions", [])
        require(isinstance(precautions, list), "作業前の注意は配列で指定してください。")
        require(isinstance(task["steps"], list) and task["steps"], "手順がありません。")
        for item in [*precautions, *task["steps"]]:
            require(isinstance(item, dict) and isinstance(item.get("text"), dict) and nonempty(item["text"].get(lang)),
                    "注意・手順に原文が必要です。")
            pages = item.get("pages")
            require(isinstance(pages, list) and pages and all(type(p) is int and p > 0 for p in pages),
                    "注意・手順に出典ページが必要です。")
            require(page_count is None or max(pages) <= page_count, "出典ページがPDFの範囲外です。")
        for step in task["steps"]:
            require(nonempty(step["id"]) and step["id"] not in step_ids, "手順IDが不正です。")
            step_ids.add(step["id"])
            figures(step["figures"])
    directory(folder / "figure")
    for name in images:
        with regular(folder / "figure" / name).open("rb") as f:
            require(f.read(8) == b"\x89PNG\r\n\x1a\n", "参照する図をPNGで保存してください。")
    return step_ids, images


def glb_names(path):
    with regular(path).open("rb") as f:
        magic, version, size, length, kind = struct.unpack("<4sIII4s", f.read(20))
        require(magic == b"glTF" and version == 2 and size == path.stat().st_size and kind == b"JSON"
                and 0 < length <= size - 20, "GLBの形式が不正です。")
        gltf = json.loads(f.read(length))
        binary_size, binary_type = struct.unpack("<I4s", f.read(8))
        require(binary_type == b"BIN\0" and binary_size > 0 and f.tell() + binary_size == size,
                "GLBのモデルデータがありません。")
    require(gltf.get("meshes") and gltf.get("scenes") and gltf.get("asset", {}).get("version") == "2.0"
            and not any("uri" in item for key in ("buffers", "images") for item in gltf.get(key, [])),
            "単独で表示できるGLBが必要です。")
    return [Counter(item.get("name") for item in gltf.get(key, [])) for key in ("nodes", "animations")]


def check_s2(folder, step_ids, images):
    nodes, animations = glb_names(folder / "model.glb")
    data = read_json(regular(folder / "bindings.json"))
    parts, steps = data["parts"], data["steps"]
    require(isinstance(parts, dict) and parts and isinstance(steps, dict) and set(steps) == step_ids,
            "部品一覧、またはS1の手順との対応が不足しています。")
    used_nodes = set()
    for part_id, part in parts.items():
        node = part["node"]
        require(nonempty(part_id) and nonempty(part["name"]) and nonempty(node) and nodes[node] == 1
                and node not in used_nodes, "部品のGLBノードを特定できません。")
        used_nodes.add(node)
        require(isinstance(part["clips"], list) and all(animations[c] == 1 for c in part["clips"]),
                "部品のクリップがGLBと一致しません。")
        require(isinstance(part["figures"], list), "部品図の形式が不正です。")
        for mark in part["figures"]:
            point = mark["point"]
            require(mark["file"] in images and isinstance(point, list) and len(point) == 2
                    and all(type(v) in (int, float) and math.isfinite(v) and 0 <= v <= 1 for v in point),
                    "部品図の参照か座標が不正です。")
    for step in steps.values():
        target, clips = step["target_part"], step["clips"]
        require(set(step) == {"target_part", "clips"} and (target is None or target in parts)
                and isinstance(clips, list) and all(target and animations[c] == 1 for c in clips),
                "対象部品か手順クリップが不正です。")
    require(isinstance(data["notes"], list), "確認メモの形式が不正です。")
    for note in data["notes"]:
        require(nonempty(note["text"]) and ("part" in note or "step" in note)
                and ("part" not in note or note["part"] in parts)
                and ("step" not in note or note["step"] in steps), "確認メモの対象が不正です。")
