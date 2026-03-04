"""
Forecast-then-Optimise core. Consumes the recent data window, constraints, and weights; returns optimal setpoints.

"""

from typing import List
from models import MpcRequest, MpcSuggestion

def run_mpc(req: MpcRequest) -> List[MpcSuggestion]:
    # Replace with your optimizer call; here we return “nudge to 21.5C”
    last_ts = req.energy[-1].ts if req.energy else req.weather[-1].ts
    by_zone = set([p.zoneId for p in req.energy if p.zoneId])
    suggestions = []
    for z in (by_zone or {"DEFAULT"}):
        suggestions.append(MpcSuggestion(
            ts=last_ts, zoneId=z, setpointC=21.5, airflow=0.8, expectedPowerKw=7.8
        ))
    return suggestions
