from __future__ import annotations
import numpy as np
from dataclasses import dataclass

@dataclass
class RegressionMetrics:
    mae: float
    rmse: float
    r2: float

def regression_metrics(y_true, y_pred) -> RegressionMetrics:
    y_true = np.asarray(y_true)
    y_pred = np.asarray(y_pred)
    mae = float(np.mean(np.abs(y_true - y_pred)))
    mse = float(np.mean((y_true - y_pred)**2))
    rmse = float(np.sqrt(mse))
    denom = float(np.sum((y_true - np.mean(y_true))**2))
    r2 = float(1.0 - (np.sum((y_true - y_pred)**2) / denom)) if denom > 0 else float("nan")
    return RegressionMetrics(mae=mae, rmse=rmse, r2=r2)
