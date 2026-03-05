"""
FastAPI entrypoint for Energy Management System.
- Exposes REST: /mpc/optimize, /forecast/energy, /kpis, /timeseries
- Exposes WebSocket: /telemetry/ws to push live EM/AQ/OC updates to frontend
Glues: services/* + adapters/* + security
"""

import asyncio
import json
import math
import os
import sys
from contextlib import asynccontextmanager
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
from core.dashboard_rows import (
    build_count_query,
    build_dashboard_rows_query,
    coerce_value,
    discover_table_columns,
)
from core.source_config import get_data_source_mode, get_synthetic_csv_path
from core.csv_source import (
    get_cached_db_rows_page_from_csv,
    get_cached_timeseries_from_csv,
)

# Lazy-initialised engine for the /api/db/rows viewer endpoint.
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
    mode = get_data_source_mode()
    if mode == "csv":
        csv_path = get_synthetic_csv_path()
        if not csv_path.exists():
            raise HTTPException(
                status_code=503,
                detail=f"CSV source mode enabled but file not found: {csv_path}",
            )
        try:
            return get_cached_db_rows_page_from_csv(csv_path, page=page, page_size=page_size)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"CSV source load failed: {exc}")

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
        # 1. Discover columns and compile the same engineered dashboard query
        # used by CSV export so both surfaces stay in sync.
        schema_cols = discover_table_columns(conn, table)
        if not schema_cols:
            raise HTTPException(status_code=404, detail=f"Table '{table}' has no visible columns.")

        # 2. Total row count
        total = int(conn.execute(build_count_query(table)).scalar() or 0)

        # 3. Page query
        data_sql, all_cols = build_dashboard_rows_query(
            table,
            schema_cols,
            with_limit=True,
            with_offset=True,
        )
        rows_res = conn.execute(data_sql, {"lim": page_size, "off": offset})

        rows = [
            {col: coerce_value(row[i]) for i, col in enumerate(all_cols)}
            for row in rows_res
        ]

    return {
        "rows": rows,
        "total": int(total),
        "page": page,
        "page_size": page_size,
        "total_pages": max(1, (int(total) + page_size - 1) // page_size),
        "columns": all_cols,
        "source_mode": "postgres",
    }

# ---- Dashboard time-series charts ------------------------------------------

@app.get("/api/db/timeseries")
def get_db_timeseries(table: str = "matches", bucket_minutes: int = 15):
    """
    Returns ALL available sensor time-series data bucketed by bucket_minutes.
    The frontend handles time-range filtering; this endpoint always returns
    the full history so the timeline slider works correctly.

    Metrics returned:
      temperature  : indoor temp from NORMAL_AQ rows (°C)
      airQuality   : CO2 from NORMAL_AQ rows (ppm)
      occupancy    : cumulative net occupancy (entries - exits, ≥ 0)
      energy       : total active power from NORMAL_EM rows (W)
      weather      : outdoor_temp as the WeatherClient logged it (°C)
    """
    mode = get_data_source_mode()
    if mode == "csv":
        csv_path = get_synthetic_csv_path()
        if not csv_path.exists():
            raise HTTPException(
                status_code=503,
                detail=f"CSV source mode enabled but file not found: {csv_path}",
            )
        try:
            return get_cached_timeseries_from_csv(csv_path)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"CSV source load failed: {exc}")

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

    if span_secs <= 7_200:        bucket_secs = 60       # ≤ 2 h  => 1-min
    elif span_secs <= 43_200:     bucket_secs = 300      # ≤ 12 h => 5-min
    elif span_secs <= 172_800:    bucket_secs = 900      # ≤ 48 h => 15-min
    elif span_secs <= 604_800:    bucket_secs = 3_600    # ≤ 7 d  => 1-hr
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

    # Occupancy (running net entries − exits, reset each calendar day)
    if "entries" in schema and "exits" in schema:
        _occ_ev = (
            "event_type IN ('NO_MOVEMENT','EXIT_DETECTED','ENTRY_DETECTED','MOVEMENT_DETECTED') AND "
            if has_et else ""
        )
        rows = run(f"""
            WITH running AS (
                SELECT timestamp,
                    GREATEST(0,
                        SUM(COALESCE(entries,0)) OVER (
                            PARTITION BY DATE_TRUNC('day', timestamp)
                            ORDER BY timestamp, id
                            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) -
                        SUM(COALESCE(exits,0)) OVER (
                            PARTITION BY DATE_TRUNC('day', timestamp)
                            ORDER BY timestamp, id
                            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
                    ) AS net_occ
                FROM {table}
                WHERE {_occ_ev}(entries IS NOT NULL OR exits IS NOT NULL)
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
    # Divide by 1000 to convert W to kW.
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
        # No stored weather column; fetch historical data from Open-Meteo archive
        # for the same time span as the sensor data so the chart lines up.
        result["weather"] = []
        if ts_range and ts_range[0] and ts_range[1]:
            try:
                from core.weather_client import WeatherClient
                import math as _math
                wc = WeatherClient(55.8617, -4.2583)          # Glasgow (also see bootstrap.py)
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

    result["source_mode"] = "postgres"
    return result


# ---- Forecast endpoints ------------------------------------

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
    acting on the "action" field.
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

    # Build sensor row dict (exclude temp_target - it's a state override, not a signal).
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


# ---- Building simulation WebSocket -----------------------------------------

@app.websocket("/simulation/ws")
async def simulation_ws(ws: WebSocket):
    """
    Stream a closed-loop digital-twin simulation tick-by-tick.

    Protocol
    --------
    Client -> server:
        {"type": "start", "config": {setpoint, nightSetpoint, nOccupants,
                                      ticks, initTemp, speed, startHour}}
        {"type": "stop"}

    Server -> client:
        {"type": "started",  "ticks": int, "has_mpc": bool}
        {"type": "tick",     ...per-tick data...}
        {"type": "complete", ...summary...}
        {"type": "stopped"}
        {"type": "error",    "message": str}
    """
    await ws.accept()

    try:
        # --- Phase 1: wait for "start" (exclusive receive, no background task yet)
        start_msg = await ws.receive_json()
        if start_msg.get("type") != "start":
            await ws.close()
            return

        cfg         = start_msg.get("config", {})
        ticks       = int(cfg.get("ticks",        96))
        speed       = float(cfg.get("speed",       0.1))
        setpoint    = float(cfg.get("setpoint",    21.0))
        night_sp    = float(cfg.get("nightSetpoint", 15.0))
        n_occ       = int(cfg.get("nOccupants",    10))
        init_temp   = float(cfg.get("initTemp",    14.0))
        start_hour  = float(cfg.get("startHour",   0.0))

        # --- Import simulation helpers (inside the handler to avoid module-level cost)
        from simulate_house import (
            HouseState, ScheduleConfig, get_building_mode,
            commercial_occupancy_at, synthetic_weather, mode_hvac,
            BASE_LOAD_W, _BMODE_LABEL,
        )
        import pandas as pd

        schedule = ScheduleConfig(
            work_setpoint=setpoint,
            night_setpoint=night_sp,
            n_occupants=n_occ,
        )
        house    = HouseState(indoor_temp=init_temp, co2=450.0, humidity=40.0)
        sim_start = pd.Timestamp("2025-06-01", tz="UTC") + pd.Timedelta(hours=start_hour)

        # --- Try building the EquiTwin ML stack (fallback if no artifacts)
        runner   = None
        has_mpc  = False
        try:
            from equitwin_integration.bootstrap import EquiTwinConfig, build_equitwin_stack
            from equitwin_integration.tick_runner import TickRunner, TickRunnerConfig
            _arts = os.path.join(os.path.dirname(os.path.abspath(__file__)), "artifacts")
            _stack = build_equitwin_stack(EquiTwinConfig(artifacts_root=_arts))
            if _stack.predictors:          # only wire MPC if models are loaded
                runner  = TickRunner(
                    _stack,
                    TickRunnerConfig(group_id="1", temp_target=setpoint, min_warm_rows=70),
                    weather_client=_stack.weather_client,
                )
                has_mpc = True
        except FileNotFoundError:
            pass   # no artifacts — simulation runs as a pure proportional thermostat

        await ws.send_json({"type": "started", "ticks": ticks, "has_mpc": has_mpc})

        # --- Phase 2: background task listens for "stop"; main loop runs the sim
        stop_event = asyncio.Event()

        async def _recv_loop():
            try:
                while True:
                    msg = await ws.receive_json()
                    if msg.get("type") == "stop":
                        stop_event.set()
                        break
            except Exception:
                stop_event.set()

        recv_task = asyncio.create_task(_recv_loop())
        mpc_tick_count = 0

        try:
            for tick in range(ticks):
                if stop_event.is_set():
                    await ws.send_json({"type": "stopped"})
                    return

                sim_ts = sim_start + pd.Timedelta(minutes=15 * tick)

                b_mode, sp, band, max_hvac_w, heating_only = get_building_mode(
                    tick, start_hour, schedule)
                n_people, entries, exits = commercial_occupancy_at(
                    tick, start_hour, schedule)
                t_out, weather_cond, sunlight = synthetic_weather(tick)

                sensor_row = house.to_sensor_row(
                    timestamp=sim_ts,
                    sensor_id="1",
                    outdoor_temp=t_out,
                    weather_condition=weather_cond,
                    sunlight=sunlight,
                    n_people=n_people,
                    entries=entries,
                    exits=exits,
                )

                output = None
                if runner is not None:
                    output = runner.tick(
                        sensor_row=sensor_row,
                        state={
                            "temp_target":     sp,
                            "temp":            house.indoor_temp,
                            "total_act_power": house.hvac_power_w + BASE_LOAD_W,
                        },
                    )

                hvac_w     = mode_hvac(house.indoor_temp, sp, band, max_hvac_w, heating_only)
                mpc_active = output is not None and output.warmed_up and output.error is None
                if mpc_active:
                    mpc_tick_count += 1

                tick_data: dict = {
                    "type":               "tick",
                    "tick":               tick,
                    "total_ticks":        ticks,
                    "sim_time":           sim_ts.isoformat(),
                    "mode":               _BMODE_LABEL.get(b_mode, str(b_mode)).strip(),
                    "mpc_active":         mpc_active,
                    "warming_up":         output is not None and not output.warmed_up,
                    "indoor_temp":        round(house.indoor_temp, 1),
                    "outdoor_temp":       round(t_out, 1),
                    "setpoint":           round(sp, 1),
                    "co2":                round(house.co2),
                    "humidity":           round(house.humidity, 1),
                    "n_people":           int(n_people),
                    "hvac_w":             round(hvac_w),
                    "cumulative_kwh":     round(house.cumulative_kwh, 2),
                    "forecast_energy_st1": None,
                    "energy_budget_lt":   None,
                    "temp_ref_lt":        None,
                    "error":              output.error if output else None,
                }

                if mpc_active and output:
                    eb = output.bundle.by_feature.get("energy") if output.bundle else None
                    if eb and 1 in eb.st:
                        tick_data["forecast_energy_st1"] = round(float(eb.st[1][0]))
                    refs = output.outer_plan.refs if output.outer_plan else {}
                    if refs.get("energy_budget_lt"):
                        tick_data["energy_budget_lt"] = {
                            str(k): round(float(v)) for k, v in refs["energy_budget_lt"].items()
                        }
                    if refs.get("temp_ref_lt"):
                        tick_data["temp_ref_lt"] = {
                            str(k): round(float(v), 1) for k, v in refs["temp_ref_lt"].items()
                        }

                await ws.send_json(tick_data)

                # Advance physics AFTER sending so tick 0 shows the initial state
                house.step(
                    hvac_w=hvac_w, outdoor_temp=t_out,
                    n_people=n_people, temp_target=sp,
                )

                if speed > 0:
                    await asyncio.sleep(speed)

            # Simulation completed normally
            await ws.send_json({
                "type":          "complete",
                "final_temp":    round(house.indoor_temp, 1),
                "final_co2":     round(house.co2),
                "final_humidity": round(house.humidity, 1),
                "total_kwh":     round(house.cumulative_kwh, 2),
                "mpc_ticks":     mpc_tick_count,
                "total_ticks":   ticks,
            })

        finally:
            recv_task.cancel()
            try:
                await recv_task
            except asyncio.CancelledError:
                pass

    except Exception as exc:
        try:
            await ws.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass


# ---- Artifacts status --------------------------------------------------------

_KNOWN_FEATURES = ["energy", "temperature", "airquality", "occupancy"]


@app.get("/api/artifacts/status")
def artifacts_status():
    """
    Walk the artifacts directory and return rich per-feature training metadata.

    Response shape per feature:
      st / lt : { "<horizon>": { model, mae, rmse, r2, mase, n_rows, quantile? } }
      all_models_st / all_models_lt : rows from metrics_<level>.csv (full comparison)
      multioutput : { st?: { per_horizon_mae }, lt?: { ... } }
      n_rows : total training rows (from first available horizon)
    """
    import csv as _csv

    arts_root = os.environ.get(
        "ARTIFACTS_ROOT",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "artifacts"),
    )

    def _safe(v):
        if v is None:
            return None
        try:
            if math.isnan(v) or math.isinf(v):
                return None
        except TypeError:
            pass
        return v

    def _read_metrics_csv(path: str):
        """Read a metrics CSV and return list of row dicts with safe numeric values."""
        rows = []
        if not os.path.exists(path):
            return rows
        try:
            with open(path, newline="", encoding="utf-8") as fh:
                for r in _csv.DictReader(fh):
                    rows.append({
                        "model":      r.get("model", ""),
                        "horizon":    _safe(int(r["horizon"])) if r.get("horizon") else None,
                        "mae":        _safe(float(r["mae"]))   if r.get("mae")     else None,
                        "rmse":       _safe(float(r["rmse"]))  if r.get("rmse")    else None,
                        "r2":         _safe(float(r["r2"]))    if r.get("r2")      else None,
                        "mase":       _safe(float(r["mase"]))  if r.get("mase")    else None,
                        "n_folds":    int(r["n_folds"])        if r.get("n_folds") else None,
                        "level":      r.get("level", ""),
                    })
        except Exception:
            pass
        return rows

    result: Dict[str, Any] = {}
    for feature in _KNOWN_FEATURES:
        feat_root  = os.path.join(arts_root, feature)
        best_dir   = os.path.join(feat_root, "best")
        q_dir      = os.path.join(feat_root, "quantile")
        mo_dir     = os.path.join(feat_root, "multioutput")

        feature_data: Dict[str, Any] = {
            "st": {}, "lt": {},
            "all_models_st": [], "all_models_lt": [],
            "multioutput": {},
            "n_rows": None,
        }

        # ── best models per horizon ───────────────────────────────────────────
        if os.path.isdir(best_dir):
            for entry in sorted(os.listdir(best_dir)):
                if "_h" not in entry:
                    continue
                parts = entry.split("_h", 1)
                if len(parts) != 2:
                    continue
                level, h_str = parts
                if level not in ("st", "lt"):
                    continue
                meta_path = os.path.join(best_dir, entry, "metadata.json")
                if not os.path.exists(meta_path):
                    continue
                try:
                    with open(meta_path) as fh:
                        raw = json.load(fh)
                    horizon_data: Dict[str, Any] = {
                        "model":  raw.get("model"),
                        "mae":    _safe(raw.get("mae")),
                        "rmse":   _safe(raw.get("rmse")),
                        "r2":     _safe(raw.get("r2")),
                        "mase":   _safe(raw.get("mase")),
                        "n_rows": raw.get("n_rows"),
                    }
                    feature_data[level][h_str] = horizon_data
                    if feature_data["n_rows"] is None:
                        feature_data["n_rows"] = raw.get("n_rows")
                except Exception:
                    pass

        # ── quantile coverage / sharpness per horizon ─────────────────────────
        if os.path.isdir(q_dir):
            for entry in os.listdir(q_dir):
                # names like  st_h1_q90  st_h1_lgbm_q50  lt_h3_q10
                meta_path = os.path.join(q_dir, entry, "metadata.json")
                if not os.path.exists(meta_path):
                    continue
                try:
                    with open(meta_path) as fh:
                        raw = json.load(fh)
                    # Parse level and horizon from entry name  e.g. st_h1_q90
                    parts = entry.split("_h", 1)
                    if len(parts) != 2:
                        continue
                    level = parts[0]
                    rest = parts[1]          # "1_q90" or "1_lgbm_q50"
                    h_str = rest.split("_")[0]
                    qtag  = raw.get("quantile_tag", "")
                    if level not in ("st", "lt") or h_str not in feature_data[level]:
                        continue
                    # Attach coverage/sharpness once per horizon (use q90 as canonical)
                    if "quantile" not in feature_data[level][h_str]:
                        feature_data[level][h_str]["quantile"] = {}
                    cov = _safe(raw.get("coverage"))
                    sha = _safe(raw.get("sharpness"))
                    if cov is not None:
                        feature_data[level][h_str]["quantile"]["coverage"]  = cov
                        feature_data[level][h_str]["quantile"]["sharpness"] = sha
                except Exception:
                    pass

        # ── full model comparison tables (all models × all horizons) ──────────
        feature_data["all_models_st"] = _read_metrics_csv(
            os.path.join(feat_root, "metrics_st.csv")
        )
        feature_data["all_models_lt"] = _read_metrics_csv(
            os.path.join(feat_root, "metrics_lt.csv")
        )

        # ── multi-output summary ──────────────────────────────────────────────
        if os.path.isdir(mo_dir):
            for entry in os.listdir(mo_dir):
                # names like  st_all_horizons  lt_all_horizons
                meta_path = os.path.join(mo_dir, entry, "metadata.json")
                if not os.path.exists(meta_path):
                    continue
                try:
                    with open(meta_path) as fh:
                        raw = json.load(fh)
                    level = raw.get("level", entry.split("_")[0])
                    if level in ("st", "lt"):
                        feature_data["multioutput"][level] = {
                            "base_model": raw.get("base_model"),
                            "per_horizon_mae": raw.get("per_horizon_mae", {}),
                        }
                except Exception:
                    pass

        result[feature] = feature_data

    return result


# ---- Training WebSocket ------------------------------------------------------

@app.websocket("/training/ws")
async def training_ws(ws: WebSocket):
    """
    Stream a training run (equitwin_integration.train_all) tick-by-tick.

    Protocol
    --------
    Client -> server:
        {"type": "start", "mode": "fast"|"normal"|"full",
         "features": [...], "table": "matches"}
        {"type": "stop"}

    Server -> client:
        {"type": "started",       "mode": str, "features": [...]}
        {"type": "log",           "line": str,
         "feature_start": str|null, "feature_done": str|null}
        {"type": "complete",      "success": bool, "returncode": int}
        {"type": "stopped"}
        {"type": "error",         "message": str}

    Implementation note: uses subprocess.Popen + threading.Thread instead of
    asyncio.create_subprocess_exec to avoid Windows SelectorEventLoop limitations.
    """
    import subprocess as _sp
    import threading

    await ws.accept()

    try:
        # Phase 1: wait for "start"
        start_msg = await ws.receive_json()
        if start_msg.get("type") != "start":
            await ws.close()
            return

        mode     = start_msg.get("mode", "fast")
        features = start_msg.get("features") or _KNOWN_FEATURES
        table    = start_msg.get("table", "matches")

        source_mode = get_data_source_mode()
        db_url = os.environ.get("DATABASE_URL")
        if source_mode == "postgres" and not db_url:
            await ws.send_json({
                "type":    "error",
                "message": "DATABASE_URL env var not set - cannot run training in postgres mode.",
            })
            return
        if source_mode == "csv" and not db_url:
            db_url = "csv://local"

        backend_dir = os.path.dirname(os.path.abspath(__file__))

        cmd: List[str] = [
            sys.executable, "-u", "-m", "equitwin_integration.train_all",
            "--db-url", db_url,
            "--table", table,
            "--mode",  mode,
            "--features", *features,
        ]

        await ws.send_json({
            "type": "started",
            "mode": mode,
            "features": features,
            "source_mode": source_mode,
        })

        # Phase 2: Popen + reader thread + asyncio Queue
        stop_flag = threading.Event()
        line_queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_event_loop()

        async def _recv_loop():
            try:
                while True:
                    msg = await ws.receive_json()
                    if msg.get("type") == "stop":
                        stop_flag.set()
                        break
            except Exception:
                stop_flag.set()

        recv_task = asyncio.create_task(_recv_loop())

        def _reader_thread(proc: "_sp.Popen[bytes]") -> None:
            """Read stdout lines from proc and push them to line_queue via the event loop."""
            try:
                for raw_line in proc.stdout:  # type: ignore[union-attr]
                    if stop_flag.is_set():
                        proc.kill()
                        asyncio.run_coroutine_threadsafe(
                            line_queue.put(("stopped", None)), loop
                        )
                        return
                    line = raw_line.decode("utf-8", errors="replace").rstrip()
                    asyncio.run_coroutine_threadsafe(
                        line_queue.put(("line", line)), loop
                    )
                proc.wait()
                asyncio.run_coroutine_threadsafe(
                    line_queue.put(("done", proc.returncode)), loop
                )
            except Exception as exc:
                asyncio.run_coroutine_threadsafe(
                    line_queue.put(("error", str(exc))), loop
                )

        try:
            proc = _sp.Popen(
                cmd,
                stdout=_sp.PIPE,
                stderr=_sp.STDOUT,
                cwd=backend_dir,
            )
        except Exception as exc:
            await ws.send_json({"type": "error", "message": f"Failed to start training: {exc}"})
            recv_task.cancel()
            return

        t = threading.Thread(target=_reader_thread, args=(proc,), daemon=True)
        t.start()

        try:
            while True:
                kind, payload = await line_queue.get()

                if kind == "line":
                    import re as _re
                    line = payload
                    msg_out: Dict[str, Any] = {
                        "type": "log", "line": line,
                        "feature_start": None, "feature_done": None,
                        "current_level": None,    # "st" | "lt"
                        "current_model": None,    # model name being evaluated
                        "current_horizon": None,  # int
                        "current_step": None,     # "model" | "quantile" | "multioutput"
                    }
                    stripped = line.strip()
                    for fname in _KNOWN_FEATURES:
                        if stripped == f"--- {fname.upper()} ---":
                            msg_out["feature_start"] = fname
                        if stripped == f"{fname} done.":
                            msg_out["feature_done"] = fname
                    # Parse structured [TAG] DATA progress lines
                    m = _re.match(r"^\[(\w+)\]\s+(.*)", stripped)
                    if m:
                        tag, data = m.group(1), m.group(2).strip()
                        parts = data.split()
                        if tag == "level" and len(parts) >= 1 and parts[0] in ("st", "lt"):
                            msg_out["current_level"] = parts[0]
                            msg_out["current_step"]  = "model"
                        elif tag == "model" and len(parts) >= 2:
                            msg_out["current_model"] = parts[0]
                            h_part = parts[1]
                            if h_part.startswith("h") and h_part[1:].isdigit():
                                msg_out["current_horizon"] = int(h_part[1:])
                            msg_out["current_step"] = "model"
                        elif tag == "quantile":
                            msg_out["current_step"] = "quantile"
                        elif tag == "multioutput":
                            msg_out["current_step"] = "multioutput"
                    await ws.send_json(msg_out)

                elif kind == "done":
                    returncode = payload
                    success = (returncode == 0)
                    await ws.send_json({
                        "type": "complete", "success": success, "returncode": returncode,
                    })
                    break

                elif kind == "stopped":
                    await ws.send_json({"type": "stopped"})
                    break

                elif kind == "error":
                    await ws.send_json({"type": "error", "message": payload or "Unknown error"})
                    break

        finally:
            stop_flag.set()
            recv_task.cancel()
            try:
                await recv_task
            except asyncio.CancelledError:
                pass

    except Exception as exc:
        try:
            await ws.send_json({"type": "error", "message": str(exc) or repr(exc)})
        except Exception:
            pass


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
