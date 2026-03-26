"""
Concept drift detection for EquiTwin training pipeline.

Uses Population Stability Index (PSI) to compare the distribution of
key sensor columns between a reference window (oldest 80% of training data)
and a recent window (newest 20%).

PSI interpretation:
    < 0.1   : stable; no significant distribution shift
    0.1-0.2 : moderate shift; monitor but no immediate action needed
    > 0.2   : significant drift; model likely stale - better schedule retraining

Called automatically from train_feature_best_models() after data load.
"""
from __future__ import annotations

import warnings
from typing import Dict, List, Optional, Sequence

import numpy as np
import pandas as pd


def compute_psi(
    expected: np.ndarray,
    actual: np.ndarray,
    *,
    buckets: int = 10,
    epsilon: float = 1e-6,
) -> float:
    """
    Compute Population Stability Index between two 1-D numeric arrays.

    Both arrays are binned into ``buckets`` equal-width bins derived from
    ``expected``.  Bins with zero count get a small epsilon to avoid log(0).

    Parameters
    ----------
    expected : Reference distribution (e.g. oldest 80% of training rows).
    actual   : Recent distribution  (e.g. newest 20% of training rows).
    buckets  : Number of histogram bins (default 10).
    epsilon  : Small constant added to each bin count before taking log.

    Returns
    -------
    float - PSI value (≥ 0).  Returns nan when either array is empty or
            all values are identical (zero-variance column).
    """
    expected = np.asarray(expected, dtype=float)
    actual   = np.asarray(actual,   dtype=float)

    # Remove NaN
    expected = expected[np.isfinite(expected)]
    actual   = actual[np.isfinite(actual)]

    if len(expected) == 0 or len(actual) == 0:
        return float("nan")

    col_min = min(expected.min(), actual.min())
    col_max = max(expected.max(), actual.max())
    if col_max == col_min:
        return 0.0   # constant column — no drift possible

    breakpoints = np.linspace(col_min, col_max, buckets + 1)

    e_counts, _ = np.histogram(expected, bins=breakpoints)
    a_counts, _ = np.histogram(actual,   bins=breakpoints)

    e_pct = (e_counts / len(expected)) + epsilon
    a_pct = (a_counts / len(actual))   + epsilon

    psi = float(np.sum((a_pct - e_pct) * np.log(a_pct / e_pct)))
    return psi


def check_feature_drift(
    df: pd.DataFrame,
    cols: Sequence[str],
    *,
    ts_col: str = "timestamp",
    reference_fraction: float = 0.80,
    psi_warn: float = 0.10,
    psi_critical: float = 0.20,
    feature_name: str = "",
) -> Dict[str, float]:
    """
    Compute PSI for each column between the reference (oldest) and recent
    (newest) windows of a training DataFrame.

    Parameters
    ---
    df                  : Featurized or raw training DataFrame.
    cols                : Numeric column names to check.
    ts_col              : Timestamp column used to sort rows chronologically.
    reference_fraction  : Fraction of rows (sorted by time) used as reference.
                          Default 0.80 — oldest 80% vs newest 20%.
    psi_warn            : PSI threshold for a UserWarning (default 0.10).
    psi_critical        : PSI threshold for a stronger warning (default 0.20).
    feature_name        : Label used in warning messages.

    Returns
    ---
    dict mapping column name → PSI value (nan for non-numeric / empty cols).
    """
    if df.empty or len(df) < 20:
        return {}

    out = df.copy()
    if ts_col in out.columns:
        out = out.sort_values(ts_col).reset_index(drop=True)

    split = int(len(out) * reference_fraction)
    reference = out.iloc[:split]
    recent    = out.iloc[split:]

    psi_results: Dict[str, float] = {}
    drifted: List[str] = []
    warn_cols: List[str] = []

    for col in cols:
        if col not in out.columns:
            continue
        if not pd.api.types.is_numeric_dtype(out[col]):
            continue

        psi_val = compute_psi(
            reference[col].values,
            recent[col].values,
        )
        psi_results[col] = psi_val

        if np.isfinite(psi_val):
            if psi_val >= psi_critical:
                drifted.append(f"{col}={psi_val:.3f}")
            elif psi_val >= psi_warn:
                warn_cols.append(f"{col}={psi_val:.3f}")

    prefix = f"[drift/{feature_name}]" if feature_name else "[drift]"

    if drifted:
        warnings.warn(
            f"{prefix} SIGNIFICANT distribution shift detected in "
            f"{len(drifted)} column(s) (PSI ≥ {psi_critical}): "
            f"{', '.join(drifted)}. "
            "Consider scheduling a full retrain with fresh data.",
            UserWarning,
            stacklevel=3,
        )
    if warn_cols:
        warnings.warn(
            f"{prefix} Moderate distribution shift in "
            f"{len(warn_cols)} column(s) (PSI {psi_warn}–{psi_critical}): "
            f"{', '.join(warn_cols)}. Monitor and retrain if accuracy degrades.",
            UserWarning,
            stacklevel=3,
        )

    return psi_results
