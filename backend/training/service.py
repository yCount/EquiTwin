from __future__ import annotations
import json
import os
import warnings
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import pandas as pd

from core.data import DataSpec, load_table
from core.featurize import FeatureSpec, build_features, build_features_longterm
from core.persist import save_model, load_model, save_metrics_csv
from core.preprocess import preprocess_raw_table, resample_to_15min
from core.split import SplitSpec
from training.search import SearchSpec, evaluate_models, fit_best_model

# Weather enrichment helper

def _maybe_join_weather(raw: pd.DataFrame, ts_col: str) -> pd.DataFrame:
    """
    Join historical weather data into the raw training DataFrame.

    Reads WEATHER_LAT / WEATHER_LON from environment variables.
    If not set (or on any API failure), silently adds NaN columns so the
    downstream featurisation pipeline still sees the three weather columns.

    Called after preprocess_raw_table() in train_feature_best_models().
    """
    lat_str = os.environ.get("WEATHER_LAT")
    lon_str = os.environ.get("WEATHER_LON")

    def _add_nan_cols(df: pd.DataFrame) -> pd.DataFrame:
        out = df.copy()
        out["outdoor_temp"] = float("nan")
        out["weather_condition"] = float("nan")
        out["sunlight"] = float("nan")
        return out

    if not lat_str or not lon_str:
        return _add_nan_cols(raw)

    try:
        from core.weather_client import WeatherClient

        ts_series = pd.to_datetime(raw[ts_col], utc=True, errors="coerce").dropna()
        if ts_series.empty:
            return _add_nan_cols(raw)

        start_date = ts_series.min().strftime("%Y-%m-%d")
        end_date   = ts_series.max().strftime("%Y-%m-%d")

        client = WeatherClient(float(lat_str), float(lon_str))
        weather_df = client.get_historical_df(start_date, end_date)

        if weather_df.empty:
            warnings.warn(
                "[weather] Historical API returned no data. "
                "Proceeding with NaN weather columns.",
                UserWarning, stacklevel=3,
            )
            return _add_nan_cols(raw)

        return WeatherClient.join_weather_to_df(raw, weather_df, ts_col=ts_col)

    except Exception as exc:
        warnings.warn(
            f"[weather] Could not join weather data: {exc}. "
            "Proceeding with NaN weather columns.",
            UserWarning, stacklevel=3,
        )
        return _add_nan_cols(raw)


# Minimum number of rows required before attempting to train at each level.
# ST: raw 15-min rows.  LT: 4-hour aggregated blocks.
# If the data falls below these thresholds, training is skipped with a warning
# rather than crashing.  The threshold for LT is low because AQ/OC sensors
# often fire every 10-12 seconds, giving very few 4-hour blocks from 50k rows.
_ST_MIN_ROWS = 50
_LT_MIN_ROWS = 10     # 10 blocks × 4h = 40h of history — absolute minimum


def featurize_for_feature(feature: FeatureSpec, raw: pd.DataFrame) -> pd.DataFrame:
    df = build_features(raw, feature)
    if feature.target in df.columns:
        df = df.dropna(subset=[feature.target]).copy()
    return df


def featurize_for_feature_longterm(
    feature: FeatureSpec,
    raw: pd.DataFrame,
    *,
    block_minutes: int = 240,
    agg: str = "mean",
    lt_lags: Sequence[int] = (1, 2, 3),
) -> pd.DataFrame:
    df = build_features_longterm(raw, feature, block_minutes=block_minutes, agg=agg, lt_lags=lt_lags)
    if feature.target in df.columns:
        df = df.dropna(subset=[feature.target]).copy()
    return df


def _make_split(level: str, n_rows: int) -> SplitSpec:
    """
    Return a SplitSpec appropriate for the data size and level.

    For LT data, the dataset can be very small (high-frequency sensors produce
    few 4-hour blocks).  min_train is scaled down so we can still fit at least
    one fold without crashing.
    """
    if level == "lt":
        # Scale min_train to at most 60% of available rows, capped at 50
        min_train = max(5, min(50, int(n_rows * 0.6)))
        return SplitSpec(ts_col="timestamp", n_folds=2, test_size=0.25, min_train=min_train)
    else:
        return SplitSpec(ts_col="timestamp", n_folds=3, test_size=0.2, min_train=200)


def train_feature_best_models(
    feature: FeatureSpec,
    db_url: str,
    table: str,
    *,
    level: str = "st",
    where_sql: Optional[str] = None,
    limit_rows: Optional[int] = None,
    horizons: Sequence[int] = (1,),
    out_root: str = "artifacts",
    split: Optional[SplitSpec] = None,
    models: Sequence[str] = ("linear","ridge","elastic","hgb","rf","ann","gp","voting"),
    gp_max_rows: int = 800,
    lt_block_minutes: int = 240,
    lt_agg: str = "mean",
    lt_lags: Sequence[int] = (1, 2, 3),
) -> Dict[str, Any]:
    """
    Train and select the best model for each horizon for one feature and one level.

    - level="st": raw 15-min rows + standard lag features
    - level="lt": 4-hour aggregated rows + long-term lag features

    Saved under: artifacts/<feature>/best/<level>_h<horizon>/model.joblib

    If there is insufficient data for a horizon, that horizon is skipped with
    a warning instead of crashing.
    """
    raw = load_table(DataSpec(
        db_url=db_url, table=table, ts_col=feature.ts_col,
        where_sql=where_sql, limit_rows=limit_rows, order="ASC"
    ))

    # --- Preprocessing
    # Handles: string-numeric coercion (e.g. num_targets stored as VARCHAR),
    # occupancy num_targets derivation from entries/exits, sensor-ID fill,
    # and cross-sensor forward-fill so every row has the latest AQ / energy /
    # occupancy readings regardless of sensor type.
    raw = preprocess_raw_table(
        raw,
        feature_name=feature.name,
        ts_col=feature.ts_col,
        group_col=feature.group_col or "sensor_id",
    )

    # Downsample to 15-minute cadence
    raw = resample_to_15min(
        raw,
        ts_col=feature.ts_col,
        group_col=feature.group_col or "sensor_id",
    )

    # --- Weather enrichment (runs when WEATHER_LAT/LON are set)
    raw = _maybe_join_weather(raw, ts_col=feature.ts_col)
    # - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    if level == "lt":
        df = featurize_for_feature_longterm(
            feature, raw,
            block_minutes=lt_block_minutes, agg=lt_agg, lt_lags=lt_lags,
        )
        min_rows = _LT_MIN_ROWS
    else:
        df = featurize_for_feature(feature, raw)
        min_rows = _ST_MIN_ROWS

    if len(df) < min_rows:
        warnings.warn(
            f"[{feature.name}/{level}] Only {len(df)} rows after featurization "
            f"(need {min_rows}). Skipping {level.upper()} training for this feature. "
            f"Load more data (increase --limit or add more historical rows).",
            UserWarning, stacklevel=3,
        )
        return {"feature": feature.name, "target": feature.target, "level": level,
                "skipped": True, "reason": f"too_few_rows ({len(df)} < {min_rows})", "best": {}}

    # Use caller-supplied split or auto-size it to the available data
    effective_split = split or _make_split(level, len(df))

    ss = SearchSpec(
        feature_name=feature.name,
        target=feature.target,
        ts_col=feature.ts_col,
        drop_cols=tuple(feature.drop_cols),
        group_col=feature.group_col or "sensor_id",
        horizons=tuple(horizons),
        split=effective_split,
        include_models=tuple(models),
        gp_max_rows=gp_max_rows,
    )

    out_root_p = Path(out_root) / feature.name
    all_rows: List[Dict[str, Any]] = []
    best_summary: Dict[str, Any] = {
        "feature": feature.name, "target": feature.target,
        "level": level, "n_rows": len(df), "best": {},
    }

    for h in horizons:
        rows = evaluate_models(df, ss, horizon=int(h))

        if not rows:
            # Not enough data to train any model at this horizon
            warnings.warn(
                f"[{feature.name}/{level}/h{h}] No models trained (insufficient data "
                f"for cross-validation after horizon shift). "
                f"Available LT blocks: {len(df)}. Skipping h{h}.",
                UserWarning, stacklevel=2,
            )
            continue

        all_rows.extend([{**r, "level": level} for r in rows])

        best_row = sorted(rows, key=lambda r: r["rmse"])[0]
        best_summary["best"][str(h)] = {**best_row, "level": level}

        model, extra = fit_best_model(df, ss, horizon=int(h), best_model_name=best_row["model"])
        meta = {
            **best_row,
            "level": level,
            "target": feature.target,
            "ts_col": feature.ts_col,
            "group_col": feature.group_col,
            "lags": list(feature.lags),
            "lag_cols": list(feature.lag_cols),
            "base_cols": list(feature.base_cols) if feature.base_cols is not None else None,
            "drop_cols": list(feature.drop_cols),
            "where_sql": where_sql,
            "limit_rows": limit_rows,
            "lt_block_minutes": lt_block_minutes if level == "lt" else None,
            "lt_agg": lt_agg if level == "lt" else None,
            "lt_lags": list(lt_lags) if level == "lt" else None,
            **extra,
        }
        save_model(model, out_root_p / "best" / f"{level}_h{int(h)}", meta)

    if all_rows:
        save_metrics_csv(all_rows, out_root_p / f"metrics_{level}.csv")
    (out_root_p / f"best_summary_{level}.json").write_text(
        json.dumps(best_summary, indent=2)
    )
    return best_summary


def train_feature_best_models_two_level(
    feature: FeatureSpec,
    db_url: str,
    table: str,
    *,
    where_sql: Optional[str] = None,
    limit_rows: Optional[int] = None,
    out_root: str = "artifacts",
    st_horizons: Optional[Sequence[int]] = None,
    lt_horizons: Optional[Sequence[int]] = None,
    models: Optional[Sequence[str]] = None,
    gp_max_rows: int = 800,
    lt_agg: str = "mean",
    lt_lags: Sequence[int] = (1, 2, 3),
) -> Dict[str, Any]:
    """Convenience wrapper: train ST (15m) and LT (4h) banks for a feature."""
    from equitwin_forecasting.timebase import default_horizons
    hz = default_horizons()
    st_h = tuple(st_horizons) if st_horizons is not None else tuple(hz.st_horizons)
    lt_h = tuple(lt_horizons) if lt_horizons is not None else tuple(hz.lt_horizons)
    mdl = tuple(models) if models is not None else (
        "linear", "ridge", "elastic", "hgb", "rf", "ann", "gp", "voting"
    )

    st = train_feature_best_models(
        feature, db_url, table,
        level="st", where_sql=where_sql, limit_rows=limit_rows,
        horizons=st_h, out_root=out_root, models=mdl, gp_max_rows=gp_max_rows,
    )
    lt = train_feature_best_models(
        feature, db_url, table,
        level="lt", where_sql=where_sql, limit_rows=limit_rows,
        horizons=lt_h, out_root=out_root, models=mdl, gp_max_rows=gp_max_rows,
        lt_block_minutes=240, lt_agg=lt_agg, lt_lags=lt_lags,
    )
    return {"feature": feature.name, "st": st, "lt": lt}


def load_best_model(artifacts_root: str, feature_name: str, level: str, horizon: int):
    p = Path(artifacts_root) / feature_name / "best" / f"{level}_h{int(horizon)}"
    model = load_model(p / "model.joblib")
    meta = json.loads((p / "metadata.json").read_text())
    return model, meta
