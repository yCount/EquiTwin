"""
Sensor types:

  sensor_type_id=2  - occupancy  (NO_MOVEMENT, EXIT_DETECTED, …)
  sensor_type_id=3  - energy meter circuit-0  (NORMAL_EM)
  sensor_type_id=4  - energy meter circuit-1  (NORMAL_EM)
  sensor_type_id=5  - air-quality  (NORMAL_AQ)

Steps applied by 'preprocess_raw_table()'
---
1. Numeric coercion   -=object-dtype columns that should be numeric are cast
                         with pd.to_numeric(errors='coerce').
2. Sensor-ID fill     = NULL sensor_id on occupancy rows is borrowed from
                        device_id / mac_address / sub_id (whichever exists).
3. Occupancy fix      = num_targets is derived when it is all-NULL:
                        first tries VARCHAR-coerce ("18" → 18.0), then falls
                        back to cumsum(entries) - cumsum(exits), clamped ≥ 0.
4. Cross-sensor ffill = After sorting by timestamp, selected AQ / energy /
                        occupancy columns are forward-filled so that every row
                        has the most-recent reading of every sensor type.
                        This is safe (no future leakage) because only forward
                        propagation is used.
5. Aggregate Data     = 15m blocks
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from typing import List, Optional


# CONSTANTS

_OCCUPANCY_EVENTS: frozenset = frozenset({
    "NO_MOVEMENT",
    "EXIT_DETECTED",
    "ENTRY_DETECTED",
    "MOVEMENT_DETECTED",
    "Increase HVAC",
    "Decrease HVAC",
})

_ENERGY_EVENTS: frozenset = frozenset({"NORMAL_EM"})
_AQ_EVENTS:     frozenset = frozenset({"NORMAL_AQ"})

_NUMERIC_COLS: List[str] = [
    # Energy meter
    "total_act_power", "total_current", "total_aprt_power",
    "a_act_power",     "b_act_power",   "c_act_power",
    "a_current",       "b_current",     "c_current",
    "a_voltage",       "b_voltage",     "c_voltage",
    "a_aprt_power",    "b_aprt_power",  "c_aprt_power",
    "a_pf",            "b_pf",          "c_pf",
    "a_freq",          "b_freq",        "c_freq",
    # Air quality
    "co2", "temp", "humidity", "voc",
    "pm1", "pm2p5", "pm4", "pm10",
    # Occupancy
    "num_targets", "entries", "exits",
    # Misc
    "quality_score", "battery_v",
]

# Columns forward-filled during cross-sensor enrichment.
_FFILL_COLS: List[str] = [
    "co2", "temp", "humidity", "voc", "pm1", "pm2p5", "pm4", "pm10",
    "total_act_power", "total_current", "total_aprt_power",
    "a_act_power", "b_act_power", "c_act_power",
    "a_voltage", "b_voltage", "c_voltage",
    "num_targets", "entries", "exits",
]

def coerce_numeric(
    df: pd.DataFrame,
    cols: Optional[List[str]] = None,
) -> pd.DataFrame:
    out = df.copy()
    targets = cols if cols is not None else _NUMERIC_COLS
    for c in targets:
        if c in out.columns and out[c].dtype == object:
            out[c] = pd.to_numeric(out[c], errors="coerce")
    return out

def fill_sensor_id(df: pd.DataFrame) -> pd.DataFrame:
    """
    Fill NULL "sensor_id" values from alternative device-identifier columns.
    """
    if "sensor_id" not in df.columns:
        return df

    out = df.copy()

    # Candidates in preference order
    for alt in ("sub_id", "device_id", "mac_address", "mac", "device_mac"):
        if alt not in out.columns:
            continue
        mask = out["sensor_id"].isna()
        if not mask.any():
            break
        out.loc[mask, "sensor_id"] = out.loc[mask, alt]

    # Last-resort fill so groupby never sees NaN keys
    mask = out["sensor_id"].isna()
    if mask.any():
        # Try to tag by event type so distinct sensor classes get distinct ids
        if "event_type" in out.columns:
            for evset, tag in [
                (_OCCUPANCY_EVENTS, "occ_default"),
                (_ENERGY_EVENTS,    "em_default"),
                (_AQ_EVENTS,        "aq_default"),
            ]:
                submask = mask & out["event_type"].isin(evset)
                out.loc[submask, "sensor_id"] = tag
        # Anything still NULL
        out["sensor_id"] = out["sensor_id"].fillna("unknown")

    return out


def compute_occupancy_num_targets(
    df: pd.DataFrame,
    *,
    ts_col: str = "timestamp",
    group_col: str = "sensor_id",
) -> pd.DataFrame:
    """
    Populate num_targets for occupancy sensor rows using a three-step strategy.

    VARCHAR coerce
        If num_targets is stored as a text column

    cumulative entries / exits (daily reset)
        Plus, ``entries`` and ``exits`` are also coerced to numeric first.

    forward-fill
        Any remaining NaN values in ``num_targets`` (within occupancy rows) are forward-filled.
    """
    out = df.copy()

    # Identify occupancy rows
    if "event_type" in out.columns:
        occ_mask = out["event_type"].isin(_OCCUPANCY_EVENTS)
    else:
        occ_mask = pd.Series(True, index=out.index)

    if not occ_mask.any():
        return out

    # coerce num_targets to float
    if "num_targets" not in out.columns:
        out["num_targets"] = np.nan
    out["num_targets"] = pd.to_numeric(out["num_targets"], errors="coerce")

    occ_idx = out.index[occ_mask]

    # derive from entries/exits if still all-null
    if out.loc[occ_idx, "num_targets"].isna().all():
        for col in ("entries", "exits"):
            if col in out.columns:
                out.loc[occ_idx, col] = (
                    pd.to_numeric(out.loc[occ_idx, col], errors="coerce")
                    .fillna(0)
                )

        has_entries = "entries" in out.columns
        has_exits   = "exits"   in out.columns

        if has_entries and has_exits:
            occ_df = out.loc[occ_idx].sort_values(ts_col).copy()

            occ_df["_occ_day"] = (
                pd.to_datetime(occ_df[ts_col], utc=True, errors="coerce")
                .dt.normalize()
            )

            grp_available = (
                group_col in out.columns
                and out.loc[occ_idx, group_col].notna().any()
            )

            if grp_available:
                # Group by (sensor, day) to cumsum resets every day per sensor
                g = occ_df.groupby([group_col, "_occ_day"], sort=False)
            else:
                # Group by day only to still resets daily even without sensor grouping
                g = occ_df.groupby("_occ_day", sort=False)

            net = (
                g["entries"].cumsum() - g["exits"].cumsum()
            ).clip(lower=0)

            # Write back in the sorted order
            out.loc[occ_df.index, "num_targets"] = net.values

    # forward-fill within each sensor group
    out = out.sort_values(ts_col)

    if group_col in out.columns and out[group_col].notna().any():
        out["num_targets"] = (
            out.groupby(group_col, sort=False)["num_targets"]
               .transform(lambda s: s.ffill())
        )
    else:
        out["num_targets"] = out["num_targets"].ffill()

    return out

def cross_sensor_ffill(
    df: pd.DataFrame,
    *,
    ts_col: str = "timestamp",
    cols: Optional[List[str]] = None,
    max_gap_minutes: Optional[int] = None,
) -> pd.DataFrame:
    """
    Parameters
    ---
    df              : Input DataFrame.
    ts_col          : Name of the timestamp column.
    cols            : Columns to forward-fill.
    max_gap_minutes : If given, NaN is reintroduced when the gap to the last
                      known value exceeds this many minutes.
    """
    ffill_cols = cols if cols is not None else _FFILL_COLS
    out = df.sort_values(ts_col).copy()

    for c in ffill_cols:
        if c in out.columns and out[c].dtype == object:
            out[c] = pd.to_numeric(out[c], errors="coerce")

    if max_gap_minutes is not None:
        ts = pd.to_datetime(out[ts_col], utc=True, errors="coerce")
        gap = ts.diff().dt.total_seconds() / 60   # minutes between consecutive rows

    for c in ffill_cols:
        if c not in out.columns:
            continue
        filled = out[c].ffill()

        if max_gap_minutes is not None:
            # Mask positions where the cumulative gap since last non-NaN
            # exceeds max_gap_minutes. 
            was_nan = out[c].isna()
            # Cumulative gap resets at each non-NaN value
            cum_gap = gap.copy()
            cum_gap[~was_nan] = 0
            # Running sum of gaps within NaN runs
            run_gap = cum_gap.groupby((~was_nan).cumsum()).cumsum()
            filled = filled.where(run_gap <= max_gap_minutes)

        out[c] = filled

    return out

_NO_CLIP_COLS: frozenset = frozenset({
    "entries", "exits", "num_targets", "sensor_id",
    "quality_score", "battery_v",
})


def clip_outliers_iqr(
    df: pd.DataFrame,
    *,
    cols: Optional[List[str]] = None,
    group_col: Optional[str] = "sensor_id",
    k: float = 3.0,
) -> pd.DataFrame:
    """
    Clip sensor readings that fall beyond k x IQR from Q1/Q3.

    Columns with zero IQR (constants) are left untouched.
    """
    out = df.copy()
    clip_cols = [
        c for c in (cols if cols is not None else _NUMERIC_COLS)
        if c in out.columns and c not in _NO_CLIP_COLS
        and pd.api.types.is_numeric_dtype(out[c])
    ]
    if not clip_cols:
        return out

    has_group = (
        group_col and group_col in out.columns
        and out[group_col].notna().any()
    )

    def _clip_series(s: pd.Series) -> pd.Series:
        q1 = s.quantile(0.25)
        q3 = s.quantile(0.75)
        iqr = q3 - q1
        if iqr == 0:
            return s
        lo, hi = q1 - k * iqr, q3 + k * iqr
        return s.clip(lower=lo, upper=hi)

    if has_group:
        for c in clip_cols:
            out[c] = out.groupby(group_col, sort=False)[c].transform(_clip_series)
    else:
        for c in clip_cols:
            out[c] = _clip_series(out[c])

    return out

# ### 15-minute downsampling ###

# Columns that represent event counts - sum within the window.
_SUM_COLS: frozenset = frozenset({"entries", "exits"})

# Point-in-time columns → take the last observed value in the window.
_LAST_COLS: frozenset = frozenset({
    "num_targets",
    "weather_condition", "action", "quality", "version",
})


def resample_to_15min(
    df: pd.DataFrame,
    *,
    ts_col: str = "timestamp",
    group_col: str = "sensor_id",
    freq: str = "15min",
) -> pd.DataFrame:
    """
    Downsample high-frequency sensor data to 15-minute (or other) buckets.

    - Aggregation rules:
        - entries, exits         : sum  - event counts accumulate in the window.
        - num_targets            : last - point-in-time occupancy at window end.
        - categorical / object   : last - keep most recent string value.
        - all other numeric      :*mean - average reading over the window.

    Empty 15-minute buckets (no sensor rows in that window) are dropped so
    that downstream lag computation is not distorted by artificial NaN rows.

    - Parameters:
    df        : Preprocessed DataFrame (output of preprocess_raw_table()).
    ts_col    : Timestamp column name.
    group_col : Sensor-group column; resampling is done per-group so that
                different sensor groups don't bleed into each other.
    freq      : pandas offset alias for the target cadence (default "15min").

    - Returns:
    pd.DataFrame
        One row per (group, 15-min bucket) containing aggregated readings.
        The timestamp column holds the *left edge* of each bucket.
    """
    df = df.copy()
    df[ts_col] = pd.to_datetime(df[ts_col], utc=True, errors="coerce")
    df = df.dropna(subset=[ts_col]).copy()
    df = df.sort_values(ts_col)

    num_cols = df.select_dtypes(include="number").columns.tolist()
    obj_cols = [
        c for c in df.select_dtypes(exclude="number").columns
        if c != ts_col
    ]

    def _agg_group(gdf: pd.DataFrame) -> pd.DataFrame:
        gdf = gdf.set_index(ts_col)
        agg: dict = {}
        for c in num_cols:
            if c not in gdf.columns:
                continue
            if c in _SUM_COLS:
                agg[c] = "sum"
            elif c in _LAST_COLS:
                agg[c] = "last"
            else:
                agg[c] = "mean"
        for c in obj_cols:
            if c in gdf.columns:
                agg[c] = "last"
        if not agg:
            return pd.DataFrame()
        resampled = gdf.resample(freq, label="left", closed="left").agg(agg)
        return resampled.dropna(how="all").reset_index()

    has_group = (
        group_col in df.columns
        and df[group_col].notna().any()
    )

    if has_group:
        parts = []
        for gid, gdf in df.groupby(group_col, sort=False):
            part = _agg_group(gdf.drop(columns=[group_col], errors="ignore"))
            if not part.empty:
                part[group_col] = gid
                parts.append(part)
        if not parts:
            return df.iloc[:0].copy()
        result = pd.concat(parts, ignore_index=True).sort_values(ts_col)
    else:
        result = _agg_group(df)

    return result


# Main entry point

def preprocess_raw_table(
    df: pd.DataFrame,
    *,
    feature_name: Optional[str] = None,
    ts_col: str = "timestamp",
    group_col: str = "sensor_id",
    do_clip_outliers: bool = True,
    do_cross_sensor_ffill: bool = True,
    max_ffill_gap_minutes: Optional[int] = 60,
) -> pd.DataFrame:
    """
    Apply all preprocessing steps to the raw sensor table.

    This function is designed to be called immediately after load_table()
    and before any call to build_features() or build_features_longterm().

    Parameters
    ---
    df                    : Raw DataFrame from ``core.data.load_table()``.
    feature_name          : Name of the feature being trained (informational;
                            all steps are applied regardless).
    ts_col                : Timestamp column name.
    group_col             : Sensor grouping column name (used for lag/group ops).
    do_cross_sensor_ffill : Forward-fill AQ / energy values into all row types.
    max_ffill_gap_minutes : Maximum gap (minutes) over which values are
                            forward-filled.

    Returns
    ---
    pd.DataFrame
        Cleaned DataFrame ready for build_features().
    """
    out = df.copy()

    # Numeric coercion
    out = coerce_numeric(out)

    # Outlier clipping, runs before ffill so we don't clip filled values
    if do_clip_outliers:
        out = clip_outliers_iqr(out, group_col=group_col)

    # Sensor-ID normalisation
    out = fill_sensor_id(out)

    # Occupancy: derive num_targets when it is all-NULL
    out = compute_occupancy_num_targets(out, ts_col=ts_col, group_col=group_col)

    # Cross-sensor forward-fill
    if do_cross_sensor_ffill:
        out = cross_sensor_ffill(
            out,
            ts_col=ts_col,
            max_gap_minutes=max_ffill_gap_minutes,
        )

    return out
