from __future__ import annotations
import json
from pathlib import Path
from typing import Any, Dict, Iterable

import joblib

def save_model(model, out_dir: Path, metadata: Dict[str, Any]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, out_dir / "model.joblib")
    (out_dir / "metadata.json").write_text(json.dumps(metadata, indent=2))

def load_model(path: Path):
    return joblib.load(path)

def save_metrics_csv(rows: Iterable[Dict[str, Any]], out_path: Path) -> None:
    import pandas as pd
    out_path.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(list(rows)).to_csv(out_path, index=False)
