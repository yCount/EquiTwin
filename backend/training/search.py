from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Dict, List, Sequence

import numpy as np
import pandas as pd
from sklearn.pipeline import Pipeline

from core.metrics import regression_metrics
from core.model_zoo import PreprocessSpec, make_preprocessor, regression_candidates, make_voting_ensemble
from core.split import SplitSpec, rolling_splits


@dataclass(frozen=True)
class SearchSpec:
    feature_name: str
    target: str
    ts_col: str
    drop_cols: Sequence[str]
    group_col: str = "sensor_id"   # explicitly dropped from X so it cannot leak as a feature
    horizons: Sequence[int] = (1,)
    split: SplitSpec = SplitSpec()
    include_models: Sequence[str] = ("linear","ridge","lasso","elastic","rf","hgb","ann","gp","voting")
    gp_max_rows: int = 800


def _drop_all_missing_columns(X: pd.DataFrame) -> pd.DataFrame:
    keep = [c for c in X.columns if X[c].notna().any()]
    return X[keep].copy()


def _prepare_xy(df: pd.DataFrame, target: str, ts_col: str, drop_cols: Sequence[str],
                horizon: int, group_col: str = "sensor_id"):
    """
    Build (d, X, y) for supervised learning.

    BUG FIX 1 — y/index misalignment:
        The old code returned d BEFORE dropna(subset=["_y"]), so d had N rows
        while y_all had N-h rows.  Every np.isin(d.index, tr_idx) produced a
        boolean mask of length N applied to y_all of length N-h → crash or
        silently wrong y values.  Now d is returned AFTER dropna, keeping d,
        X, and y all co-aligned at length N-h.

    BUG FIX 2 — sensor_id leaking into features:
        group_col (sensor_id) was not in drop_cols, so it survived into X as
        a categorical column.  It is now always removed before training.
    """
    d = df.sort_values(ts_col).copy()
    d["_y"] = d[target].shift(-horizon)
    d = d.dropna(subset=["_y"]).copy()           # d is now N-h rows

    extra_drop = {ts_col, target, "_y"}
    if group_col and group_col in d.columns:
        extra_drop.add(group_col)
    all_drop = set(list(drop_cols)) | extra_drop

    X = d.drop(columns=[c for c in all_drop if c in d.columns], errors="ignore")
    y = d["_y"].to_numpy()                       # length == len(d) always
    X = _drop_all_missing_columns(X)
    return d, X, y


def _y_for_index(y_all: np.ndarray, d: pd.DataFrame, idx: pd.Index) -> np.ndarray:
    """
    Extract y values for the rows identified by `idx` (a subset of d.index).

    Uses positional lookup so it is safe regardless of index dtype or gaps.
    """
    pos = d.index.get_indexer(idx)
    valid = pos[pos >= 0]
    return y_all[valid]


def _fit_predict(pipe: Pipeline, X_tr: pd.DataFrame, y_tr: np.ndarray,
                 X_te: pd.DataFrame, name: str, gp_max_rows: int):
    if name == "gp" and len(X_tr) > gp_max_rows:
        sel = np.linspace(0, len(X_tr) - 1, gp_max_rows).astype(int)
        pipe.fit(X_tr.iloc[sel], y_tr[sel])
    else:
        pipe.fit(X_tr, y_tr)
    return pipe.predict(X_te)


def evaluate_models(df: pd.DataFrame, spec: SearchSpec, horizon: int) -> List[Dict[str, Any]]:
    d, X_all, y_all = _prepare_xy(
        df, spec.target, spec.ts_col, spec.drop_cols,
        horizon=horizon, group_col=spec.group_col,
    )
    splits = rolling_splits(d, spec.split)       # uses post-dropna d

    cand = regression_candidates()
    rows: List[Dict[str, Any]] = []

    # Determine column types once
    cat_cols = X_all.select_dtypes(include=["object", "bool", "str"]).columns.tolist()
    num_cols = [c for c in X_all.columns if c not in cat_cols]

    for name in spec.include_models:
        if name == "voting":
            continue
        if name not in cand:
            continue

        pre = make_preprocessor(cat_cols, num_cols, PreprocessSpec(scale_numeric=(name == "ann")))
        pipe = Pipeline([("pre", pre), ("model", cand[name])])

        fold_ms = []
        for tr_idx, te_idx in splits:
            X_tr = X_all.loc[tr_idx]
            X_te = X_all.loc[te_idx]
            y_tr = _y_for_index(y_all, d, tr_idx)
            y_te = _y_for_index(y_all, d, te_idx)

            if len(X_tr) == 0 or len(y_tr) == 0:
                continue                        # skip degenerate folds safely

            pred = _fit_predict(pipe, X_tr, y_tr, X_te, name=name, gp_max_rows=spec.gp_max_rows)
            fold_ms.append(regression_metrics(y_te, pred))

        if not fold_ms:
            continue    # no valid folds — skip this model

        rows.append({
            "feature": spec.feature_name,
            "horizon": int(horizon),
            "model": name,
            "mae": float(np.mean([m.mae for m in fold_ms])),
            "rmse": float(np.mean([m.rmse for m in fold_ms])),
            "r2": float(np.mean([m.r2 for m in fold_ms])),
            "n_rows": int(len(d)),
            "n_features": int(X_all.shape[1]),
            "n_folds": int(len(fold_ms)),
        })

    if "voting" in spec.include_models:
        base_names = [n for n in ("ridge", "hgb", "rf") if n in cand]
        pre = make_preprocessor(cat_cols, num_cols, PreprocessSpec(scale_numeric=False))

        fold_ms = []
        for tr_idx, te_idx in splits:
            X_tr = X_all.loc[tr_idx]
            X_te = X_all.loc[te_idx]
            y_tr = _y_for_index(y_all, d, tr_idx)
            y_te = _y_for_index(y_all, d, te_idx)

            if len(X_tr) == 0 or len(y_tr) == 0:
                continue

            estimators = []
            for bn in base_names:
                p = Pipeline([("pre", pre), ("model", cand[bn])])
                p.fit(X_tr, y_tr)
                estimators.append((bn, p))
            ens = make_voting_ensemble(estimators)
            ens.fit(X_tr, y_tr)
            pred = ens.predict(X_te)
            fold_ms.append(regression_metrics(y_te, pred))

        if fold_ms:
            rows.append({
                "feature": spec.feature_name,
                "horizon": int(horizon),
                "model": "voting",
                "mae": float(np.mean([m.mae for m in fold_ms])),
                "rmse": float(np.mean([m.rmse for m in fold_ms])),
                "r2": float(np.mean([m.r2 for m in fold_ms])),
                "n_rows": int(len(d)),
                "n_features": int(X_all.shape[1]),
                "n_folds": int(len(fold_ms)),
            })

    return rows


def fit_best_model(df: pd.DataFrame, spec: SearchSpec, horizon: int, best_model_name: str):
    d, X_all, y_all = _prepare_xy(
        df, spec.target, spec.ts_col, spec.drop_cols,
        horizon=horizon, group_col=spec.group_col,
    )
    splits = rolling_splits(d, spec.split)
    tr_idx, _ = splits[-1]
    X_tr = X_all.loc[tr_idx]
    y_tr = _y_for_index(y_all, d, tr_idx)

    cand = regression_candidates()
    cat_cols = X_all.select_dtypes(include=["object", "bool", "str"]).columns.tolist()
    num_cols = [c for c in X_all.columns if c not in cat_cols]
    pre = make_preprocessor(cat_cols, num_cols, PreprocessSpec(scale_numeric=(best_model_name == "ann")))

    if best_model_name == "voting":
        base_names = [n for n in ("ridge", "hgb", "rf") if n in cand]
        estimators = []
        for bn in base_names:
            p = Pipeline([("pre", pre), ("model", cand[bn])])
            p.fit(X_tr, y_tr)
            estimators.append((bn, p))
        model = make_voting_ensemble(estimators)
        model.fit(X_tr, y_tr)
        return model, {"ensemble": base_names}
    else:
        pipe = Pipeline([("pre", pre), ("model", cand[best_model_name])])
        if best_model_name == "gp" and len(X_tr) > spec.gp_max_rows:
            sel = np.linspace(0, len(X_tr) - 1, spec.gp_max_rows).astype(int)
            pipe.fit(X_tr.iloc[sel], y_tr[sel])
        else:
            pipe.fit(X_tr, y_tr)
        return pipe, {}