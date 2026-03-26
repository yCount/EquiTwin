from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Any
import json
import numpy as np
import pandas as pd
import joblib

@dataclass(frozen=True)
class PredictorSpec:
    artifacts_root: str
    feature_name: str
    level: str  # 'st' or 'lt'
    subdir: str = "best"


def _align_columns(X: pd.DataFrame, model) -> pd.DataFrame:
    """
    Return a DataFrame that contains exactly the columns for sklearn pipeline

    Two problems are solved here:

    1. Missing columns
    2. Extra columns
    """
    try:
        ct = getattr(model, "named_steps", {}).get("pre")
        if ct is None:
            return X

        # Collect num_cols and cat_cols from named transformers only.
        num_cols: List[str] = []
        cat_cols: List[str] = []
        for name, _, cols in ct.transformers_:
            if name == "remainder":
                continue
            col_list = [c for c in cols if isinstance(c, str)]
            if name == "cat":
                cat_cols.extend(col_list)
            else:
                num_cols.extend(col_list)  # "num" or any other named transformer

        expected = num_cols + cat_cols
        if not expected:
            return X

        out = X.copy()

        # Add missing numeric columns as NaN (float64)
        for c in num_cols:
            if c not in out.columns:
                out[c] = np.nan

        # Add missing categorical columns as None (object dtype).
        for c in cat_cols:
            if c not in out.columns:
                out[c] = None

        return out[expected]

    except Exception:
        return X


def _expected_column_groups(model) -> tuple[list[str], list[str]]:
    try:
        ct = getattr(model, "named_steps", {}).get("pre")
        if ct is None:
            return [], []

        num_cols: List[str] = []
        cat_cols: List[str] = []
        for name, _, cols in ct.transformers_:
            if name == "remainder":
                continue
            col_list = [c for c in cols if isinstance(c, str)]
            if name == "cat":
                cat_cols.extend(col_list)
            else:
                num_cols.extend(col_list)
        return num_cols, cat_cols
    except Exception:
        return [], []


def _fill_values_by_column(model) -> tuple[dict[str, float], dict[str, Any]]:
    num_fill: dict[str, float] = {}
    cat_fill: dict[str, Any] = {}
    try:
        ct = getattr(model, "named_steps", {}).get("pre")
        if ct is None:
            return num_fill, cat_fill

        for name, trans, cols in ct.transformers_:
            if name == "remainder":
                continue
            col_list = [c for c in cols if isinstance(c, str)]
            if not col_list or not hasattr(trans, "named_steps"):
                continue
            imp = trans.named_steps.get("imp")
            stats = getattr(imp, "statistics_", None)
            if stats is None or len(stats) != len(col_list):
                continue
            if name == "cat":
                for col, stat in zip(col_list, stats):
                    cat_fill[col] = "" if stat is None else stat
            else:
                for col, stat in zip(col_list, stats):
                    try:
                        num_fill[col] = float(stat)
                    except (TypeError, ValueError):
                        num_fill[col] = 0.0
    except Exception:
        pass
    return num_fill, cat_fill


def _sanitize_inference_frame(X: pd.DataFrame, model) -> pd.DataFrame:
    out = _align_columns(X, model).copy()
    num_cols, cat_cols = _expected_column_groups(model)
    num_fill, cat_fill = _fill_values_by_column(model)

    for c in num_cols:
        if c not in out.columns:
            out[c] = num_fill.get(c, 0.0)
        out[c] = pd.to_numeric(out[c], errors="coerce").fillna(num_fill.get(c, 0.0))

    for c in cat_cols:
        if c not in out.columns:
            out[c] = cat_fill.get(c, "")
        out[c] = out[c].astype(object).where(pd.notna(out[c]), cat_fill.get(c, ""))

    return out


def _set_n_jobs_1(estimator) -> None:
    """
    Recursively set n_jobs=1 on any estimator that supports it.
    """
    try:
        if hasattr(estimator, "n_jobs"):
            estimator.n_jobs = 1
        # Pipeline
        if hasattr(estimator, "named_steps"):
            for step in estimator.named_steps.values():
                _set_n_jobs_1(step)
        # ColumnTransformer
        if hasattr(estimator, "transformers_"):
            for _, trans, _ in estimator.transformers_:
                if trans not in ("drop", "passthrough"):
                    _set_n_jobs_1(trans)
        # MultiOutputRegressor / VotingRegressor sub-estimators (fitted)
        if hasattr(estimator, "estimators_"):
            for sub in estimator.estimators_:
                _set_n_jobs_1(sub)
        # MultiOutputRegressor base estimator (unfitted clone copy)
        if hasattr(estimator, "estimator"):
            _set_n_jobs_1(estimator.estimator)
    except Exception:
        pass


def _patch_loaded_model(model) -> None:
    """
    Fix sklearn version-mismatch: models trained on sklearn ≥1.7 store
    """
    _set_n_jobs_1(model)
    try:
        ct = getattr(model, "named_steps", {}).get("pre")
        if ct is None:
            return
        for trans_name, trans, _ in ct.transformers_:
            if trans_name in ("remainder", "cat"):
                continue   # cat imputer keeps object statistics_ (string fill values)
            if not hasattr(trans, "named_steps"):
                continue
            for step in trans.named_steps.values():
                if hasattr(step, "statistics_") and hasattr(step.statistics_, "dtype"):
                    if step.statistics_.dtype == object:
                        try:
                            step.statistics_ = step.statistics_.astype(float)
                        except (ValueError, TypeError):
                            pass
    except Exception:
        pass


class HorizonModelBank:
    """Loads one model per horizon for a given feature and level."""
    def __init__(self, spec: PredictorSpec, horizons: List[int]):
        self.spec = spec
        self.horizons = [int(h) for h in horizons]
        self.models: Dict[int, Any] = {}
        self.meta: Dict[int, dict] = {}

        root = Path(spec.artifacts_root) / spec.feature_name / spec.subdir
        for h in self.horizons:
            d = root / f"{spec.level}_h{h}"
            m = joblib.load(d / "model.joblib")
            _patch_loaded_model(m)
            self.models[h] = m
            meta_path = d / "metadata.json"
            self.meta[h] = json.loads(meta_path.read_text()) if meta_path.exists() else {}

    def predict(self, X_t: pd.DataFrame) -> Dict[int, np.ndarray]:
        out: Dict[int, np.ndarray] = {}
        for h in self.horizons:
            model = self.models[h]
            X_in = _sanitize_inference_frame(X_t, model)
            out[h] = model.predict(X_in)
        return out

@dataclass(frozen=True)
class TwoLevelPredictor:
    feature_name: str
    st: HorizonModelBank
    lt: HorizonModelBank
