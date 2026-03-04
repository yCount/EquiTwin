from __future__ import annotations
from dataclasses import dataclass
from typing import Dict
import numpy as np

@dataclass
class FeatureForecast:
    st: Dict[int, np.ndarray]  # 15m steps
    lt: Dict[int, np.ndarray]  # 4h steps

@dataclass
class ForecastBundle:
    by_feature: Dict[str, FeatureForecast]
