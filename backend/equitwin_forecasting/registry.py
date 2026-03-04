# equitwin_forecasting/registry.py
from __future__ import annotations
from dataclasses import dataclass
from typing import Dict, List


@dataclass(frozen=True)
class FeatureConfig:
    name: str
    st_lag_cols: List[str]  # 15m lags
    lt_lag_cols: List[str]  # 4h aggregation + lt lags


def single_zone_default_configs(group_id: str = "1") -> Dict[str, FeatureConfig]:
    """
    Single-zone config.

    IMPORTANT:
    Your trained models (based on the DB table) may include phase-level electrical signals and `action`.
    If you deploy into EquiTwin without those signals at runtime, either:
      (A) provide them from the telemetry feed, OR
      (B) retrain with a smaller feature set.

    This config supports (A): it includes those phase-level signals.
    """
    phase_cols = [
        "action",
        "a_voltage", "b_voltage", "c_voltage",
        "a_act_power", "b_act_power", "c_act_power",
    ]

    # Weather exogenous columns injected at every tick via WeatherClient.
    # outdoor_temp and sunlight are numeric (lagged by the buffer).
    # weather_condition is categorical (passed through as current value;
    # OneHotEncoder in make_preprocessor handles it).
    weather_cols = ["outdoor_temp", "weather_condition", "sunlight"]

    return {
        "energy": FeatureConfig(
            name="energy",
            st_lag_cols=[
                # controls / totals
                "total_current", "total_act_power", "total_aprt_power",

                # coupling
                "temp", "humidity", "co2", "num_targets",

                # phase-level
                *phase_cols,

                # weather exogenous
                *weather_cols,
            ],
            lt_lag_cols=[
                "total_current", "total_act_power", "total_aprt_power",
                "temp", "humidity", "co2", "num_targets",
                *phase_cols,
                *weather_cols,
            ],
        ),

        "temperature": FeatureConfig(
            name="temperature",
            st_lag_cols=[
                "temp", "humidity", "co2", "num_targets", "total_act_power",
                *phase_cols,
                *weather_cols,
            ],
            lt_lag_cols=[
                "temp", "humidity", "co2", "num_targets", "total_act_power",
                *phase_cols,
                *weather_cols,
            ],
        ),

        "airquality": FeatureConfig(
            name="airquality",
            st_lag_cols=[
                "co2", "temp", "humidity", "num_targets", "total_act_power",
                *phase_cols,
                *weather_cols,
            ],
            lt_lag_cols=[
                "co2", "temp", "humidity", "num_targets", "total_act_power",
                *phase_cols,
                *weather_cols,
            ],
        ),

        "occupancy": FeatureConfig(
            name="occupancy",
            st_lag_cols=[
                "num_targets", "entries", "exits", "co2", "temp",
                *phase_cols,
                *weather_cols,
            ],
            lt_lag_cols=[
                "num_targets", "entries", "exits", "co2", "temp",
                *phase_cols,
                *weather_cols,
            ],
        ),
    }