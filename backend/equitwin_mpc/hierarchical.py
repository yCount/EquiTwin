from __future__ import annotations
import math
from typing import Any, Dict, List, Optional

import numpy as np

from equitwin_forecasting.types import ForecastBundle
from equitwin_mpc.types import OuterPlan, InnerAction

# Solar adjustment constants:
#   offset (W) = (sunlight W/m² / 1000) * SOLAR_EFFICIENCY_FACTOR * 1000
#   i.e. 5% of solar irradiance translates to building load offset.
#   Conservative default — calibrate once real building data is available.
_SOLAR_THRESHOLD_WM2 = 200.0
_SOLAR_EFFICIENCY_FACTOR = 0.05


class OuterMPC:
    """Slow loop (4h). Produces references/constraints for the inner loop."""
    def __init__(self, lt_steps: List[int]):
        self.lt_steps = [int(x) for x in lt_steps]

    def solve(
        self,
        forecasts: ForecastBundle,
        state: Dict[str, Any],
        weather_forecast: Optional[List[Any]] = None,  # List[WeatherSnapshot] | None
    ) -> OuterPlan:
        """
        Compute 4-hour reference trajectories.

        Parameters
        ----------
        forecasts        : ForecastBundle from ForecastCoordinator.
        state            : Current system state dict.
        weather_forecast : Optional list of WeatherSnapshot objects (one per hour).
                           When provided:
                           - Adds ``outdoor_temp_ref_lt`` to refs.
                           - Reduces ``energy_budget_lt`` by a solar offset when
                             sunlight > 200 W/m² (passive solar heat gain proxy).
                           Pass None (default) for full backward compatibility.
        """
        # ── Base LT energy budget ─────────────────────────────────────────
        budget = None
        if "energy" in forecasts.by_feature:
            budget = {
                k: float(forecasts.by_feature["energy"].lt[k][0])
                for k in sorted(forecasts.by_feature["energy"].lt)
            }

        # ── Base LT temperature reference ─────────────────────────────────
        temp_ref = None
        if "temperature" in forecasts.by_feature:
            temp_ref = {
                k: float(forecasts.by_feature["temperature"].lt[k][0])
                for k in sorted(forecasts.by_feature["temperature"].lt)
            }

        refs: Dict[str, Any] = {
            "energy_budget_lt": budget,
            "temp_ref_lt": temp_ref,
        }

        # ── Weather-aware adjustments ─────────────────────────────────────
        if weather_forecast:
            # Map LT step (1-indexed) → WeatherSnapshot
            wf_by_step: Dict[int, Any] = {
                i + 1: snap for i, snap in enumerate(weather_forecast)
            }

            # outdoor_temp_ref_lt
            outdoor_ref: Dict[int, float] = {}
            for step, snap in sorted(wf_by_step.items()):
                t = snap.outdoor_temp
                if not (isinstance(t, float) and math.isnan(t)):
                    outdoor_ref[step] = t
            if outdoor_ref:
                refs["outdoor_temp_ref_lt"] = outdoor_ref

            # Solar-adjusted energy budget
            if budget is not None:
                adjusted: Dict[int, float] = {}
                for step, base_w in budget.items():
                    snap = wf_by_step.get(step)
                    if snap is not None:
                        sun = snap.sunlight
                        if (
                            isinstance(sun, float)
                            and not math.isnan(sun)
                            and sun > _SOLAR_THRESHOLD_WM2
                        ):
                            offset_w = (sun / 1000.0) * _SOLAR_EFFICIENCY_FACTOR * 1000.0
                            adjusted[step] = max(0.0, base_w - offset_w)
                        else:
                            adjusted[step] = base_w
                    else:
                        adjusted[step] = base_w
                refs["energy_budget_lt"] = adjusted

        return OuterPlan(refs=refs)

class InnerMPC:
    """Fast loop (15m). Uses ST forecasts + outer plan to compute immediate HVAC controls."""
    def __init__(self, st_steps: List[int]):
        self.st_steps = [int(x) for x in st_steps]

    def solve(self, forecasts: ForecastBundle, state: Dict[str, Any], outer: OuterPlan) -> InnerAction:
        # Skeleton control policy (replace with real optimizer):
        u = {
            "total_current": float(state.get("total_current", 0.0)),
            "total_act_power": float(state.get("total_act_power", 0.0)),
            "total_aprt_power": float(state.get("total_aprt_power", 0.0)),
        }

        info = {"note": "Skeleton. Replace with QP/NLP in EquiTwin. Uses 15m ST forecasts + 4h outer refs."}

        # Simple heuristic: use ST predicted temp at t+15m to adjust act_power
        if "temperature" in forecasts.by_feature:
            target = float(state.get("temp_target", 21.0))
            t1 = float(forecasts.by_feature["temperature"].st.get(1, np.array([state.get("temp", target)]))[0])
            err = target - t1
            u["total_act_power"] = max(0.0, u["total_act_power"] + 50.0 * err)

        return InnerAction(u=u, info=info)
