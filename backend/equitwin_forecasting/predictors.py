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


def _align_columns(X: pd.DataFrame, model) -> pd.DataFrame:
    """
    Return a DataFrame that contains exactly the columns the sklearn pipeline
    was trained on — no more, no less.

    Two problems are solved here:

    1. Missing columns  (absent from X, expected by the model):
       Added with a dtype-appropriate fill value so the pipeline's SimpleImputer
       can handle them without a dtype mismatch:
         - Numeric columns  → np.nan  (float64 — compatible with constant-0 imputer)
         - Categorical columns → None (object dtype — compatible with most_frequent imputer)

       Root cause this guards against: columns in `drop_cols` (e.g. 'quality',
       'version') were included during training but are absent at inference time.

    2. Extra columns  (present in X, unknown to the model):
       Dropped before passing to the pipeline.  sklearn ≥1.6 raises ValueError
       in ColumnTransformer.transform() when the input DataFrame has feature names
       not seen during fit.  Extra weather columns added to the inference row for
       newer models would otherwise break older trained models.
    """
    try:
        ct = getattr(model, "named_steps", {}).get("pre")
        if ct is None:
            return X

        # Collect num_cols and cat_cols from named transformers only.
        # The "remainder" transformer stores integer column indices — skip it.
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
        # np.nan would create a float64 column, which the string-fitted
        # SimpleImputer(strategy="most_frequent") cannot accept.
        for c in cat_cols:
            if c not in out.columns:
                out[c] = None

        # Return ONLY the expected columns, dropping any extras that would cause
        # sklearn ≥1.6 feature-name validation to raise ValueError.
        return out[expected]

    except Exception:
        return X


def _patch_loaded_model(model) -> None:
    """
    Fix sklearn version-mismatch: models trained on sklearn ≥1.7 store
    SimpleImputer.statistics_ as dtype('O').  sklearn 1.6.x _validate_input
    requires statistics_ dtype to match the input data dtype, so numeric
    imputers (transformer name != 'cat') need their statistics_ cast to float64.
    """
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

        root = Path(spec.artifacts_root) / spec.feature_name / "best"
        for h in self.horizons:
            d = root / f"{spec.level}_h{h}"
            m = joblib.load(d / "model.joblib")
            _patch_loaded_model(m)
            self.models[h] = m
            meta_path = d / "metadata.json"
            self.meta[h] = json.loads(meta_path.read_text()) if meta_path.exists() else {}

    def predict(self, X_t: pd.DataFrame) -> Dict[int, np.ndarray]:
        return {h: self.models[h].predict(_align_columns(X_t, self.models[h])) for h in self.horizons}

@dataclass(frozen=True)
class TwoLevelPredictor:
    feature_name: str
    st: HorizonModelBank
    lt: HorizonModelBank
