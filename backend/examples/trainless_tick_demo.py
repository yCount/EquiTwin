from __future__ import annotations
import os
import pandas as pd

from equitwin_forecasting.feature_buffer import FeatureBuffer15m, FeatureBuffer4h, BufferSpec15m, BufferSpec4h
from equitwin_forecasting.predictors import TwoLevelPredictor, HorizonModelBank, PredictorSpec
from equitwin_forecasting.registry import single_zone_default_configs
from equitwin_forecasting.coordinator import ForecastCoordinator
from equitwin_forecasting.timebase import default_horizons
from equitwin_mpc.hierarchical import OuterMPC, InnerMPC

def main():
    hz = default_horizons()

    buf15 = FeatureBuffer15m(
        BufferSpec15m(signal_cols=[
            "total_current","total_act_power","total_aprt_power",
            "temp","humidity","co2","voc","pm2p5","pm10","pm1","pm4",
            "entries","exits","num_targets"
        ]),
        lags=[1,2,3,6,12],
    )
    buf4h = FeatureBuffer4h(BufferSpec4h(agg="mean"), source_15m=buf15, lt_lags=[1,2,3])

    artifacts = os.environ.get("ARTIFACTS", "artifacts")

    predictors = {
        "energy": TwoLevelPredictor(
            "energy",
            st=HorizonModelBank(PredictorSpec(artifacts, "energy", "st"), horizons=hz.st_horizons),
            lt=HorizonModelBank(PredictorSpec(artifacts, "energy", "lt"), horizons=hz.lt_horizons),
        ),
        "temperature": TwoLevelPredictor(
            "temperature",
            st=HorizonModelBank(PredictorSpec(artifacts, "temperature", "st"), horizons=hz.st_horizons),
            lt=HorizonModelBank(PredictorSpec(artifacts, "temperature", "lt"), horizons=hz.lt_horizons),
        ),
    }

    cfgs = single_zone_default_configs(group_id="2")
    coord = ForecastCoordinator(buf15, buf4h, predictors, cfgs)

    outer = OuterMPC(lt_steps=hz.lt_horizons)
    inner = InnerMPC(st_steps=hz.st_horizons)

    start = pd.Timestamp("2025-01-01T00:00:00Z")
    group_id = "2"

    # Need at least 16*(max_lt_lag+1) 15m samples for LT features (here lt_lags=[1,2,3] => 4 blocks => 64 rows)
    for i in range(16*4):
        ts = start + pd.Timedelta(minutes=15*i)
        row = {
            "timestamp": ts,
            "sensor_id": group_id,
            "total_current": 10 + (i % 5),
            "total_act_power": 1000 + 20*(i % 10),
            "total_aprt_power": 1200 + 10*(i % 10),
            "temp": 20.0 + 0.1*(i % 10),
            "humidity": 50.0,
            "co2": 600.0,
            "num_targets": 1.0,
            "entries": 0.0,
            "exits": 0.0,
        }
        buf15.ingest(row)

    bundle = coord.forecast_now(group_id=group_id)
    plan = outer.solve(bundle, state={"temp_target": 21.0, "temp": 20.5})
    action = inner.solve(bundle, state={"temp_target": 21.0, "temp": 20.5, "total_act_power": 1000}, outer=plan)

    print("Forecast features:", list(bundle.by_feature.keys()))
    print("Energy ST horizons:", sorted(bundle.by_feature["energy"].st.keys()))
    print("Energy LT horizons:", sorted(bundle.by_feature["energy"].lt.keys()))
    print("Outer refs:", plan.refs)
    print("Inner action:", action.u)
    print("Info:", action.info)

if __name__ == "__main__":
    main()
