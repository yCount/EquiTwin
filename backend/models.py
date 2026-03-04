"""
Data Transfer Objects shared between app.py and the services layer.
Keeping them here breaks the circular import that arises when services/mpc.py
tries to import from app.py while app.py is still being loaded.
"""
from pydantic import BaseModel
from typing import Any, Dict, List, Optional


class EnergyPoint(BaseModel):
    ts: str; powerKw: float; hvacKw: float; lightsKw: float
    zoneId: Optional[str] = None

class AirPoint(BaseModel):
    ts: str; co2: float; voc: float; pm25: float; pm10: float; temp: float; rh: float
    zoneId: Optional[str] = None

class OccPoint(BaseModel):
    ts: str; people: int; zoneId: Optional[str] = None

class WeatherPoint(BaseModel):
    ts: str; tOut: float; ghi: float; wind: float; rhOut: float

class MpcRequest(BaseModel):
    window_minutes: int = 60
    energy: List[EnergyPoint]
    air: List[AirPoint]
    occ: List[OccPoint]
    weather: List[WeatherPoint]
    constraints: dict = {}
    objective_weights: dict = {"comfort": 1.0, "energy": 1.0, "smooth": 0.1}

class MpcSuggestion(BaseModel):
    ts: str; zoneId: str; setpointC: float; airflow: float; expectedPowerKw: float


# ---- pythonDNM MPC integration DTOs ----------------------------------------

class MpcTickRequest(BaseModel):
    """
    One 15-minute sensor row for POST /api/mpc/tick.

    "temp_target" is a state override (comfort setpoint) passed to InnerMPC.
    It is NOT written to the feature buffer.
    """
    timestamp: str
    sensor_id: Optional[str] = "1"
    temp_target: Optional[float] = None   # comfort setpoint override
    # Energy meter
    total_current: Optional[float] = None
    total_act_power: Optional[float] = None
    total_aprt_power: Optional[float] = None
    a_act_power: Optional[float] = None
    b_act_power: Optional[float] = None
    c_act_power: Optional[float] = None
    a_voltage: Optional[float] = None
    b_voltage: Optional[float] = None
    c_voltage: Optional[float] = None
    # Air quality
    temp: Optional[float] = None
    humidity: Optional[float] = None
    co2: Optional[float] = None
    voc: Optional[float] = None
    pm2p5: Optional[float] = None
    pm10: Optional[float] = None
    pm1: Optional[float] = None
    pm4: Optional[float] = None
    # Occupancy
    num_targets: Optional[float] = None
    entries: Optional[float] = None
    exits: Optional[float] = None


class MpcTickResponse(BaseModel):
    """Response from POST /api/mpc/tick."""
    warmed_up: bool
    error: Optional[str] = None
    action: Dict[str, Any] = {}       # InnerMPC u: {total_current, total_act_power, …}
    outer_plan: Dict[str, Any] = {}   # OuterMPC refs: {energy_budget_lt, temp_ref_lt, …}
    bundle_summary: Dict[str, Any] = {}  # {feature: {st: {h: val}, lt: {h: val}}}


class ForecastStatusResponse(BaseModel):
    """Response from GET /api/mpc/status."""
    status: str # "ready" | "warming_up" | "unavailable"
    buffer_size: int = 0
    min_warm_rows: int = 64
    is_ready: bool = False
    loaded_features: List[str] = []
    reason: Optional[str] = None
