"""
One-time migration helper: renames the old flat artifact layout
    artifacts/<feature>/best/h<N>/
to the new two-level layout expected by training.service and equitwin_forecasting:
    artifacts/<feature>/best/st_h<N>/

Run once before using the new EquiTwin integration code.

Usage
-----
    python migrate_artifacts.py
    python migrate_artifacts.py --execute
    python migrate_artifacts.py --root /path/to/artifacts
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


def migrate(root: str = "artifacts", execute: bool = False) -> list[dict]:
    """
    Scan root for old-style h<N> directories and rename them to st_h<N>.

    Returns a list of {from, to, status} dicts describing every action taken.
    """
    root_p = Path(root)
    if not root_p.exists():
        raise FileNotFoundError(f"Artifacts root not found: {root_p.resolve()}")

    actions: list[dict] = []

    for feature_dir in sorted(root_p.iterdir()):
        if not feature_dir.is_dir():
            continue
        best_dir = feature_dir / "best"
        if not best_dir.is_dir():
            continue

        for h_dir in sorted(best_dir.iterdir()):
            if not h_dir.is_dir():
                continue
            name = h_dir.name

            # Skip already-migrated directories
            if name.startswith("st_") or name.startswith("lt_"):
                actions.append({"from": str(h_dir), "to": "(already migrated)", "status": "skip"})
                continue

            # Match old pattern: h<N>
            if name.startswith("h") and name[1:].isdigit():
                new_name = f"st_{name}"
                new_dir = best_dir / new_name
                action = {"from": str(h_dir), "to": str(new_dir), "status": ""}

                if new_dir.exists():
                    action["status"] = "SKIP (target exists)"
                elif execute:
                    h_dir.rename(new_dir)
                    # Patch metadata.json to add "level": "st" if missing
                    meta_path = new_dir / "metadata.json"
                    if meta_path.exists():
                        meta = json.loads(meta_path.read_text())
                        if "level" not in meta:
                            meta["level"] = "st"
                            meta_path.write_text(json.dumps(meta, indent=2))
                    action["status"] = "RENAMED"
                else:
                    action["status"] = "DRY-RUN"
                actions.append(action)

    return actions


def main() -> None:
    ap = argparse.ArgumentParser(description="Migrate artifact directories to two-level naming.")
    ap.add_argument("--root", default="artifacts", help="Path to artifacts root (default: artifacts)")
    ap.add_argument("--execute", action="store_true", help="Actually perform renames (default: dry run)")
    args = ap.parse_args()

    actions = migrate(root=args.root, execute=args.execute)

    if not actions:
        print("Nothing to migrate.")
        return

    max_from = max(len(a["from"]) for a in actions)
    header = f"{'FROM':<{max_from}}  {'TO':<50}  STATUS"
    print(header)
    print("-" * len(header))
    for a in actions:
        print(f"{a['from']:<{max_from}}  {a['to']:<50}  {a['status']}")

    if not args.execute:
        print("\n[DRY RUN] Pass --execute to apply changes.")
    else:
        renamed = sum(1 for a in actions if a["status"] == "RENAMED")
        print(f"\nDone. {renamed} director{'y' if renamed == 1 else 'ies'} renamed.")


if __name__ == "__main__":
    main()
