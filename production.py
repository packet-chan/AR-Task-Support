"""Fixed PDF production stages. Only validated delivery files are published."""
import json
import math
import re
import shutil
import struct
import subprocess
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
    return database.parent / "devices" / generation / (slug + "-" + identifier)


def ask_stage(stage, work, pages, text):
    cli = shutil.which("codex.exe") or shutil.which("codex")
    require(cli, "Codex CLIを配信PCに用意してください。")
    prompt = (GENERATION / (stage + ".md")).read_text(encoding="utf-8")
    inputs = read_json(work / "input.json")
    images = pages.copy()
    if stage == "s2":
        inputs["guide"] = read_json(work / "S1/task_step.json")
        images.extend(sorted((work / "S1/figure").glob("*.png")))
    inputs["images_in_order"] = [p.relative_to(work).as_posix() for p in images]
    inputs["pdf_pages"] = text.rstrip("\f").split("\f")
    prompt += ("\nUse only the attached images and the input data below. "
               "Do not run tools or access files. Return only the requested JSON object.\n")
    args = [cli, "exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--sandbox",
            "read-only", "--cd", str(work), "-o", "answer.json"]
    for image in images:
        args.extend(["-i", str(image.relative_to(work))])
    result = subprocess.run([*args, "-"], input=(prompt + json.dumps(inputs, ensure_ascii=False)).encode(),
                            cwd=work, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=3600)
    require(result.returncode == 0, "Codexで生成できませんでした。CLIのログイン・接続・入力サイズを確認してください。")
    return read_json(work / "answer.json")


def write_guide(work, answer, pages, render):
    folder = work / "S1"
    (folder / "figure").mkdir(parents=True)
    for crop in answer["crops"]:
        name, box = crop["file"], crop["box"]
        require(isinstance(name, str) and FIGURE.fullmatch(name), "切り抜きのファイル名が不正です。")
        page = int(name.split("-")[0][1:])
        require(1 <= page <= len(pages) and len(box) == 4 and
                all(type(v) in (int, float) and 0 <= v <= 1 for v in box)
                and box[0] < box[2] and box[1] < box[3], "切り抜き位置が不正です。")
        with pages[page - 1].open("rb") as f:
            f.seek(16)
            w, h = struct.unpack(">II", f.read(8))
        x, y = int(box[0] * w), int(box[1] * h)
        render("-f", str(page), "-l", str(page), "-singlefile", "-x", str(x), "-y", str(y),
               "-W", str(math.ceil(box[2] * w) - x), "-H", str(math.ceil(box[3] * h) - y),
               "-png", "manual.pdf", str(folder / "figure" / name[:-4]))
    guide = answer["guide"]
    for task in guide["tasks"]:
        for step in task["steps"]:
            require(all(type(p) is int and 1 <= p <= len(pages) for p in step["pages"]),
                    "出典ページがPDFの範囲外です。")
    (folder / "task_step.json").write_text(json.dumps(guide, ensure_ascii=False), encoding="utf-8")


def build_model(work, answer):
    node = shutil.which("node")
    require(node, "GLBの作成にNode.jsが必要です。")
    folder = work / "S2"
    folder.mkdir()
    builder = GENERATION / "build-model.mjs"
    built = subprocess.run([node, str(builder), str(work / "answer.json"), str(folder / "model.glb")],
                           capture_output=True, timeout=120)
    require(built.returncode == 0, "モデルの形状・動作の組立に失敗しました。Three.jsの導入状態も確認してください。")
    (folder / "bindings.json").write_text(json.dumps(answer["bindings"], ensure_ascii=False), encoding="utf-8")


def run_generator(stage, work):
    renderer, extractor = shutil.which("pdftoppm"), shutil.which("pdftotext")
    require(renderer and extractor, "配信PCにPoppler（pdftoppm・pdftotext）が必要です。")

    def render(*args):
        subprocess.run([renderer, "-scale-to", "1400", *args], cwd=work, capture_output=True,
                       timeout=240, check=True)

    render("-png", "manual.pdf", "page")
    pages = sorted(work.glob("page-*.png"), key=lambda p: int(p.stem.split("-")[1]))
    require(pages, "PDFを画像化できませんでした。")
    text = subprocess.run([extractor, "-layout", "-enc", "UTF-8", "manual.pdf", "-"],
                          cwd=work, capture_output=True, timeout=120, check=True).stdout.decode("utf-8")
    answer = ask_stage(stage, work, pages, text)
    if stage == "models":
        require(all(type(row["page"]) is int and 1 <= row["page"] <= len(pages) for row in answer["models"]),
                "型番候補の出典ページが範囲外です。")
    elif stage == "s1":
        write_guide(work, answer, pages, render)
    else:
        build_model(work, answer)


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


def check_s1(folder, identifier, model):
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
        require(isinstance(task["steps"], list) and task["steps"], "手順がありません。")
        for step in task["steps"]:
            require(nonempty(step["id"]) and step["id"] not in step_ids and nonempty(step["text"][lang]),
                    "手順IDか原文が不正です。")
            step_ids.add(step["id"])
            pages = step["pages"]
            require(isinstance(pages, list) and pages and all(type(p) is int and p > 0 for p in pages),
                    "手順に出典ページが必要です。")
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
                and isinstance(clips, list) and all(target and c in parts[target]["clips"] for c in clips),
                "対象部品か手順クリップが不正です。")
    require(isinstance(data["notes"], list), "確認メモの形式が不正です。")
    for note in data["notes"]:
        require(nonempty(note["text"]) and ("part" in note or "step" in note)
                and ("part" not in note or note["part"] in parts)
                and ("step" not in note or note["step"] in steps), "確認メモの対象が不正です。")


def prepare(stage, work, pdf, inputs, root):
    (work / "manual.pdf").write_bytes(pdf)
    (work / "input.json").write_text(json.dumps(inputs, ensure_ascii=False), encoding="utf-8")
    if stage == "s2":
        shutil.copytree(root / "S1", work / "S1")


def publish(root, stage, source, files):
    root.mkdir(parents=True, exist_ok=True)
    target = root / stage
    if target.exists():
        return  # A crash may have published the stage before its DB commit.
    with tempfile.TemporaryDirectory(dir=root) as temp:
        delivery = Path(temp) / stage
        delivery.mkdir()
        if stage == "S1":
            (delivery / "figure").mkdir()
        for name in files:
            shutil.copyfile(source / name, delivery / name)
        delivery.rename(target)
