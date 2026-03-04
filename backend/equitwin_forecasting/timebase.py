from __future__ import annotations
from dataclasses import dataclass
from typing import List

@dataclass(frozen=True)
class TimeBase:
    name: str
    step_minutes: int

ST_15M = TimeBase("st_15m", step_minutes=15)
LT_4H  = TimeBase("lt_4h", step_minutes=240)

@dataclass(frozen=True)
class HorizonConfig:
    # ST horizons are in 15-minute steps; LT horizons are in 4-hour steps.
    st_horizons: List[int]
    lt_horizons: List[int]

def default_horizons() -> HorizonConfig:
    # Reasonable defaults:
    # - Inner MPC: ~2 hours ahead at 15-min resolution -> 8 steps
    # - Outer MPC: 24 hours ahead at 4-hour resolution -> 6 steps
    return HorizonConfig(
        st_horizons=[1,2,3,4,6,8],
        lt_horizons=[1,2,3,4,5,6],
    )
