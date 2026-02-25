"""
FastAPI entrypoint for Energy Management System.
- Exposes REST: /mpc/optimize, /forecast/energy, /kpis, /timeseries
- Exposes WebSocket: /telemetry/ws to push live EM/AQ/OC updates to frontend
Glues: services/* + adapters/* + security
"""

import asyncio
import os
from contextlib import asynccontextmanager
from decimal import Decimal
from fastapi import FastAPI, HTTPException, Request, WebSocket, Depends
from fastapi.middleware.cors import CORSMiddleware
from typing import Any, Dict, List, Optional
from sqlalchemy import create_engine, text
from models import (
    EnergyPoint, AirPoint, OccPoint, WeatherPoint,
    MpcRequest, MpcSuggestion,
    MpcTickRequest, MpcTickResponse, ForecastStatusResponse,
)
from services.mpc import run_mpc
from services.forecast import forecast_energy
from services.kpis import compute_kpis

# Lazy-initialised engine for the /api/db/rows viewer endpoint.
# Set DATABASE_URL env var before starting uvicorn, e.g.:
#   export DATABASE_URL="postgresql+psycopg2://postgres:6196@localhost:5432/eco_init"
_db_engine = None

def _get_db_engine():
    global _db_engine
    if _db_engine is None:
        db_url = os.environ.get("DATABASE_URL")
        if not db_url:
            return None
        _db_engine = create_engine(db_url, pool_pre_ping=True)
    return _db_engine


# ---- ForecastService lifecycle ----------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    At startup: build the pythonDNM ForecastService and optionally warm it up
    from the PostgreSQL matches table so forecasts are available immediately.
    At shutdown: nothing to clean up (sklearn models are in-memory only).
    """
    artifacts_root = os.environ.get(
        "ARTIFACTS_ROOT",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "artifacts"),
    )
    db_url = os.environ.get("DATABASE_URL")
    app.state.forecast = None

    try:
        from equitwin_dnm_integration_point import build_forecast_service, warmup_from_db
        svc = build_forecast_service(artifacts_root=artifacts_root)
        app.state.forecast = svc
        print(f"[EquiTwin] ForecastService ready. Loaded features: {svc.loaded_features()}")

        if db_url:
            try:
                n = await asyncio.to_thread(warmup_from_db, svc, db_url)
                print(f"[EquiTwin] Buffer warmed up: {n} rows ingested. Ready: {svc.is_ready}")
            except Exception as exc:
                print(f"[EquiTwin] DB warmup skipped: {exc}")

    except FileNotFoundError as exc:
        print(
            f"[EquiTwin] Artifacts not found at '{artifacts_root}' ({exc}). "
            "Train models first:  python -m equitwin_integration.train_all "
            "--db-url postgresql+psycopg2://... --table matches\n"
            "[EquiTwin] MPC endpoints will return HTTP 503 until artifacts exist."
        )
    except Exception as exc:
        print(f"[EquiTwin] ForecastService init failed: {exc}. MPC endpoints will return HTTP 503.")

    yield   # app runs here
    # Shutdown — nothing to tear down


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],  # dev
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)

# DTOs live in models.py — imported above to avoid circular imports with services.

# ---- REST -------------------------------------------------------------------
@app.post("/mpc/optimize", response_model=List[MpcSuggestion])
def mpc_optimize(req: MpcRequest):
    return run_mpc(req)

@app.get("/forecast/energy")
def forecast_energy_endpoint(horizon_minutes: int = 120):
    return forecast_energy(horizon_minutes)

@app.get("/kpis")
def kpis():
    return compute_kpis()


# ---- Database table viewer --------------------------------------------------
_ALLOWED_TABLES = {"matches"}

@app.get("/api/db/rows")
def get_db_rows(page: int = 1, page_size: int = 50, table: str = "matches"):
    """
    Paginated read of the raw sensor table with feature engineering:
      - net_occupancy  : cumulative (entries − exits) clamped to 0, giving an
                         estimated people-count at each row's timestamp.
      - event_label    : human-readable alias for raw event_type strings.

    Set DATABASE_URL env var (postgresql+psycopg2://...) before starting the
    server.  Training pipelines (equitwin_integration/train_all.py) connect via
    their own DataSpec and are not affected by this endpoint.
    """
    engine = _get_db_engine()
    if engine is None:
        raise HTTPException(
            status_code=503,
            detail="DATABASE_URL env var not set. "
                   "Example: export DATABASE_URL='postgresql+psycopg2://user:pass@host:5432/dbname'",
        )

    if table not in _ALLOWED_TABLES:
        raise HTTPException(status_code=400, detail=f"Table '{table}' not allowed.")

    page_size = max(1, min(page_size, 200))
    offset = (page - 1) * page_size

    with engine.connect() as conn:
        # 1. Discover columns so we can build feature SQL conditionally.
        cols_res = conn.execute(
            text("SELECT column_name FROM information_schema.columns "
                 "WHERE table_name = :t ORDER BY ordinal_position"),
            {"t": table},
        )
        schema_cols: List[str] = [r[0] for r in cols_res]

        has_entries    = "entries"    in schema_cols
        has_exits      = "exits"      in schema_cols
        has_event_type = "event_type" in schema_cols

        # 2. Total row count for pagination metadata.
        total: int = conn.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar()

        # 3. Build feature-engineering expressions (pure SQL, no user input).
        extra_select = ""
        result_extra: List[str] = []

        if has_entries and has_exits:
            # Running net occupancy: cumulative entries minus exits, never < 0.
            # Window function runs over all rows before LIMIT/OFFSET, so the
            # value on page 3 correctly reflects everything that happened before it.
            extra_select += (
                ",\n  GREATEST(0,\n"
                "    SUM(COALESCE(entries,0)) OVER (ORDER BY timestamp, id\n"
                "      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) -\n"
                "    SUM(COALESCE(exits,0))   OVER (ORDER BY timestamp, id\n"
                "      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)\n"
                "  ) AS net_occupancy"
            )
            result_extra.append("net_occupancy")

        if has_event_type:
            extra_select += (
                ",\n  CASE event_type\n"
                "    WHEN 'NO_MOVEMENT'    THEN 'No Motion'\n"
                "    WHEN 'EXIT_DETECTED'  THEN 'Exit Detected'\n"
                "    WHEN 'NORMAL_EM'      THEN 'Energy Meter'\n"
                "    WHEN 'NORMAL_AQ'      THEN 'Air Quality'\n"
                "    ELSE event_type\n"
                "  END AS event_label"
            )
            result_extra.append("event_label")

        data_sql = text(
            f"SELECT *{extra_select}\n"
            f"FROM {table}\n"
            f"ORDER BY timestamp, id\n"
            f"LIMIT :lim OFFSET :off"
        )
        rows_res = conn.execute(data_sql, {"lim": page_size, "off": offset})
        all_cols = schema_cols + result_extra

        def _coerce(v):
            """Make values JSON-serialisable."""
            if v is None:
                return None
            if hasattr(v, "isoformat"):   # datetime / date
                return v.isoformat()
            if isinstance(v, Decimal):
                return float(v)
            if isinstance(v, (bytes, bytearray)):
                return v.hex()
            return v

        rows = [
            {col: _coerce(row[i]) for i, col in enumerate(all_cols)}
            for row in rows_res
        ]

    return {
        "rows": rows,
        "total": int(total),
        "page": page,
        "page_size": page_size,
        "total_pages": max(1, (int(total) + page_size - 1) // page_size),
        "columns": all_cols,
    }


# ---- Dashboard time-series charts ------------------------------------------

@app.get("/api/db/timeseries")
def get_db_timeseries(table: str = "matches", bucket_minutes: int = 15):
    """
    Returns ALL available sensor time-series data bucketed by bucket_minutes.
    The frontend handles time-range filtering; this endpoint always returns
    the full history so the timeline slider works correctly.

    Metrics returned:
      temperature  — indoor temp from NORMAL_AQ rows (°C)
      airQuality   — CO2 from NORMAL_AQ rows (ppm)
      occupancy    — cumulative net occupancy (entries − exits, ≥ 0)
      energy       — total active power from NORMAL_EM rows (W), split by circuit
      weather      — outdoor_temp if the WeatherClient logged it (°C); often empty
    """
    engine = _get_db_engine()
    if engine is None:
        raise HTTPException(status_code=503, detail="DATABASE_URL env var not set")
    if table not in _ALLOWED_TABLES:
        raise HTTPException(status_code=400, detail=f"Table '{table}' not allowed.")

    _fallback_secs = max(60, min(bucket_minutes * 60, 86400))

    # Discover available columns and auto-detect bucket size from data span.
    with engine.connect() as conn:
        schema = {
            r[0]
            for r in conn.execute(
                text("SELECT column_name FROM information_schema.columns"
                     " WHERE table_name = :t"),
                {"t": table},
            )
        }
        ts_range = conn.execute(
            text(f"SELECT MIN(timestamp), MAX(timestamp) FROM {table}")
        ).fetchone()

    span_secs: float = 0.0
    if ts_range and ts_range[0] and ts_range[1]:
        span_secs = (ts_range[1] - ts_range[0]).total_seconds()

    if span_secs <= 7_200:        bucket_secs = 60       # ≤ 2 h  → 1-min
    elif span_secs <= 43_200:     bucket_secs = 300      # ≤ 12 h → 5-min
    elif span_secs <= 172_800:    bucket_secs = 900      # ≤ 48 h → 15-min
    elif span_secs <= 604_800:    bucket_secs = 3_600    # ≤ 7 d  → 1-hr
    else:                         bucket_secs = _fallback_secs

    def bkt(col: str = "timestamp") -> str:
        return (
            f"TO_TIMESTAMP(FLOOR(EXTRACT(EPOCH FROM {col}) / {bucket_secs})"
            f" * {bucket_secs})"
        )

    def grp(col: str = "timestamp") -> str:
        return f"FLOOR(EXTRACT(EPOCH FROM {col}) / {bucket_secs})"

    def run(sql: str) -> list:
        with engine.connect() as conn:
            return conn.execute(text(sql)).fetchall()

    result: dict = {}
    has_et = "event_type" in schema  # some schemas omit this column

    # --- Temperature (indoor, from AQ sensor) --------------------------------
    if "temp" in schema:
        et_filter = "event_type = 'NORMAL_AQ' AND " if has_et else ""
        rows = run(f"""
            SELECT {bkt()} AS ts, AVG(temp) AS v
            FROM {table}
            WHERE {et_filter}temp IS NOT NULL
            GROUP BY {grp()} ORDER BY ts
        """)
        result["temperature"] = [
            {"ts": r[0].isoformat(), "value": round(float(r[1]), 2)}
            for r in rows if r[0] and r[1] is not None
        ]
    else:
        result["temperature"] = []

    # --- Air quality (CO2 from AQ sensor) ------------------------------------
    if "co2" in schema:
        et_filter = "event_type = 'NORMAL_AQ' AND " if has_et else ""
        rows = run(f"""
            SELECT {bkt()} AS ts, AVG(co2) AS v
            FROM {table}
            WHERE {et_filter}co2 IS NOT NULL
            GROUP BY {grp()} ORDER BY ts
        """)
        result["airQuality"] = [
            {"ts": r[0].isoformat(), "value": round(float(r[1]), 1)}
            for r in rows if r[0] and r[1] is not None
        ]
    else:
        result["airQuality"] = []

    # --- Occupancy (running net entries − exits) ------------------------------
    if "entries" in schema and "exits" in schema:
        rows = run(f"""
            WITH running AS (
                SELECT timestamp,
                    GREATEST(0,
                        SUM(COALESCE(entries,0)) OVER (
                            ORDER BY timestamp, id
                            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) -
                        SUM(COALESCE(exits,0)) OVER (
                            ORDER BY timestamp, id
                            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
                    ) AS net_occ
                FROM {table}
            )
            SELECT {bkt('timestamp')} AS ts, MAX(net_occ) AS v
            FROM running
            GROUP BY {grp('timestamp')} ORDER BY ts
        """)
        result["occupancy"] = [
            {"ts": r[0].isoformat(), "value": int(r[1])}
            for r in rows if r[0] and r[1] is not None
        ]
    else:
        result["occupancy"] = []

    # --- Energy (average active power in kW, split by circuit) ---------------
    # Use AVG (not SUM) so the chart shows power level, not energy total.
    # Divide by 1000 to convert W → kW.
    if "total_act_power" in schema:
        et_filter = "event_type = 'NORMAL_EM' AND " if has_et else ""
        has_circuit = "circuit_id" in schema
        if has_circuit:
            rows = run(f"""
                SELECT
                    {bkt()} AS ts,
                    AVG(total_act_power) / 1000.0 AS total,
                    AVG(CASE WHEN circuit_id = '0'
                        THEN total_act_power END) / 1000.0 AS c0,
                    AVG(CASE WHEN circuit_id = '1'
                        THEN total_act_power END) / 1000.0 AS c1
                FROM {table}
                WHERE {et_filter}total_act_power IS NOT NULL
                GROUP BY {grp()} ORDER BY ts
            """)
            result["energy"] = [
                {
                    "ts": r[0].isoformat(),
                    "value":    round(float(r[1]), 3) if r[1] is not None else 0.0,
                    "circuit0": round(float(r[2]), 3) if r[2] is not None else 0.0,
                    "circuit1": round(float(r[3]), 3) if r[3] is not None else 0.0,
                }
                for r in rows if r[0] and r[1] is not None
            ]
        else:
            rows = run(f"""
                SELECT {bkt()} AS ts, AVG(total_act_power) / 1000.0 AS total
                FROM {table}
                WHERE {et_filter}total_act_power IS NOT NULL
                GROUP BY {grp()} ORDER BY ts
            """)
            result["energy"] = [
                {"ts": r[0].isoformat(),
                 "value":    round(float(r[1]), 3) if r[1] is not None else 0.0,
                 "circuit0": round(float(r[1]), 3) if r[1] is not None else 0.0,
                 "circuit1": 0.0}
                for r in rows if r[0] and r[1] is not None
            ]
    else:
        result["energy"] = []

    # --- Outdoor weather (DB column preferred; Open-Meteo archive as fallback) -
    if "outdoor_temp" in schema:
        rows = run(f"""
            SELECT {bkt()} AS ts, AVG(outdoor_temp) AS v
            FROM {table}
            WHERE outdoor_temp IS NOT NULL
            GROUP BY {grp()} ORDER BY ts
        """)
        result["weather"] = [
            {"ts": r[0].isoformat(), "value": round(float(r[1]), 1), "condition": "cloudy"}
            for r in rows if r[0] and r[1] is not None
        ]
    else:
        # No stored weather column — fetch historical data from Open-Meteo archive
        # for the same time span as the sensor data so the chart lines up.
        result["weather"] = []
        if ts_range and ts_range[0] and ts_range[1]:
            try:
                from core.weather_client import WeatherClient
                import math as _math
                wc = WeatherClient(55.8617, -4.2583)          # Glasgow (from bootstrap.py)
                start_str = ts_range[0].strftime("%Y-%m-%d")
                end_str   = ts_range[1].strftime("%Y-%m-%d")
                df = wc.get_historical_df(start_str, end_str)
                if not df.empty:
                    result["weather"] = [
                        {
                            "ts":        str(row["timestamp"].isoformat()),
                            "value":     round(float(row["outdoor_temp"]), 1),
                            "condition": str(row["weather_condition"]),
                        }
                        for _, row in df.iterrows()
                        if row["outdoor_temp"] is not None
                        and not _math.isnan(float(row["outdoor_temp"]))
                    ]
            except Exception as _exc:
                print(f"[timeseries] WeatherClient archive failed: {_exc}")

    return result


# ---- pythonDNM MPC / Forecast endpoints ------------------------------------

@app.get("/api/mpc/status", response_model=ForecastStatusResponse)
def mpc_status(request: Request):
    """
    Return ForecastService health: whether the ring buffer has enough history
    to produce forecasts and which feature models are loaded.
    """
    svc = getattr(request.app.state, "forecast", None)
    if svc is None:
        return ForecastStatusResponse(
            status="unavailable",
            reason=(
                "ForecastService not initialised. "
                "Artifacts may be missing — run training first."
            ),
        )
    return ForecastStatusResponse(
        status="ready" if svc.is_ready else "warming_up",
        buffer_size=svc.buffer_size,
        min_warm_rows=64,
        is_ready=svc.is_ready,
        loaded_features=svc.loaded_features(),
    )


@app.post("/api/mpc/tick", response_model=MpcTickResponse)
def mpc_tick(req: MpcTickRequest, request: Request):
    """
    Feed one 15-minute sensor row into the ForecastService, run the
    hierarchical MPC (OuterMPC 4h + InnerMPC 15m), and return the HVAC
    control action together with a summary of the forecast bundle.

    The buffer warms up after 64 ticks (~16 h).  Check ``warmed_up`` before
    acting on the ``action`` field.
    """
    svc = getattr(request.app.state, "forecast", None)
    if svc is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "ForecastService not initialised. "
                "Train models first: "
                "python -m equitwin_integration.train_all "
                "--db-url postgresql+psycopg2://... --table matches"
            ),
        )

    # Build sensor row dict (exclude temp_target — it's a state override, not a signal).
    sensor_row: Dict[str, Any] = req.model_dump(exclude={"temp_target"})

    # Build optional state override for InnerMPC comfort setpoint.
    state: Optional[Dict[str, Any]] = (
        {"temp_target": req.temp_target} if req.temp_target is not None else None
    )

    output = svc.tick(sensor_row, state=state)

    return MpcTickResponse(
        warmed_up=output.warmed_up,
        error=output.error,
        action=output.inner_action.u if output.inner_action else {},
        outer_plan=output.outer_plan.refs if output.outer_plan else {},
        bundle_summary=(
            svc.forecast_summary(output.bundle)
            if output.bundle and output.bundle.by_feature
            else {}
        ),
    )


@app.get("/api/forecast")
def get_forecast(request: Request):
    """
    Return the most recent ST + LT forecast bundle without ingesting a new row.
    Useful for polling from the frontend to display prediction charts.

    Returns ``status: "warming_up"`` until the buffer has ≥ 64 rows.
    """
    svc = getattr(request.app.state, "forecast", None)
    if svc is None:
        return {"status": "unavailable", "buffer_size": 0, "features": {}}

    bundle = svc.get_forecast()
    if bundle is None:
        return {
            "status": "warming_up",
            "buffer_size": svc.buffer_size,
            "min_warm_rows": 64,
            "features": {},
        }

    return {
        "status": "ready",
        "buffer_size": svc.buffer_size,
        "loaded_features": svc.loaded_features(),
        "features": svc.forecast_summary(bundle),
    }


# ---- WebSocket for live telemetry push --------------------------------------
@app.websocket("/telemetry/ws")
async def telemetry_ws(ws: WebSocket):
    await ws.accept()
    # In real life, subscribe to your broker; here we stream mock packets.
    import asyncio, datetime, random
    try:
      while True:
        msg = {
          "type": "energy",
          "payload": {
            "ts": datetime.datetime.utcnow().isoformat(),
            "powerKw": round(random.uniform(12, 18), 2),
            "hvacKw": round(random.uniform(5, 8), 2),
            "lightsKw": round(random.uniform(2, 4), 2),
            "zoneId": "Z-101"
          }
        }
        await ws.send_json(msg)
        await asyncio.sleep(2)
    except Exception:
      pass
