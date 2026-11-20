"""Astra's stage-specific file operations for one manual, over local stdio."""
import json
import re
import sys
from pathlib import Path

import pymupdf
from mcp.server.fastmcp import FastMCP, Image
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from production import FIGURE, MANUAL_TOOLS, build_model, read_json

server = FastMCP("manual")


class Figure(BaseModel):
    file: str
    image: int | None = None
    region: list[float] | None = None


def read_manual(first_page: int = 1, last_page: int | None = None) -> dict:
    """Read the existing guide and PDF text. Image numbers refer to pictures on that page."""
    with pymupdf.open(work / "manual.pdf") as pdf:
        end = min(last_page or first_page + 7, len(pdf))
        if not 1 <= first_page <= end:
            raise ValueError("Invalid page range")
        pages = []
        for number in range(first_page, end + 1):
            page = pdf[number - 1]
            pages.append({"page": number, "bounds": list(page.rect), "text": page.get_text(sort=True),
                          "images": [{"image": i, "bounds": list(pymupdf.Rect(info["bbox"]) * page.rotation_matrix)}
                                     for i, info in enumerate(page.get_image_info(), 1)]})
        return {"guide": json.loads((work / "S1/task_step.json").read_text(encoding="utf-8-sig")),
                "page_count": len(pdf), "pages": pages}


def view_page(number: int) -> Image:
    """View the original PDF page (1-based) to identify figures, labels, and their reading order."""
    with pymupdf.open(work / "manual.pdf") as pdf:
        if not 1 <= number <= len(pdf):
            raise ValueError("Invalid page")
        page = pdf[number - 1]
        scale = 1400 / max(page.rect.width, page.rect.height)
        return Image(data=page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).tobytes("png"), format="png")


def save_figures(figures: list[Figure]) -> list[str]:
    """Save named PNGs. For each p012-01.png select a page image by number, or a region [left,top,right,bottom] in PDF points to include labels or vector diagrams."""
    saved = []
    with pymupdf.open(work / "manual.pdf") as pdf:
        for figure in figures:
            match = re.fullmatch(r"p([0-9]{3,})-[0-9]{2,}\.png", figure.file)
            if not match or not 1 <= int(match[1]) <= len(pdf):
                raise ValueError("Use a figure filename with a valid physical page number")
            page = pdf[int(match[1]) - 1]
            if figure.image is not None and figure.region is None:
                images = page.get_image_info()
                if not 1 <= figure.image <= len(images):
                    raise ValueError("Unknown image on this page")
                rect = pymupdf.Rect(images[figure.image - 1]["bbox"]) * page.rotation_matrix
            elif figure.image is None and figure.region and len(figure.region) == 4:
                rect = pymupdf.Rect(figure.region)
            else:
                raise ValueError("Choose either an image or a region")
            rect &= page.rect
            if rect.is_empty or not rect.is_valid:
                raise ValueError("Empty figure")
            scale = min(3, 2000 / max(rect.width, rect.height))
            png = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=rect, alpha=False).tobytes("png")
            (work / "S1/figure" / figure.file).write_bytes(png)
            saved.append(figure.file)
    return saved


def save_guide(guide: dict) -> str:
    """Save the complete production guide as S1/task_step.json, using the existing PDF ID and selected model."""
    path = work / "S1/task_step.json"
    original = json.loads(path.read_text(encoding="utf-8-sig"))
    if any(guide.get(key) != original[key] for key in ("model", "pdf_id")):
        raise ValueError("Keep the selected model and PDF ID")
    write_json(path, guide)
    return "Saved S1/task_step.json"


def write_json(path, data):
    pending = path.with_suffix(".tmp")
    pending.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    pending.replace(path)


def view_figure(file: str) -> Image:
    """View an existing S1 cropped PNG by filename."""
    if not FIGURE.fullmatch(file):
        raise ValueError("Use an S1 figure filename")
    return Image(data=(work / "S1/figure" / file).read_bytes(), format="png")


class Mark(BaseModel):
    file: str
    point: tuple[float, float]  # x,y within the crop


class Part(BaseModel):
    name: str
    node: str
    figures: list[Mark]
    clips: list[str]


class Step(BaseModel):
    target_part: str | None
    clips: list[str]


class Note(BaseModel):
    text: str
    part: str | None = None
    step: str | None = None


def read_bindings() -> dict:
    """Read S2/bindings.json with the fixed S1 step IDs and edits saved so far."""
    return read_json(work / "S2/bindings.json")


def save_bindings(parts: dict[str, Part] | None = None, steps: dict[str, Step] | None = None,
                  notes: list[Note] | None = None) -> str:
    """Fill S2/bindings.json. Steps update only the given existing IDs.
    Supply the full parts inventory or notes when replacing them.
    Figure points are normalized x,y from the top-left of the crop.
    """
    data = read_bindings()
    if steps is not None:
        unknown = steps.keys() - data["steps"].keys()
        if unknown:
            raise ValueError("Unknown S1 step IDs: " + ", ".join(sorted(unknown)))
        data["steps"].update({key: step.model_dump() for key, step in steps.items()})
    if parts is not None:
        data["parts"] = {key: part.model_dump() for key, part in parts.items()}
    if notes is not None:
        data["notes"] = [note.model_dump(exclude_none=True) for note in notes]
    write_json(work / "S2/bindings.json", data)
    return "Saved S2/bindings.json"


def save_model(nodes: list[dict], animations: list[dict]) -> str:
    """Build S2/model.glb. Nodes have a unique ASCII alphanumeric/underscore name, optional parent,
    local position (metres, +Y up, +Z front) and rotation (XYZ degrees). Omit shape for a group.
    Use box/cylinder/sphere with size [width,height,depth], or mesh with flat vertices and triangle indices.
    Color is hex RGB. Each animation has a name and tracks of {node,path,times,values}.
    Use position or rotation, increasing seconds from zero, and one absolute local xyz triple per time.
    """
    build_model(work, {"nodes": nodes, "animations": animations})
    return "Saved S2/model.glb"


if __name__ == "__main__":
    work = Path(sys.argv[1]).resolve(strict=True)
    for name in MANUAL_TOOLS[sys.argv[2] if len(sys.argv) > 2 else "s1"]:
        server.tool()(globals()[name])
    server.run(transport="stdio")
