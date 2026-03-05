from __future__ import annotations
from core.featurize import FeatureSpec

# Keep set restricted to avoid "sometimes-null columns" breaking training on limited slices.
# You can expand base_cols later once you have consistent non-null coverage.

_META_DROP = ("raw_payload", "quality", "version")

# Lead steps (in 4h blocks) for LT weather-forecast features.
# lead1=4h, lead2=8h, lead3=12h from current block.
# During LT training these are actual future values (oracle proxy).
# During LT inference, FeatureBuffer4h should populate them from
# WeatherClient.get_forecast() — see equitwin_forecasting/feature_buffer.py.
_WEATHER_LEAD_COLS = ("outdoor_temp", "sunlight")
_WEATHER_LEADS     = (1, 2, 3)

ENERGY = FeatureSpec(
    name="energy",
    target="total_act_power",
    base_cols=[
        "timestamp", "sensor_id",
        "total_act_power","total_current",
        "a_act_power","b_act_power","c_act_power",
        "a_voltage","b_voltage","c_voltage",
        "num_targets","temp",
        # Weather features
        "outdoor_temp","weather_condition","sunlight",
        "action","quality","version"
    ],
    lag_cols=[
        "total_act_power","total_current",
        "a_act_power","b_act_power","c_act_power",
        "a_voltage","b_voltage","c_voltage",
        "num_targets","temp",
        # Numeric weather lags
        "outdoor_temp","sunlight",
    ],
    lags=(1,2,3,6,12),
    drop_cols=_META_DROP,
    lead_cols=_WEATHER_LEAD_COLS,
    leads=_WEATHER_LEADS,
)

TEMPERATURE = FeatureSpec(
    name="temperature",
    target="temp",
    base_cols=[
        "timestamp","sensor_id",
        "temp","humidity","co2","num_targets",
        "total_act_power",
        # Weather features
        "outdoor_temp","weather_condition","sunlight",
        "action","quality","version"
    ],
    lag_cols=["temp","humidity","co2","num_targets","total_act_power",
              "outdoor_temp","sunlight"],
    lags=(1,2,3,6,12),
    drop_cols=_META_DROP,
    lead_cols=_WEATHER_LEAD_COLS,
    leads=_WEATHER_LEADS,
)

AIRQUALITY_CO2 = FeatureSpec(
    name="airquality",
    target="co2",
    base_cols=[
        "timestamp","sensor_id",
        "co2","temp","humidity","voc","pm2p5","pm10","pm1","pm4",
        "num_targets","entries","exits",
        "total_act_power",
        # Weather features
        "outdoor_temp","weather_condition","sunlight",
        "action","quality","version"
    ],
    lag_cols=["co2","temp","humidity","num_targets","total_act_power","voc","pm2p5",
              "outdoor_temp","sunlight"],
    lags=(1,2,3,6,12),
    drop_cols=_META_DROP,
    lead_cols=_WEATHER_LEAD_COLS,
    leads=_WEATHER_LEADS,
)

OCCUPANCY = FeatureSpec(
    name="occupancy",
    target="num_targets",
    base_cols=[
        "timestamp","sensor_id",
        "num_targets","entries","exits",
        "co2","temp","total_act_power",
        # Weather features
        "outdoor_temp","weather_condition","sunlight",
        "action","quality","version"
    ],
    lag_cols=["num_targets","entries","exits","co2","temp","total_act_power",
              "outdoor_temp","sunlight"],
    lags=(1,2,3,6,12),
    drop_cols=_META_DROP,
    lead_cols=_WEATHER_LEAD_COLS,
    leads=_WEATHER_LEADS,
)
