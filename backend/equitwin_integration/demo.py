"""
Walkthrough of the EquiTwin integration.

    python migrate_artifacts.py --execute

Then run this demo:

    python -m equitwin_integration.demo
    # or
    ARTIFACTS=path/to/artifacts python -m equitwin_integration.demo
"""

from __future__ import annotations

import math
import os
import traceback
import pandas as pd

from equitwin_forecasting.feature_buffer import (
    FeatureBuffer15m,
    FeatureBuffer4h,
    BufferSpec15m,
    BufferSpec4h,
)
from equitwin_forecasting.predictors import (
    TwoLevelPredictor,
    HorizonModelBank,
    PredictorSpec,
)
from equitwin_forecasting.registry import single_zone_default_configs
from equitwin_forecasting.coordinator import ForecastCoordinator
from equitwin_forecasting.timebase import default_horizons, HorizonConfig
from equitwin_mpc.hierarchical import OuterMPC, InnerMPC
from equitwin_integration.bootstrap import _available_horizons
from pathlib import Path


def build_stack(artifacts_root: str = "artifacts"):
    hz = default_horizons()

    # This signal list MUST contain all raw columns the trained models expect.
    # Your error showed missing: a_voltage/b_voltage/c_voltage, a_act_power/b_act_power/c_act_power, action,
    # and their lags. Lags come from the buffer, so we must ingest base signals.
    signal_cols = [
        # HVAC totals / controls (single-zone)
        "total_current",
        "total_act_power",
        "total_aprt_power",

        # Environment
        "temp",
        "humidity",
        "co2",
        "voc",
        "pm2p5",
        "pm10",
        "pm1",
        "pm4",

        # Occupancy proxies
        "entries",
        "exits",
        "num_targets",

        # PHASE-LEVEL signals (were present in your DB rows + training)
        "action",
        "a_voltage",
        "b_voltage",
        "c_voltage",
        "a_act_power",
        "b_act_power",
        "c_act_power",

        # Weather - injected per tick via WeatherClient
        "outdoor_temp",
        "weather_condition",
        "sunlight",
    ]

    buf15 = FeatureBuffer15m(
        BufferSpec15m(signal_cols=signal_cols),
        lags=[1, 2, 3, 6, 12],
        keep_rows=128,
    )

    buf4h = FeatureBuffer4h(
        BufferSpec4h(agg="mean"),
        source_15m=buf15,
        lt_lags=[1, 2, 3],
    )

    # Load predictors using only horizons that actually have model files on disk.
    # HorizonModelBank raises FileNotFoundError when a requested horizon is missing,
    # so filters to the available subset first (same pattern as bootstrap.py).
    arts = Path(artifacts_root)
    predictors = {}
    available = []
    for fname in ["energy", "temperature", "airquality", "occupancy"]:
        st_avail = _available_horizons(arts, fname, "st", hz.st_horizons)
        lt_avail = _available_horizons(arts, fname, "lt", hz.lt_horizons)

        if not st_avail or not lt_avail:
            if st_avail or lt_avail:
                missing_level = "LT" if not lt_avail else "ST"
                print(f"    [demo] Skipping '{fname}': no {missing_level} models found.")
            continue

        try:
            predictors[fname] = TwoLevelPredictor(
                fname,
                st=HorizonModelBank(PredictorSpec(artifacts_root, fname, "st"), horizons=st_avail),
                lt=HorizonModelBank(PredictorSpec(artifacts_root, fname, "lt"), horizons=lt_avail),
            )
            available.append(fname)
        except Exception as exc:
            print(f"    [demo] Could not load '{fname}': {exc}")

    cfgs = single_zone_default_configs(group_id="2")
    coord = ForecastCoordinator(buf15, buf4h, predictors, cfgs)

    # Build horizon config from what is actually on disk
    st_horizons_used = sorted({h for f in available
                                for h in _available_horizons(arts, f, "st", hz.st_horizons)})
    lt_horizons_used = sorted({h for f in available
                                for h in _available_horizons(arts, f, "lt", hz.lt_horizons)})
    hz_actual = HorizonConfig(
        st_horizons=st_horizons_used or hz.st_horizons,
        lt_horizons=lt_horizons_used or hz.lt_horizons,
    )

    outer = OuterMPC(lt_steps=hz_actual.lt_horizons)
    inner = InnerMPC(st_steps=hz_actual.st_horizons)

    return hz_actual, buf15, coord, outer, inner, available


def warmup_buffer(buf15: FeatureBuffer15m, group_id: str, n_rows: int = 64):
    """
    Need at least 16*(max_lt_lag+1) rows for LT aggregation when lt_lags=[1,2,3] => 64 rows.
    """
    start = pd.Timestamp("2025-01-01T00:00:00Z")

    for i in range(n_rows):
        ts = start + pd.Timedelta(minutes=15 * i)

        # Provide ALL raw signals (even dummy), so model feature set matches.
        row = {
            "timestamp": ts,
            "sensor_id": group_id,

            # totals / controls
            "total_current": 10.0 + (i % 5),
            "total_act_power": 1000.0 + 20.0 * (i % 10),
            "total_aprt_power": 1200.0 + 10.0 * (i % 10),

            # env
            "temp": 20.0 + 0.05 * (i % 20),
            "humidity": 50.0 + 0.1 * (i % 10),
            "co2": 600.0 + 2.0 * (i % 30),
            "voc": 100.0,
            "pm2p5": 5.0,
            "pm10": 8.0,
            "pm1": 3.0,
            "pm4": 6.0,

            # occupancy proxies
            "entries": float(i % 2),
            "exits": float((i + 1) % 2),
            "num_targets": float(1 + (i % 3)),

            # phase-level
            "action": "NORMAL_EM" if (i % 3) else "NO_MOVEMENT",
            "a_voltage": 244.0,
            "b_voltage": 245.0,
            "c_voltage": 246.0,
            "a_act_power": 1500.0 + 10.0 * (i % 10),
            "b_act_power": 1400.0 + 10.0 * (i % 10),
            "c_act_power": 1300.0 + 10.0 * (i % 10),

            # Synthetic weather: daily temperature cycle + solar arc
            "outdoor_temp": 10.0 + 5.0 * math.sin(2.0 * math.pi * i / 96),
            "weather_condition": "sunny" if (i % 96) < 48 else "cloudy",
            "sunlight": max(0.0, 600.0 * math.sin(math.pi * (i % 96) / 96)),
        }
        buf15.ingest(row)


def main():
    print("=" * 60)
    print(" EquiTwin Integration Demo")
    print("=" * 60)
    artifacts_root = os.environ.get("ARTIFACTS", "artifacts")
    group_id = "2"

    # Optional weather client - initialised when WEATHER_LAT/LON are set
    weather_client = None
    lat_str = os.environ.get("WEATHER_LAT")
    lon_str = os.environ.get("WEATHER_LON")
    if lat_str and lon_str:
        try:
            from core.weather_client import WeatherClient
            weather_client = WeatherClient(float(lat_str), float(lon_str))
            print(f"    WeatherClient initialized (lat={lat_str}, lon={lon_str})")
        except Exception as exc:
            print(f"    WARNING: WeatherClient init failed: {exc}")

    hz, buf15, coord, outer, inner, available = build_stack(artifacts_root=artifacts_root)

    print(f"\n[1] Building EquiTwin stack from: {artifacts_root}")
    print(f"    Loaded predictors: {available if available else '[] (none found)'}")

    print("\n[2] Warming up buffer (64 × 15-min ticks)…")
    warmup_buffer(buf15, group_id=group_id, n_rows=64)
    print(f"    Buffer length: {len(buf15.history(group_id))} rows")

    print("\n[3] Live control tick…")
    try:
        bundle = coord.forecast_now(group_id=group_id)

        # Fetch weather forecast if client is available
        weather_forecast = weather_client.get_forecast(hours=24) if weather_client else None

        plan = outer.solve(bundle, state={"temp_target": 21.0, "temp": 20.5},
                           weather_forecast=weather_forecast)
        action = inner.solve(bundle, state={"temp_target": 21.0, "temp": 20.5, "total_act_power": 1000.0}, outer=plan)

        print("    Forecast features:", list(bundle.by_feature.keys()))
        if "energy" in bundle.by_feature:
            print("    Energy ST horizons:", sorted(bundle.by_feature["energy"].st.keys()))
            print("    Energy LT horizons:", sorted(bundle.by_feature["energy"].lt.keys()))
        print("    Outer refs keys:", list(plan.refs.keys()))
        print("    Inner action:", action.u)
        print("    Info:", action.info)
    except Exception as e:
        print("    Not ready:", e)
        print(traceback.format_exc())


if __name__ == "__main__":
    main()
