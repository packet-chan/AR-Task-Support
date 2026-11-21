"""Create a standalone DEMO library from the ready guides of one chosen participant."""
import argparse
import shutil
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path

import production
from serve import ROOT, library_path, open_library, user_id


def prepare_demo(database, source_user):
    source = library_path(database, source_user)
    destination = library_path(database, "DEMO").parent
    if destination.exists():
        raise FileExistsError("DEMO already exists. Its contents have been preserved.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as tmp:
        staged = Path(tmp) / "DEMO" / "manuals.sqlite3"
        uri = source.resolve().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True)) as src, closing(open_library(staged, create=True)) as dst, dst:
            src.execute("BEGIN")
            old = src.execute("SELECT generation FROM identity").fetchone()[0]
            new = dst.execute("SELECT generation FROM identity").fetchone()[0]
            count = 0
            for row in src.execute("""SELECT id,name,model,pdf,cover FROM manuals JOIN production USING(id)
                                      WHERE stage='ready' ORDER BY manuals.rowid"""):
                identifier, _, model = row[:3]
                before = production.stage_root(source, old, identifier, model)
                after = production.stage_root(staged, new, identifier, model)
                assets = [Path("S1/task_step.json"), Path("S2/bindings.json"), Path("S2/model.glb")]
                assets.extend(f.relative_to(before) for f in (before / "S1/figure").glob("*.png")
                              if production.FIGURE.fullmatch(f.name))
                for asset in assets:
                    (after / asset).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(before / asset, after / asset)
                dst.execute("INSERT INTO manuals VALUES (?,?,?,?,?)", row)
                dst.execute("INSERT INTO production(id,stage) VALUES (?,'ready')", (identifier,))
                count += 1
            if not count:
                raise ValueError("No completed guides to publish.")
        staged.parent.rename(destination)
    return count


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_user")
    args = parser.parse_args()
    participant = user_id(args.source_user)
    if not participant or participant == "DEMO":
        parser.error("Choose a valid source participant other than DEMO.")
    print(f"Prepared {prepare_demo(ROOT / '.local/manuals.sqlite3', participant)} guides in DEMO.")
