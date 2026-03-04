from __future__ import annotations
from typing import Dict

from equitwin_forecasting.feature_buffer import FeatureBuffer15m, FeatureBuffer4h
from equitwin_forecasting.predictors import TwoLevelPredictor
from equitwin_forecasting.registry import FeatureConfig
from equitwin_forecasting.types import ForecastBundle, FeatureForecast

class ForecastCoordinator:
    """Produces ST (15m) and LT (4h) forecasts for each feature every control tick."""
    def __init__(
        self,
        buffer_15m: FeatureBuffer15m,
        buffer_4h: FeatureBuffer4h,
        predictors: Dict[str, TwoLevelPredictor],
        feature_cfgs: Dict[str, FeatureConfig],
    ):
        self.buf15 = buffer_15m
        self.buf4h = buffer_4h
        self.predictors = predictors
        self.cfgs = feature_cfgs

    def forecast_now(self, group_id: str) -> ForecastBundle:
        out: Dict[str, FeatureForecast] = {}
        for fname, cfg in self.cfgs.items():
            if fname not in self.predictors:
                continue
            pred = self.predictors[fname]
            X_st = self.buf15.build_X_t(group_id, cfg.st_lag_cols)
            X_lt = self.buf4h.build_X_t(group_id, cfg.lt_lag_cols, lt_steps_back=0)
            out[fname] = FeatureForecast(st=pred.st.predict(X_st), lt=pred.lt.predict(X_lt))
        return ForecastBundle(by_feature=out)
