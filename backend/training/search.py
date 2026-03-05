from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Dict, List, Sequence, Tuple

import numpy as np
import pandas as pd
from sklearn.pipeline import Pipeline

from core.metrics import regression_metrics
from core.model_zoo import (
    PreprocessSpec, make_preprocessor,
    regression_candidates, make_voting_ensemble,
    quantile_candidates, make_multioutput_model,
)
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
    """
    d = df.sort_values(ts_col).copy()
    d["_y"] = d[target].shift(-horizon)
    d = d.dropna(subset=["_y"]).copy() # d is now N-h rows

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

def _naive_baseline(d: pd.DataFrame, target: str, te_idx: pd.Index) -> np.ndarray:
    """
    Lag-1 naive forecast for a test fold: repeat the last training value.

    For each test row, the naive prediction is the target value one
    step before that row.  Positions with no predecessor (first row in d)
    get NaN, which regression_metrics() handles via nanmean.
    MASE < 1 means the model beats this baseline.
    """
    te_pos = d.index.get_indexer(te_idx)
    naive = np.full(len(te_idx), float("nan"))
    can_lag = te_pos > 0                        # positions that have a predecessor
    if can_lag.any():
        naive[can_lag] = d[target].iloc[te_pos[can_lag] - 1].values
    return naive


def evaluate_models(df: pd.DataFrame, spec: SearchSpec, horizon: int) -> List[Dict[str, Any]]:
    d, X_all, y_all = _prepare_xy(
        df, spec.target, spec.ts_col, spec.drop_cols,
        horizon=horizon, group_col=spec.group_col,
    )
    splits = rolling_splits(d, spec.split)       # uses post-dropna d

    cand = regression_candidates()
    rows: List[Dict[str, Any]] = []

    cat_cols = X_all.select_dtypes(include=["object", "bool", "str"]).columns.tolist()
    num_cols = [c for c in X_all.columns if c not in cat_cols]

    for name in spec.include_models:
        if name == "voting":
            continue
        if name not in cand:
            continue

        print(f"[model] {name} h{horizon}", flush=True)
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
            y_naive = _naive_baseline(d, spec.target, te_idx)
            fold_ms.append(regression_metrics(y_te, pred, y_naive=y_naive))

        if not fold_ms:
            continue

        rows.append({
            "feature": spec.feature_name,
            "horizon": int(horizon),
            "model": name,
            "mae":  float(np.mean([m.mae  for m in fold_ms])),
            "rmse": float(np.mean([m.rmse for m in fold_ms])),
            "r2":   float(np.mean([m.r2   for m in fold_ms])),
            "mase": float(np.nanmean([m.mase for m in fold_ms])),
            "n_rows": int(len(d)),
            "n_features": int(X_all.shape[1]),
            "n_folds": int(len(fold_ms)),
        })

    if "voting" in spec.include_models:
        print(f"[model] voting h{horizon}", flush=True)
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
            y_naive = _naive_baseline(d, spec.target, te_idx)
            fold_ms.append(regression_metrics(y_te, pred, y_naive=y_naive))

        if fold_ms:
            rows.append({
                "feature": spec.feature_name,
                "horizon": int(horizon),
                "model": "voting",
                "mae":  float(np.mean([m.mae  for m in fold_ms])),
                "rmse": float(np.mean([m.rmse for m in fold_ms])),
                "r2":   float(np.mean([m.r2   for m in fold_ms])),
                "mase": float(np.nanmean([m.mase for m in fold_ms])),
                "n_rows": int(len(d)),
                "n_features": int(X_all.shape[1]),
                "n_folds": int(len(fold_ms)),
            })

    return rows


def evaluate_quantile_models(
    df: pd.DataFrame,
    spec: SearchSpec,
    horizon: int,
    quantiles: Sequence[float] = (0.1, 0.5, 0.9),
) -> Dict[str, Any]:
    """
    Train quantile regressors and return prediction-interval metrics.

    Returns a dict with:
        coverage  - fraction of test points inside [q_lo, q_hi] (target: ~0.80)
        sharpness - mean width of the interval (smaller = more confident)
        q_models  - dict of {tag: fitted_pipeline} for the last CV fold
        rows      - per-quantile metric rows for metrics CSV

    The q50 model is a useful point-forecast alternative to MAE minimisation.
    """
    d, X_all, y_all = _prepare_xy(
        df, spec.target, spec.ts_col, spec.drop_cols,
        horizon=horizon, group_col=spec.group_col,
    )
    splits = rolling_splits(d, spec.split)
    if not splits:
        return {}

    cat_cols = X_all.select_dtypes(include=["object", "bool", "str"]).columns.tolist()
    num_cols = [c for c in X_all.columns if c not in cat_cols]

    qcand = quantile_candidates(quantiles)
    # Each pipeline gets its own preprocessor — ColumnTransformer mutates on fit()
    q_pipes: Dict[str, Pipeline] = {
        tag: Pipeline([
            ("pre", make_preprocessor(cat_cols, num_cols, PreprocessSpec(scale_numeric=False))),
            ("model", est),
        ])
        for tag, est in qcand.items()
    }

    # Use only the last CV fold for interval metrics (avoids refitting all)
    tr_idx, te_idx = splits[-1]
    X_tr = X_all.loc[tr_idx]
    X_te = X_all.loc[te_idx]
    y_tr = _y_for_index(y_all, d, tr_idx)
    y_te = _y_for_index(y_all, d, te_idx)

    if len(X_tr) == 0:
        return {}

    preds: Dict[str, np.ndarray] = {}
    rows: List[Dict[str, Any]] = []
    for tag, pipe in q_pipes.items():
        pipe.fit(X_tr, y_tr)
        pred = pipe.predict(X_te)
        preds[tag] = pred
        mae = float(np.mean(np.abs(y_te - pred)))
        rows.append({
            "feature": spec.feature_name,
            "horizon": int(horizon),
            "model": f"quantile_{tag}",
            "mae": mae,
            "rmse": float("nan"),
            "r2": float("nan"),
            "mase": float("nan"),
            "n_rows": int(len(d)),
            "n_features": int(X_all.shape[1]),
            "n_folds": 1,
        })

    # Coverage and sharpness use q10/q90 (or lgbm variants if available)
    lo_key = next((k for k in ("lgbm_q10", "q10") if k in preds), None)
    hi_key = next((k for k in ("lgbm_q90", "q90") if k in preds), None)

    coverage = float("nan")
    sharpness = float("nan")
    if lo_key and hi_key:
        lo, hi = preds[lo_key], preds[hi_key]
        inside = (y_te >= lo) & (y_te <= hi)
        coverage  = float(np.mean(inside))
        sharpness = float(np.mean(hi - lo))

    return {
        "coverage":  coverage,
        "sharpness": sharpness,
        "q_pipes":   q_pipes,
        "rows":      rows,
    }


def evaluate_multioutput(
    df: pd.DataFrame,
    spec: SearchSpec,
    horizons: Sequence[int],
    base_model_name: str = "hgb",
) -> Tuple[Any, Dict[str, Any]]:
    """
    Train a single MultiOutputRegressor to predict all horizons jointly.

    This is more efficient than the per-horizon loop (one fit vs N fits)
    and allows the model to share learned representations across horizons.

    Returns
    -------
    (fitted_multioutput_pipeline, summary_dict)
        summary_dict contains per-horizon MAE/RMSE/MASE averaged over folds.
    """
    d = df.sort_values(spec.ts_col).copy()

    # Build Y matrix: one column per horizon
    Y_cols: Dict[int, np.ndarray] = {}
    for h in horizons:
        d_h = d.copy()
        d_h["_y"] = d_h[spec.target].shift(-h)
        Y_cols[h] = d_h["_y"].values

    # Keep only rows where ALL horizons have a valid target
    valid_mask = np.all(
        np.column_stack([np.isfinite(v) for v in Y_cols.values()]),
        axis=1,
    )
    d_valid = d.loc[valid_mask].copy()
    Y_valid = np.column_stack([Y_cols[h][valid_mask] for h in horizons])

    extra_drop = {spec.ts_col, spec.target}
    if spec.group_col and spec.group_col in d_valid.columns:
        extra_drop.add(spec.group_col)
    drop_all = set(list(spec.drop_cols)) | extra_drop
    X_all = d_valid.drop(columns=[c for c in drop_all if c in d_valid.columns], errors="ignore")
    X_all = _drop_all_missing_columns(X_all)

    cat_cols = X_all.select_dtypes(include=["object", "bool", "str"]).columns.tolist()
    num_cols = [c for c in X_all.columns if c not in cat_cols]
    pre = make_preprocessor(cat_cols, num_cols, PreprocessSpec(scale_numeric=False))

    cand = regression_candidates()
    if base_model_name not in cand:
        base_model_name = "hgb"
    base = cand[base_model_name]
    mo_model = make_multioutput_model(base)
    pipe = Pipeline([("pre", pre), ("model", mo_model)])

    splits = rolling_splits(d_valid, spec.split)
    if not splits:
        return pipe, {}

    per_horizon_metrics: Dict[int, List[float]] = {h: [] for h in horizons}

    for tr_idx, te_idx in splits:
        X_tr = X_all.loc[tr_idx]
        y_tr_all = Y_valid[d_valid.index.get_indexer(tr_idx)]
        X_te = X_all.loc[te_idx]
        y_te_all = Y_valid[d_valid.index.get_indexer(te_idx)]

        if len(X_tr) == 0:
            continue

        pipe.fit(X_tr, y_tr_all)
        preds_all = pipe.predict(X_te)   # shape: (n_test, n_horizons)

        for i, h in enumerate(horizons):
            y_te = y_te_all[:, i]
            pred = preds_all[:, i]
            mae = float(np.mean(np.abs(y_te - pred)))
            per_horizon_metrics[h].append(mae)

    # Refit on the last fold's training data for the returned production model
    tr_idx, _ = splits[-1]
    X_tr = X_all.loc[tr_idx]
    y_tr_all = Y_valid[d_valid.index.get_indexer(tr_idx)]
    if len(X_tr) > 0:
        pipe.fit(X_tr, y_tr_all)

    summary = {
        str(h): {"mae": float(np.mean(maes)) if maes else float("nan")}
        for h, maes in per_horizon_metrics.items()
    }
    return pipe, summary


def fit_multioutput_model(
    df: pd.DataFrame,
    spec: SearchSpec,
    horizons: Sequence[int],
    base_model_name: str = "hgb",
) -> Tuple[Any, Dict[str, Any]]:
    """
    Convenience wrapper: fit MultiOutputRegressor on all available data.
    """
    pipe, summary = evaluate_multioutput(df, spec, horizons, base_model_name)
    return pipe, {"base_model": base_model_name, "horizons": list(horizons), **summary}


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
