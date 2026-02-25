"""
Pydantic DTOs shared between app.py and the services layer.
Keeping them here breaks the circular import that arises when services/mpc.py
tries to import from app.py while app.py is still being loaded.
"""
from pydantic import BaseModel
from typing import List, Optional


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
