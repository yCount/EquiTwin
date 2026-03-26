"""
Convenience factory that wires together all pythonDNM components for EquiTwin:

    ForecastCoordinator
        |- FeatureBuffer15m   (ring-buffer for 15-minute sensor ticks)
        |- FeatureBuffer4h    (derived 4-hour aggregate view)
        |- {feature: TwoLevelPredictor}
               |- ST HorizonModelBank  (loads st_h1 … st_h8)
               |- LT HorizonModelBank  (loads lt_h1 … lt_h6)
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from equitwin_forecasting.feature_buffer import (
    BufferSpec15m,
    BufferSpec4h,
    FeatureBuffer15m,
    FeatureBuffer4h,
)
from equitwin_forecasting.predictors import (
    HorizonModelBank,
    PredictorSpec,
    TwoLevelPredictor,
)
from equitwin_forecasting.registry import FeatureConfig, single_zone_default_configs
from equitwin_forecasting.coordinator import ForecastCoordinator
from equitwin_forecasting.timebase import HorizonConfig, default_horizons

# Configuration dataclass

@dataclass
class EquiTwinConfig:
    """All knobs needed to assemble the EquiTwin forecast stack."""

    # Path to the artifacts root (must contain <feature>/best/st_h*/ and lt_h*/).
    artifacts_root: str = "artifacts"

    features: Optional[List[str]] = None

    horizons: Optional[HorizonConfig] = None

    signal_cols: List[str] = field(default_factory=lambda: [
        "total_current", "total_act_power", "total_aprt_power",
        "temp", "humidity", "co2", "voc",
        "pm2p5", "pm10", "pm1", "pm4",
        "entries", "exits", "num_targets",
        "outdoor_temp", "weather_condition", "sunlight",
    ])

    # ST lag indices (must match how models were trained).
    st_lags: List[int] = field(default_factory=lambda: [1, 2, 3, 6, 12])

    # LT lag indices (4h blocks; must match training).
    lt_lags: List[int] = field(default_factory=lambda: [1, 2, 3])

    # 4h aggregation strategy: "mean" | "sum" | "last"
    lt_agg: str = "mean"

    group_col: str = "sensor_id"
    default_group_id: str = "1"

    # Optional per-feature model override: maps feature name → model key
    # e.g. {"energy": "ridge", "temperature": "hgb"}
    # If set, loads from artifacts/<feature>/model_<key>/ instead of best/.
    # Falls back silently to "best" if the candidate dir doesn't exist.
    model_overrides: Optional[Dict[str, str]] = None

# Assembled stack

@dataclass
class EquiTwinStack:
    """Everything EquiTwin needs to run forecasts at each control tick."""

    coordinator: ForecastCoordinator
    buf15: FeatureBuffer15m
    buf4h: FeatureBuffer4h
    predictors: Dict[str, TwoLevelPredictor]
    feature_cfgs: Dict[str, FeatureConfig]
    hz: HorizonConfig
    cfg: EquiTwinConfig
    weather_client: Optional[Any] = None   # WeatherClient | None

    def ingest(self, row: Dict[str, Any]) -> None:
        """Feed one 15-minute sensor reading into the ring buffer."""
        self.buf15.ingest(row)

    def forecast_now(self, group_id: Optional[str] = None):
        """Convenience passthrough to the coordinator."""
        gid = group_id or self.cfg.default_group_id
        return self.coordinator.forecast_now(gid)

# Factory

def build_equitwin_stack(cfg: EquiTwinConfig) -> EquiTwinStack:
    """
    Builds and returns a ready-to-use EquiTwinStack.

    Raises
    ------
    FileNotFoundError
        If artifacts_root does not exist.
    RuntimeError
        If a requested feature has no trained model directories.
    """
    artifacts_root = Path(cfg.artifacts_root)
    if not artifacts_root.exists():
        raise FileNotFoundError(
            f"Artifacts root not found: {artifacts_root.resolve()}\n"
            "Run training first:  from training.service import train_feature_best_models_two_level"
        )

    # Weather client (reads WEATHER_LAT / WEATHER_LON from env)
    weather_client = None
    lat_str = os.environ.get("WEATHER_LAT", "55.8617")
    lon_str = os.environ.get("WEATHER_LON", "-4.2583")
    if lat_str and lon_str:
        try:
            from core.weather_client import WeatherClient
            weather_client = WeatherClient(float(lat_str), float(lon_str))
            print(f"[EquiTwin] WeatherClient initialized (lat={lat_str}, lon={lon_str})")
        except Exception as exc:
            print(f"[EquiTwin] WARNING: Could not init WeatherClient: {exc}. "
                  "Weather features will be NaN.")
    else:
        print("[EquiTwin] WEATHER_LAT/LON not set — weather features will be NaN.")


    hz = cfg.horizons or default_horizons()
    all_cfgs = single_zone_default_configs(group_id=cfg.default_group_id)

    requested = cfg.features or list(all_cfgs.keys())
    feature_cfgs: Dict[str, FeatureConfig] = {
        k: v for k, v in all_cfgs.items() if k in requested
    }

    # FeatureBuffer15m keeps exactly (max_lag + 1) rows.
    # FeatureBuffer4h needs 16 × (max_lt_lag + 1) rows for 4h block aggregation.
    # Extend st_lags with a sentinel value so the ring-buffer is large enough.
    block_size = 16  # 4h / 15min = 16 samples per LT block
    min_rows_for_lt = block_size * (max(cfg.lt_lags) + 1)
    extended_lags = sorted(set(cfg.st_lags) | {min_rows_for_lt - 1})

    buf15 = FeatureBuffer15m(
        spec=BufferSpec15m(
            ts_col="timestamp",
            group_col=cfg.group_col,
            signal_cols=cfg.signal_cols,
        ),
        lags=extended_lags,
    )
    buf4h = FeatureBuffer4h(
        spec=BufferSpec4h(agg=cfg.lt_agg, ts_col="timestamp", group_col=cfg.group_col),
        source_15m=buf15,
        lt_lags=cfg.lt_lags,
    )

    # Load model banks
    predictors: Dict[str, TwoLevelPredictor] = {}
    missing: List[str] = []

    for fname in requested:
        # Determine which subdir to load from: candidate override or default "best"
        override_key = (cfg.model_overrides or {}).get(fname)
        if override_key:
            cand_subdir = f"model_{override_key}"
            cand_st = _available_horizons(artifacts_root, fname, "st", hz.st_horizons, subdir=cand_subdir)
            if cand_st:
                subdir = cand_subdir
                print(f"[EquiTwin] {fname}: using override model '{override_key}' ({cand_subdir}/)")
            else:
                subdir = "best"
                print(f"[EquiTwin] {fname}: override '{override_key}' not found, falling back to best")
        else:
            subdir = "best"

        st_spec = PredictorSpec(str(artifacts_root), fname, "st", subdir=subdir)
        lt_spec = PredictorSpec(str(artifacts_root), fname, "lt", subdir=subdir)

        st_available = _available_horizons(artifacts_root, fname, "st", hz.st_horizons, subdir=subdir)
        lt_available = _available_horizons(artifacts_root, fname, "lt", hz.lt_horizons, subdir=subdir)

        if not st_available and not lt_available:
            missing.append(fname)
            continue

        if not st_available:
            print(f"[EquiTwin] WARNING: No ST models found for '{fname}'. Skipping feature.")
            continue

        if not lt_available:
            print(f"[EquiTwin] WARNING: No LT models found for '{fname}'. Skipping feature.")
            continue

        predictors[fname] = TwoLevelPredictor(
            feature_name=fname,
            st=HorizonModelBank(st_spec, horizons=st_available),
            lt=HorizonModelBank(lt_spec, horizons=lt_available),
        )

    if missing:
        print(
            f"[EquiTwin] WARNING: Features with no trained artifacts (skipped): {missing}\n"
            "  -> Run train_feature_best_models_two_level() for each missing feature."
        )

    coordinator = ForecastCoordinator(
        buffer_15m=buf15,
        buffer_4h=buf4h,
        predictors=predictors,
        feature_cfgs=feature_cfgs,
    )

    return EquiTwinStack(
        coordinator=coordinator,
        buf15=buf15,
        buf4h=buf4h,
        predictors=predictors,
        feature_cfgs=feature_cfgs,
        hz=hz,
        cfg=cfg,
        weather_client=weather_client,
    )


def _available_horizons(
    root: Path,
    feature: str,
    level: str,
    requested: List[int],
    subdir: str = "best",
) -> List[int]:
    """Return the subset of requested horizons that have a model on disk."""
    search_dir = root / feature / subdir
    if not search_dir.is_dir():
        return []
    found = []
    for h in requested:
        d = search_dir / f"{level}_h{h}"
        if (d / "model.joblib").exists():
            found.append(h)
    return found
