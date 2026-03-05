from __future__ import annotations

import os
from pathlib import Path


# Single switch for the whole backend:
#   "postgres" -> use DATABASE_URL + matches table
#   "csv"      -> use synthetic dashboard CSV as the source of truth
DATA_SOURCE_MODE = "csv"

# Default CSV used when DATA_SOURCE_MODE == "csv"
DEFAULT_SYNTHETIC_CSV_PATH = (
    Path(__file__).resolve().parents[1] / "exports" / "dashboard.csv"
)


def get_data_source_mode() -> str:
    mode = os.environ.get("DATA_SOURCE_MODE", DATA_SOURCE_MODE).strip().lower()
    return "csv" if mode == "csv" else "postgres"


def get_synthetic_csv_path() -> Path:
    p = os.environ.get("SYNTHETIC_TIMESERIES_CSV")
    return Path(p) if p else DEFAULT_SYNTHETIC_CSV_PATH
