from __future__ import annotations
from dataclasses import dataclass
from typing import Optional, Sequence
import numpy as np
import pandas as pd

@dataclass(frozen=True)
class FeatureSpec:
    name: str
    target: str
    ts_col: str = "timestamp"
    group_col: Optional[str] = "sensor_id"
    # Raw columns to keep before feature engineering (None = keep all)
    base_cols: Optional[Sequence[str]] = None
    # For lags/rolling features
    lag_cols: Sequence[str] = ()
    lags: Sequence[int] = (1,2,3,6,12)
    roll_windows: Sequence[int] = ()
    roll_cols: Sequence[str] = ()
    # Columns to drop before modeling
    drop_cols: Sequence[str] = ("raw_payload",)

def add_time_features(df: pd.DataFrame, ts_col: str) -> pd.DataFrame:
    out = df.copy()
    ts = pd.to_datetime(out[ts_col], utc=True, errors="coerce")
    out["hour"] = ts.dt.hour
    out["dayofweek"] = ts.dt.dayofweek
    out["month"] = ts.dt.month
    out["is_weekend"] = (out["dayofweek"] >= 5).astype(int)
    out["hour_sin"] = np.sin(2*np.pi*out["hour"]/24.0)
    out["hour_cos"] = np.cos(2*np.pi*out["hour"]/24.0)
    out["dow_sin"] = np.sin(2*np.pi*out["dayofweek"]/7.0)
    out["dow_cos"] = np.cos(2*np.pi*out["dayofweek"]/7.0)
    return out

def add_lag_features(df: pd.DataFrame, ts_col: str, group_col: Optional[str], lag_cols: Sequence[str], lags: Sequence[int]) -> pd.DataFrame:
    out = df.sort_values(ts_col).copy()
    feats = {}
    if group_col and group_col in out.columns:
        g = out.groupby(group_col, sort=False)
        for col in lag_cols:
            if col not in out.columns: 
                continue
            s = g[col]
            for L in lags:
                feats[f"{col}_lag{L}"] = s.shift(L)
    else:
        for col in lag_cols:
            if col not in out.columns:
                continue
            s = out[col]
            for L in lags:
                feats[f"{col}_lag{L}"] = s.shift(L)
    if feats:
        out = pd.concat([out, pd.DataFrame(feats, index=out.index)], axis=1)
    return out

def add_rolling_features(df: pd.DataFrame, ts_col: str, group_col: Optional[str], roll_cols: Sequence[str], windows: Sequence[int]) -> pd.DataFrame:
    if not windows or not roll_cols:
        return df
    out = df.sort_values(ts_col).copy()
    feats = {}
    if group_col and group_col in out.columns:
        g = out.groupby(group_col, sort=False)
        for col in roll_cols:
            if col not in out.columns:
                continue
            for w in windows:
                feats[f"{col}_roll{w}_mean"] = g[col].rolling(w).mean().reset_index(level=0, drop=True)
                feats[f"{col}_roll{w}_std"]  = g[col].rolling(w).std().reset_index(level=0, drop=True)
    else:
        for col in roll_cols:
            if col not in out.columns:
                continue
            for w in windows:
                feats[f"{col}_roll{w}_mean"] = out[col].rolling(w).mean()
                feats[f"{col}_roll{w}_std"]  = out[col].rolling(w).std()
    if feats:
        out = pd.concat([out, pd.DataFrame(feats, index=out.index)], axis=1)
    return out

def build_features(raw: pd.DataFrame, spec: FeatureSpec) -> pd.DataFrame:
    df = raw.copy()
    # enforce minimal keep set for stability
    if spec.base_cols is not None:
        keep = set(spec.base_cols)
        keep.add(spec.ts_col)
        if spec.group_col:
            keep.add(spec.group_col)
        # ensure target is present for supervised shift
        keep.add(spec.target)
        cols = [c for c in keep if c in df.columns]
        df = df[cols].copy()

    df = df.dropna(subset=[spec.ts_col]).copy()
    df[spec.ts_col] = pd.to_datetime(df[spec.ts_col], utc=True, errors="coerce")
    df = df.dropna(subset=[spec.ts_col]).copy()

    df = add_time_features(df, spec.ts_col)
    df = add_lag_features(df, spec.ts_col, spec.group_col, spec.lag_cols, spec.lags)
    df = add_rolling_features(df, spec.ts_col, spec.group_col, spec.roll_cols, spec.roll_windows)
    return df


def build_features_longterm(
    raw: pd.DataFrame,
    spec: FeatureSpec,
    *,
    block_minutes: int = 240,
    agg: str = "mean",
    lt_lags: Sequence[int] = (1,2,3),
) -> pd.DataFrame:
    """
    Build features at a long-term cadence by aggregating the raw (typically 15m) data
    into fixed blocks (default: 4 hours = 240 minutes).

    Output schema matches `FeatureBuffer4h`:
    - aggregated base columns (same names)
    - lagged long-term columns: <col>_ltlag<L>
    - time features from the block end timestamp

    Notes:
    - Aggregation only applies to numeric columns present in `spec.lag_cols` plus the target.
    - For non-numeric cols, we keep the last observed value within the block if present.
    """
    df = raw.copy()
    if spec.base_cols is not None:
        keep = set(spec.base_cols)
        keep.add(spec.ts_col)
        if spec.group_col:
            keep.add(spec.group_col)
        keep.add(spec.target)
        cols = [c for c in keep if c in df.columns]
        df = df[cols].copy()

    df = df.dropna(subset=[spec.ts_col]).copy()
    df[spec.ts_col] = pd.to_datetime(df[spec.ts_col], utc=True, errors="coerce")
    df = df.dropna(subset=[spec.ts_col]).copy()

    group_col = spec.group_col if (spec.group_col and spec.group_col in df.columns) else None

    # choose columns to aggregate
    agg_cols = [c for c in set(list(spec.lag_cols) + [spec.target]) if c in df.columns]
    num_cols = [c for c in agg_cols if pd.api.types.is_numeric_dtype(df[c])]
    other_cols = [c for c in agg_cols if c not in num_cols]

    def _agg_block(gdf: pd.DataFrame) -> pd.DataFrame:
        gdf = gdf.sort_values(spec.ts_col).set_index(spec.ts_col)
        rule = f"{int(block_minutes)}min"
        # numeric aggregation
        if agg == "sum":
            num = gdf[num_cols].resample(rule).sum()
        elif agg == "last":
            num = gdf[num_cols].resample(rule).last()
        else:
            num = gdf[num_cols].resample(rule).mean()
        # non-numeric: last
        if other_cols:
            oth = gdf[other_cols].resample(rule).last()
            out = pd.concat([num, oth], axis=1)
        else:
            out = num
        out = out.reset_index()
        return out

    if group_col:
        parts = []
        for gid, gdf in df.groupby(group_col, sort=False):
            out = _agg_block(gdf)
            out[group_col] = gid
            parts.append(out)
        lt = pd.concat(parts, axis=0, ignore_index=True)
    else:
        lt = _agg_block(df)

    # time features on block end timestamp
    lt = add_time_features(lt, spec.ts_col)

    # lt lag features
    lt = lt.sort_values(spec.ts_col).copy()
    feats = {}
    if group_col and group_col in lt.columns:
        g = lt.groupby(group_col, sort=False)
        for col in [c for c in spec.lag_cols if c in lt.columns]:
            s = g[col]
            for L in lt_lags:
                feats[f"{col}_ltlag{L}"] = s.shift(L)
    else:
        for col in [c for c in spec.lag_cols if c in lt.columns]:
            s = lt[col]
            for L in lt_lags:
                feats[f"{col}_ltlag{L}"] = s.shift(L)
    if feats:
        lt = pd.concat([lt, pd.DataFrame(feats, index=lt.index)], axis=1)

    return lt
