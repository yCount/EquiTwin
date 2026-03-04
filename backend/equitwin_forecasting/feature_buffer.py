from __future__ import annotations
from dataclasses import dataclass
from typing import Dict, List, Any, Optional
import numpy as np
import pandas as pd

def _time_features(ts: Any) -> Dict[str, float]:
    ts = pd.to_datetime(ts, utc=True, errors="coerce")
    hour = float(ts.hour)
    dow = float(ts.dayofweek)
    return {
        "hour": hour,
        "dayofweek": dow,
        "month": float(ts.month),
        "is_weekend": float(dow >= 5),
        "hour_sin": float(np.sin(2*np.pi*hour/24.0)),
        "hour_cos": float(np.cos(2*np.pi*hour/24.0)),
        "dow_sin": float(np.sin(2*np.pi*dow/7.0)),
        "dow_cos": float(np.cos(2*np.pi*dow/7.0)),
    }

@dataclass(frozen=True)
class BufferSpec15m:
    ts_col: str = "timestamp"
    group_col: str = "sensor_id"
    signal_cols: List[str] = None  # must be set

class FeatureBuffer15m:
    """
    Keeps last N samples per group at 15-min resolution.

    Original behavior kept only (max_lag+1), which is enough for ST lag features
    but NOT enough for LT aggregation (4h blocks need 64 rows when lt_lags=[1,2,3]).

    New behavior:
      - keep_rows controls how many rows we retain per group
      - default keep_rows is large enough for LT demo/training integration
    """
    def __init__(self, spec: BufferSpec15m, lags: List[int], keep_rows: Optional[int] = None):
        if spec.signal_cols is None:
            raise ValueError("BufferSpec15m.signal_cols must be provided")
        self.spec = spec
        self.lags = sorted(set(int(x) for x in lags))
        self.max_lag = max(self.lags) if self.lags else 0

        # Default: enough for LT aggregation (64) + slack; also must be >= max_lag+1
        # If user provides keep_rows, still enforce >= max_lag+1
        if keep_rows is None:
            keep_rows = 128
        self.keep_rows = max(int(keep_rows), self.max_lag + 1)

        self._hist: Dict[str, pd.DataFrame] = {}

    def ingest(self, row: Dict[str, Any]) -> None:
        g = str(row[self.spec.group_col])
        r = {c: row.get(c, None) for c in [self.spec.ts_col, self.spec.group_col] + self.spec.signal_cols}
        new = pd.DataFrame([r])
        df = self._hist.get(g)
        df = new if df is None else pd.concat([df, new], axis=0, ignore_index=True)

        # IMPORTANT: trim by keep_rows (not max_lag+1)
        if len(df) > self.keep_rows:
            df = df.iloc[-self.keep_rows:].reset_index(drop=True)

        self._hist[g] = df

    def history(self, group_id: str) -> pd.DataFrame:
        g = str(group_id)
        if g not in self._hist:
            return pd.DataFrame(columns=[self.spec.ts_col, self.spec.group_col] + self.spec.signal_cols)
        return self._hist[g].copy()

    def build_X_t(self, group_id: str, lag_cols: List[str]) -> pd.DataFrame:
        g = str(group_id)
        if g not in self._hist or len(self._hist[g]) == 0:
            raise ValueError(f"No 15m history for group={g}")
        df = self._hist[g]
        latest = df.iloc[-1]
        ts = latest[self.spec.ts_col]

        x: Dict[str, Any] = {self.spec.group_col: g, **_time_features(ts)}
        for col in lag_cols:
            x[col] = latest.get(col, None)
            for L in self.lags:
                idx = len(df) - 1 - L
                x[f"{col}_lag{L}"] = df.iloc[idx][col] if idx >= 0 else None
        return pd.DataFrame([x])

@dataclass(frozen=True)
class BufferSpec4h:
    agg: str = "mean"  # mean, last, sum
    ts_col: str = "timestamp"
    group_col: str = "sensor_id"

class FeatureBuffer4h:
    """Builds 4-hour blocks from 15m history on demand (single-zone friendly)."""
    def __init__(self, spec: BufferSpec4h, source_15m: FeatureBuffer15m, lt_lags: List[int]):
        self.spec = spec
        self.source_15m = source_15m
        self.lt_lags = sorted(set(int(x) for x in lt_lags))
        self.max_lt_lag = max(self.lt_lags) if self.lt_lags else 0

    def _aggregate_block(self, df: pd.DataFrame, cols: List[str]) -> Dict[str, Any]:
        if df.empty:
            return {c: None for c in cols}
        if self.spec.agg == "last":
            return {c: df.iloc[-1][c] for c in cols}
        if self.spec.agg == "sum":
            return {c: float(pd.to_numeric(df[c], errors="coerce").sum()) for c in cols}
        return {c: float(pd.to_numeric(df[c], errors="coerce").mean()) for c in cols}

    def build_X_t(self, group_id: str, lag_cols: List[str], lt_steps_back: int = 0) -> pd.DataFrame:
        """
        Build an LT input row at the most recent 4h boundary.
        lt_steps_back=0 -> most recent block, 1 -> previous block, etc.

        Assumes 15m cadence: 4h block = 16 samples.
        """
        hist = self.source_15m.history(group_id)
        if hist.empty:
            raise ValueError(f"No 15m history to build 4h features for group={group_id}")

        ts_col = self.source_15m.spec.ts_col
        hist[ts_col] = pd.to_datetime(hist[ts_col], utc=True, errors="coerce")
        hist = hist.dropna(subset=[ts_col]).sort_values(ts_col).reset_index(drop=True)

        block_size = 16
        total_needed_blocks = self.max_lt_lag + 1 + lt_steps_back
        total_needed_rows = total_needed_blocks * block_size
        if len(hist) < total_needed_rows:
            raise ValueError(f"Not enough 15m rows for LT build. Have {len(hist)}, need {total_needed_rows}.")

        tail = hist.iloc[-total_needed_rows:].reset_index(drop=True)
        blocks = [tail.iloc[i*block_size:(i+1)*block_size] for i in range(total_needed_blocks)]
        cur_block_idx = total_needed_blocks - 1 - lt_steps_back
        cur_block = blocks[cur_block_idx]

        ts_end = cur_block.iloc[-1][ts_col]
        x: Dict[str, Any] = {self.spec.group_col: str(group_id), **_time_features(ts_end)}

        x.update(self._aggregate_block(cur_block, lag_cols))

        for col in lag_cols:
            for L in self.lt_lags:
                bidx = cur_block_idx - L
                x[f"{col}_ltlag{L}"] = None if bidx < 0 else self._aggregate_block(blocks[bidx], [col])[col]

        return pd.DataFrame([x])
