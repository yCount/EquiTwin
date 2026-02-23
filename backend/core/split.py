from __future__ import annotations
from dataclasses import dataclass
from typing import List, Tuple
import pandas as pd

@dataclass(frozen=True)
class SplitSpec:
    ts_col: str = "timestamp"
    n_folds: int = 3
    test_size: float = 0.2
    min_train: int = 200

def rolling_splits(df: pd.DataFrame, spec: SplitSpec) -> List[Tuple[pd.Index, pd.Index]]:
    df = df.sort_values(spec.ts_col)
    n = len(df)
    n_test = max(1, int(n * spec.test_size))

    if n < spec.min_train + 1:
        # Not enough data even for one fold — return a single split using
        # whatever train rows are available, as long as there is at least 1
        # train row and 1 test row.
        n_te = max(1, min(n_test, n - 1))
        n_tr = n - n_te
        if n_tr < 1:
            return []      # truly nothing to work with
        return [(df.index[:-n_te], df.index[-n_te:])]

    splits = []
    n_test_fold = max(1, int(n * spec.test_size / max(1, spec.n_folds)))
    for k in range(spec.n_folds):
        start_test = spec.min_train + k * n_test_fold
        end_test = start_test + n_test_fold
        if end_test > n:
            break
        tr = df.index[:start_test]
        te = df.index[start_test:end_test]
        if len(tr) >= 1 and len(te) >= 1:   # only add non-empty folds
            splits.append((tr, te))

    if not splits:
        # Fallback: single split with at least 1 row in each partition
        n_te = max(1, n_test)
        n_tr = n - n_te
        if n_tr < 1:
            return []
        splits = [(df.index[:-n_te], df.index[-n_te:])]

    return splits