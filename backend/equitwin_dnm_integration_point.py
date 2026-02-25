"""
=============================================================================
 INTEGRATION POINT (IP) — pythonDNM  →  EquiTwin Backend
=============================================================================
 File:    equitwin_dnm_integration_point.py
 Drop in: backend/services/forecast.py  (replaces / extends existing stub)
 Run:     python equitwin_dnm_integration_point.py   ← self-test / smoke run

 PURPOSE
 -------
 This file is the *single integration boundary* between the pythonDNM
 forecasting library (equitwin_forecasting, training, core) and the
 EquiTwin FastAPI backend.

 It plugs into the existing backend at exactly two call sites:
   1. services/forecast.py  →  ForecastService.get_forecast()
   2. services/mpc.py       →  MPCService.compute()   (reads bundle.by_feature)

 WHAT THIS FILE DOES
 -------------------
 A) At startup           → build_forecast_service()
      Calls build_equitwin_stack() to load all trained scikit-learn model
      banks (ST 15-min and LT 4-hour) from the artifacts directory.

 B) On every sensor tick → ForecastService.ingest(row) + .get_forecast(group)
      Feeds the latest sensor row from the database / telemetry broker into
      the ring buffer, then asks the ForecastCoordinator for ST+LT
      predictions for energy, temperature, airquality, occupancy.

 C) MPC bridge           → ForecastService.to_mpc_input(bundle)
      Converts a ForecastBundle into the flat dict that existing
      MPCService.compute() already expects, so no changes are needed in
      the MPC layer.

 DATA FLOW (per 15-minute control tick)
 ----------------------------------------
   PostgreSQL (matches table)
         │  one row JOIN of EM + AQ + OC sensors
         ▼
   ForecastService.ingest(row)
         │  → FeatureBuffer15m.ingest()
         │  → FeatureBuffer4h derives 4-hour blocks
         ▼
   ForecastService.get_forecast(group_id)
         │  → ForecastCoordinator.forecast_now()
         │       ├── HorizonModelBank ST → h1…h8  (every 15 min)
         │       └── HorizonModelBank LT → h1…h6  (every 4 hours)
         ▼
   ForecastBundle  (energy, temperature, airquality, occupancy)
         │
         ├──► MPC solver  (services/mpc.py) via to_mpc_input()
         ├──► KPI service (services/kpis.py)
         └──► iTwin sync  (adapters/itwin_mapping.py)

 REQUIREMENTS
 ------------
 Add to backend/requirements.txt:
   scikit-learn>=1.4.0
   joblib>=1.3.0
   pandas>=2.2.0
   numpy>=1.26.0

 ENVIRONMENT VARIABLES
 ---------------------
   ARTIFACTS_ROOT   path to trained model directory  (default: artifacts)
   DEFAULT_GROUP    sensor_id string to use           (default: "1")
   LT_AGG           4-hour block aggregation method   (default: mean)

 ONE-TIME MIGRATION (if existing artifacts use old h<N>/ layout)
 ---------------------------------------------------------------
   python migrate_artifacts.py --execute

=============================================================================
"""
from __future__ import annotations

import os
import logging
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# pythonDNM imports  (library is on sys.path or installed as a package)
# ---------------------------------------------------------------------------
# from equitwin_integration.bootstrap import EquiTwinConfig, EquiTwinStack, build_equitwin_stack
# from equitwin_integration.tick_runner import TickRunner, TickRunnerConfig, ControlOutput
# from equitwin_forecasting.types import ForecastBundle

logger = logging.getLogger(__name__)


# =============================================================================
# CONFIGURATION  (reads from env vars; matches backend/.env pattern)
# =============================================================================

ARTIFACTS_ROOT  = os.environ.get("ARTIFACTS_ROOT", "artifacts")
DEFAULT_GROUP   = os.environ.get("DEFAULT_GROUP", "1")
LT_AGG          = os.environ.get("LT_AGG", "mean")

# Signal columns that must be present in each ingested row.
# These match exactly the columns in EM_data + AQ_data + OC_data.
SIGNAL_COLS: List[str] = [
    # Energy meter (EM_data)
    "total_current", "total_act_power", "total_aprt_power",
    "a_act_power", "b_act_power", "c_act_power",
    "a_voltage", "b_voltage", "c_voltage",
    # Air quality (AQ_data)
    "temp", "humidity", "co2", "voc",
    "pm2p5", "pm10", "pm1", "pm4",
    # Occupancy (OC_data)
    "num_targets", "entries", "exits",
    # Weather exogenous — NOT from the DB; injected by TickRunner._enrich_with_weather()
    # via WeatherClient.get_current() at each tick (NaN when WEATHER_LAT/LON not set).
    "outdoor_temp", "weather_condition", "sunlight",
]


# =============================================================================
# FORECAST SERVICE  —  drop-in for backend/services/forecast.py
# =============================================================================

class ForecastService:
    """
    Wraps the pythonDNM stack for use inside the EquiTwin FastAPI backend.

    Usage (in services/forecast.py or app.py lifespan)
    ---------------------------------------------------
        from equitwin_dnm_integration_point import ForecastService, build_forecast_service

        # At startup:
        _forecast_svc = build_forecast_service()

        # In each telemetry handler (broker.py / streams.py):
        _forecast_svc.ingest(sensor_row_dict)

        # In MPC service / API route:
        bundle  = _forecast_svc.get_forecast()
        mpc_in  = _forecast_svc.to_mpc_input(bundle)
    """

    def __init__(self, stack: EquiTwinStack, group_id: str = DEFAULT_GROUP) -> None:
        self._stack = stack
        self._group_id = group_id
        self._runner = TickRunner(
            stack,
            TickRunnerConfig(
                group_id=group_id,
                temp_target=21.0,
                min_warm_rows=64,       # 64 × 15 min = 16 h warm-up
            ),
        )
        self._last_bundle: Optional[ForecastBundle] = None

    # ------------------------------------------------------------------
    # Core API
    # ------------------------------------------------------------------

    def ingest(self, row: Dict[str, Any]) -> None:
        """
        Feed one sensor row into the ring buffer.

        ``row`` must contain:
          - "timestamp"  (ISO string or datetime)
          - "sensor_id"  (string matching DEFAULT_GROUP)
          - Any subset of SIGNAL_COLS (missing columns become NaN)

        This is called from:
          - telemetry/broker.py  when a real-time MQTT/WS message arrives
          - A batch loader that replays the PostgreSQL matches table on startup
        """
        self._stack.buf15.ingest(row)

    def get_forecast(
        self,
        group_id: Optional[str] = None,
    ) -> Optional[ForecastBundle]:
        """
        Return ST + LT forecasts for all features.

        Returns None if the buffer is still warming up (< 64 ticks).
        Logs a warning so the MPC service can fall back to rule-based logic.
        """
        g = group_id or self._group_id
        hist_len = len(self._stack.buf15.history(g))

        if hist_len < 64:
            logger.warning(
                "ForecastService: buffer not ready (%d/64 ticks). "
                "MPC will fall back to rule-based control.",
                hist_len,
            )
            return None

        try:
            bundle = self._stack.coordinator.forecast_now(g)
            self._last_bundle = bundle
            return bundle
        except Exception as exc:
            logger.error("ForecastService.get_forecast failed: %s", exc, exc_info=True)
            return None

    def tick(
        self,
        row: Dict[str, Any],
        state: Optional[Dict[str, Any]] = None,
    ) -> ControlOutput:
        """
        Convenience: ingest + forecast + MPC in one call.

        Returns a ControlOutput with HVAC setpoints and forecast bundle.
        Use this from services/mpc.py for a single-call integration:

            output = forecast_svc.tick(sensor_row, state={"temp_target": 21.5})
            if output.warmed_up and not output.error:
                apply_hvac_setpoints(output.inner_action.u)
        """
        return self._runner.tick(row, state=state)

    # ------------------------------------------------------------------
    # MPC bridge
    # ------------------------------------------------------------------

    @staticmethod
    def to_mpc_input(bundle: ForecastBundle) -> Dict[str, Any]:
        """
        Convert a ForecastBundle to the flat dict that services/mpc.py expects.

        Output keys match MPCService.compute()'s existing parameter names so
        that mpc.py does NOT need to be modified.

        Schema
        ------
        {
          "energy_st":       {1: float, 2: float, …}   # W, 15-min steps
          "energy_lt":       {1: float, …}               # W, 4-hour steps
          "temperature_st":  {1: float, …}               # °C
          "temperature_lt":  {1: float, …}
          "co2_st":          {1: float, …}               # ppm
          "co2_lt":          {1: float, …}
          "occupancy_st":    {1: float, …}               # count
          "occupancy_lt":    {1: float, …}
        }
        """
        result: Dict[str, Any] = {}
        feature_map = {
            "energy":      "energy",
            "temperature": "temperature",
            "airquality":  "co2",
            "occupancy":   "occupancy",
        }
        for fname, key in feature_map.items():
            if fname in bundle.by_feature:
                ff = bundle.by_feature[fname]
                result[f"{key}_st"] = {
                    h: float(v[0]) for h, v in ff.st.items()
                }
                result[f"{key}_lt"] = {
                    h: float(v[0]) for h, v in ff.lt.items()
                }
        return result

    # ------------------------------------------------------------------
    # Diagnostic helpers
    # ------------------------------------------------------------------

    @property
    def buffer_size(self) -> int:
        """How many 15-min rows are currently buffered for DEFAULT_GROUP."""
        return len(self._stack.buf15.history(self._group_id))

    @property
    def is_ready(self) -> bool:
        """True once the buffer has enough history for LT features."""
        return self.buffer_size >= 64

    def loaded_features(self) -> List[str]:
        """Names of features for which model banks were successfully loaded."""
        return list(self._stack.predictors.keys())

    def forecast_summary(self, bundle: ForecastBundle) -> Dict[str, Any]:
        """
        Return a JSON-serialisable summary of a ForecastBundle.
        Useful for the /api/forecast endpoint response.
        """
        summary: Dict[str, Any] = {}
        for fname, ff in bundle.by_feature.items():
            summary[fname] = {
                "st": {str(h): round(float(v[0]), 4) for h, v in sorted(ff.st.items())},
                "lt": {str(h): round(float(v[0]), 4) for h, v in sorted(ff.lt.items())},
            }
        return summary


# =============================================================================
# FACTORY  — called once at FastAPI startup
# =============================================================================

def build_forecast_service(
    artifacts_root: str = ARTIFACTS_ROOT,
    group_id: str = DEFAULT_GROUP,
    lt_agg: str = LT_AGG,
    features: Optional[List[str]] = None,
) -> ForecastService:
    """
    Build and return a ready ForecastService.

    Called in app.py lifespan or on first import:

        @asynccontextmanager
        async def lifespan(app: FastAPI):
            app.state.forecast = build_forecast_service()
            yield
            # cleanup if needed

    Or as a FastAPI dependency:

        def get_forecast_service(request: Request) -> ForecastService:
            return request.app.state.forecast
    """
    cfg = EquiTwinConfig(
        artifacts_root=artifacts_root,
        features=features,          # None = load all four
        default_group_id=group_id,
        lt_agg=lt_agg,
        signal_cols=SIGNAL_COLS,
    )
    stack = build_equitwin_stack(cfg)
    svc = ForecastService(stack, group_id=group_id)

    loaded = svc.loaded_features()
    logger.info(
        "ForecastService ready. Loaded features: %s. "
        "Artifacts root: %s",
        loaded, artifacts_root,
    )
    return svc


# =============================================================================
# ROW BUILDER  — converts the PostgreSQL matches JOIN row to ingest format
# =============================================================================

def matches_row_to_ingest(row: Dict[str, Any]) -> Dict[str, Any]:
    """
    Map a raw row from the ``matches`` table (JOIN of EM + AQ + OC data)
    to the flat dict expected by ForecastService.ingest().

    The matches table already has all columns from EM_data + AQ_data + OC_data
    joined on sensor_id + timestamp, so this is mostly a pass-through with
    defensive coercion.

    Parameters
    ----------
    row : dict
        One row from ``SELECT * FROM matches`` or equivalent SQLAlchemy result.

    Returns
    -------
    dict
        Ready for ForecastService.ingest().
    """
    out: Dict[str, Any] = {
        "timestamp": row.get("timestamp"),
        "sensor_id": str(row.get("sensor_id", DEFAULT_GROUP)),
    }
    for col in SIGNAL_COLS:
        val = row.get(col)
        if val is not None:
            try:
                out[col] = float(val)
            except (TypeError, ValueError):
                out[col] = None
        else:
            out[col] = None
    return out


# =============================================================================
# WARM-UP LOADER  — replay historical data from PostgreSQL on startup
# =============================================================================

def warmup_from_db(
    svc: ForecastService,
    db_url: str,
    table: str = "matches",
    limit: int = 200,
    sensor_id: Optional[str] = None,
) -> int:
    """
    Pre-fill the ring buffer with recent rows from PostgreSQL so the
    ForecastService is ready immediately after startup (no 16-hour wait).

    Parameters
    ----------
    svc      : ForecastService to warm up.
    db_url   : SQLAlchemy DB URL (e.g. "postgresql+psycopg2://...").
    table    : Table name (default "matches").
    limit    : How many recent rows to load (200 ≈ 50 hours at 15-min cadence).
    sensor_id: Filter to a specific sensor. None = use svc default group.

    Returns
    -------
    int : Number of rows ingested.

    Usage in app.py lifespan
    ------------------------
        from equitwin_dnm_integration_point import build_forecast_service, warmup_from_db

        @asynccontextmanager
        async def lifespan(app: FastAPI):
            svc = build_forecast_service()
            await asyncio.get_event_loop().run_in_executor(
                None, warmup_from_db, svc, settings.database_url
            )
            app.state.forecast = svc
            yield
    """
    from sqlalchemy import create_engine, text

    sid = sensor_id or svc._group_id
    engine = create_engine(db_url)
    query = text(
        f"SELECT * FROM {table} "
        f"WHERE sensor_id = :sid "
        f"ORDER BY timestamp DESC "
        f"LIMIT :lim"
    )
    with engine.connect() as conn:
        rows = conn.execute(query, {"sid": sid, "lim": limit}).mappings().all()

    # Reverse so oldest row goes in first
    rows_asc = list(reversed(rows))
    for row in rows_asc:
        svc.ingest(matches_row_to_ingest(dict(row)))

    logger.info(
        "warmup_from_db: ingested %d rows for sensor_id=%s. Buffer ready: %s",
        len(rows_asc), sid, svc.is_ready,
    )
    return len(rows_asc)


# =============================================================================
# SELF-TEST / SMOKE RUN
# =============================================================================

def _smoke_test() -> None:
    """
    Run without a database or trained models to validate wiring only.
    Uses mock data and skips model loading.
    """
    import sys

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    print("=" * 60)
    print(" pythonDNM → EquiTwin Integration Point — Smoke Test")
    print("=" * 60)

    # --- Test 1: matches_row_to_ingest ---
    raw = {
        "sensor_id": "1",
        "timestamp": "2025-06-01T08:00:00+01:00",
        "total_act_power": 1040.0,
        "total_current": 12.3,
        "total_aprt_power": 1250.0,
        "temp": 21.2,
        "humidity": 48.5,
        "co2": 620.0,
        "num_targets": 3,
        "entries": 1,
        "exits": 0,
        # columns that may be missing:
        "voc": None,
    }
    mapped = matches_row_to_ingest(raw)
    assert mapped["sensor_id"] == "1"
    assert mapped["total_act_power"] == 1040.0
    assert mapped["voc"] is None
    print("[1] matches_row_to_ingest  ✓")

    # --- Test 2: buffer wiring (no model files needed) ---
    from equitwin_forecasting.feature_buffer import (
        BufferSpec15m, FeatureBuffer15m,
        BufferSpec4h,  FeatureBuffer4h,
    )
    from equitwin_integration.bootstrap import _available_horizons
    from pathlib import Path

    buf15 = FeatureBuffer15m(
        BufferSpec15m(signal_cols=SIGNAL_COLS),
        lags=[1, 2, 3, 6, 12, 63],   # extended for LT
    )
    buf4h = FeatureBuffer4h(
        BufferSpec4h(agg="mean"),
        source_15m=buf15,
        lt_lags=[1, 2, 3],
    )
    start = pd.Timestamp("2025-01-01T00:00:00Z")
    for i in range(70):
        ts = start + pd.Timedelta(minutes=15 * i)
        row2 = {col: float(i % 10) for col in SIGNAL_COLS}
        row2["timestamp"] = ts
        row2["sensor_id"] = "1"
        buf15.ingest(row2)

    X_st = buf15.build_X_t("1", ["total_act_power", "temp", "co2"])
    X_lt = buf4h.build_X_t("1", ["total_act_power", "temp", "co2"], lt_steps_back=0)
    assert X_st.shape[0] == 1
    assert X_lt.shape[0] == 1
    print(f"[2] Buffer wiring  ✓  (X_st={X_st.shape}, X_lt={X_lt.shape})")

    # --- Test 3: to_mpc_input schema ---
    from equitwin_forecasting.types import ForecastBundle, FeatureForecast
    dummy_bundle = ForecastBundle(by_feature={
        "energy": FeatureForecast(
            st={1: np.array([1050.0]), 2: np.array([1060.0])},
            lt={1: np.array([1100.0])},
        ),
        "temperature": FeatureForecast(
            st={1: np.array([21.3])},
            lt={1: np.array([21.5])},
        ),
    })
    mpc_in = ForecastService.to_mpc_input(dummy_bundle)
    assert mpc_in["energy_st"][1] == 1050.0
    assert mpc_in["temperature_lt"][1] == 21.5
    assert "co2_st" not in mpc_in   # airquality not in dummy
    print(f"[3] to_mpc_input schema  ✓  keys={list(mpc_in.keys())}")

    # --- Test 4: artifact directory probe ---
    arts = Path(ARTIFACTS_ROOT)
    if arts.exists():
        found = _available_horizons(arts, "energy", "st", [1, 2, 3, 4, 6, 8])
        print(f"[4] Artifact probe  ✓  energy ST horizons found: {found}")
    else:
        print(f"[4] Artifact probe  — '{ARTIFACTS_ROOT}' not found (train first)")

    print("\nAll smoke tests passed ✓")
    print("\nNext step:")
    print("  1. Run:  python migrate_artifacts.py --execute")
    print("  2. Train: python -m equitwin_integration.train_all --db-url ... --table matches")
    print("  3. Start: uvicorn app:app --reload")


if __name__ == "__main__":
    _smoke_test()
