from __future__ import annotations
import numpy as np
from dataclasses import dataclass, field
from typing import Optional

@dataclass
class RegressionMetrics:
    mae: float
    rmse: float
    r2: float
    # Mean Absolute Scaled Error vs naive lag-1 baseline.
    # mase < 1.0 -> model beats "just repeat the last value"
    # mase > 1.0 -> model is worse than naive; review features/data
    # nan when naive baseline is constant (zero denominator)
    mase: float = float("nan")

def regression_metrics(
    y_true,
    y_pred,
    *,
    y_naive: Optional[np.ndarray] = None,
) -> RegressionMetrics:
    """
    Compute MAE, RMSE, R^2 and (optional) MASE.

    Parameters
    ---
    y_true  : ground-truth targets
    y_pred  : model predictions
    y_naive : predictions from the naive lag-1 baseline (optional).
              When provided, MASE = MAE(model) / MAE(naive).
              Pass the lag-1 shifted values of y_true aligned to y_te.
    """
    y_true = np.asarray(y_true)
    y_pred = np.asarray(y_pred)
    mae = float(np.mean(np.abs(y_true - y_pred)))
    mse = float(np.mean((y_true - y_pred)**2))
    rmse = float(np.sqrt(mse))
    denom = float(np.sum((y_true - np.mean(y_true))**2))
    r2 = float(1.0 - (np.sum((y_true - y_pred)**2) / denom)) if denom > 0 else float("nan")

    mase = float("nan")
    if y_naive is not None:
        y_naive = np.asarray(y_naive)
        naive_mae = float(np.mean(np.abs(y_true - y_naive)))
        mase = float(mae / naive_mae) if naive_mae > 0 else float("nan")

    return RegressionMetrics(mae=mae, rmse=rmse, r2=r2, mase=mase)
