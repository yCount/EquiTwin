"""
High-level tick runner that EquiTwin's control loop calls once every 15 minutes.

It takes a raw sensor row dict, feeds it into the feature buffers, requests
forecasts from the coordinator, runs the hierarchical MPC, and returns a
ControlOutput with the HVAC setpoints and full forecast context.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from equitwin_forecasting.types import ForecastBundle
from equitwin_mpc.hierarchical import InnerMPC, OuterMPC
from equitwin_mpc.types import InnerAction, OuterPlan

from equitwin_integration.bootstrap import EquiTwinConfig, EquiTwinStack

_DT_H = 15.0 / 60.0   # 0.25 h per tick
_BLOCK_TICKS = 16      # 16 x 15 min = 4 h outer block
_BASE_LOAD_W = 380.0   # must stay in sync with equitwin_mpc/hierarchical.py

# Config

@dataclass
class TickRunnerConfig:
    """
    Tuning knobs for the tick runner.

    group_id      : sensor_id to use when pulling forecasts (single-zone default).
    temp_target   : Default comfort temperature setpoint [°C]. Can be overridden
                    per tick via the 'state' dict.
    min_warm_rows : Deprecated compatibility field.
    """
    group_id: str = "1"
    temp_target: float = 21.0
    min_warm_rows: int = 1

# Output

@dataclass
class ControlOutput:
    """Result returned by TickRunner.tick()."""
    inner_action: InnerAction
    outer_plan: OuterPlan
    bundle: ForecastBundle
    warmed_up: bool = True
    error: Optional[str] = None


# Runner

class TickRunner:
    """
    Stateful tick runner.  Create once, call tick() on every 15-minute reading.
    """

    def __init__(
        self,
        stack: EquiTwinStack,
        cfg: Optional[TickRunnerConfig] = None,
        weather_client: Optional[Any] = None,
    ) -> None:
        self.stack = stack
        self.cfg = cfg or TickRunnerConfig(
            group_id=stack.cfg.default_group_id,
        )
        # Prefer explicit override, then fall back to what the stack already holds.
        self._weather_client = weather_client or getattr(stack, "weather_client", None)

        hz = stack.hz
        self._outer_mpc = OuterMPC(lt_steps=hz.lt_horizons)
        self._inner_mpc = InnerMPC(
            st_steps=hz.st_horizons,
            control_horizon_steps=max(_BLOCK_TICKS, max(hz.st_horizons)),
        )
        self._tick_count: int = 0
        # Bug 1 fix: 4h block energy tracking
        self._steps_in_block: int = 0
        self._block_energy_consumed_wh: float = 0.0

    # Public API

    def tick(
        self,
        sensor_row: Dict[str, Any],
        state: Optional[Dict[str, Any]] = None,
    ) -> ControlOutput:
        """
        Process one 15-minute sensor reading and return control outputs.

        Parameters
        ----------
        sensor_row : Raw sensor dict. Must contain at least 'timestamp' and
                     ``sensor_id`` (or whatever group_col is configured).
                     All signal columns that are missing will be treated as NaN.
        state      : Current system state passed to the MPC solvers.  Common keys:
                         "temp_target" - comfort setpoint [°C]
                         "temp"        - current measured temperature
                         "total_act_power" - current active power [W]
                     If omitted, values are pulled from sensor_row where available.

        Returns
        -------
        ControlOutput
        """
        # 1. Enrich row with current weather, then feed the buffer
        enriched_row = _enrich_with_weather(sensor_row, self._weather_client)
        self.stack.ingest(enriched_row)
        self._tick_count += 1

        # 2. Build effective state (merge sensor_row + explicit state overrides)
        eff_state = _build_state(enriched_row, state, self.cfg)

        # 3. Forecast
        try:
            bundle = self.stack.coordinator.forecast_now(self.cfg.group_id)
        except Exception as exc:
            return ControlOutput(
                inner_action=InnerAction(u={}, info={}),
                outer_plan=OuterPlan(refs={}),
                bundle=ForecastBundle(by_feature={}),
                warmed_up=False,
                error=f"Forecast failed: {exc}",
            )

        # 4. MPC
        try:
            weather_forecast = None
            if self._weather_client is not None:
                weather_forecast = self._weather_client.get_forecast(hours=24)
            outer_plan = self._outer_mpc.solve(bundle, eff_state, weather_forecast=weather_forecast)

            # Bug fix: compute remaining HVAC+vent energy budget for the current block.
            energy_budget_lt = outer_plan.refs.get("energy_budget_lt") or {}
            if energy_budget_lt and 1 in energy_budget_lt:
                hvac_avg_w = max(0.0, float(energy_budget_lt[1]) - _BASE_LOAD_W)
                block_budget_wh = hvac_avg_w * 4.0  # HVAC-only avg × 4h
                remaining_wh = max(0.0, block_budget_wh - self._block_energy_consumed_wh)
                eff_state["remaining_energy_budget_wh"] = remaining_wh

            eff_state["outer_block_phase"] = self._steps_in_block
            inner_action = self._inner_mpc.solve(bundle, eff_state, outer_plan)

            # Bug fix: accumulate energy consumed; reset counter at block boundary.
            hvac_w = float(inner_action.u.get("hvac_power_w", 0.0))
            vent_w = float(inner_action.u.get("vent_fan_w", 0.0))
            self._block_energy_consumed_wh += (hvac_w + vent_w) * _DT_H
            self._steps_in_block += 1
            if self._steps_in_block >= _BLOCK_TICKS:
                self._steps_in_block = 0
                self._block_energy_consumed_wh = 0.0

        except Exception as exc:
            return ControlOutput(
                inner_action=InnerAction(u={}, info={}),
                outer_plan=OuterPlan(refs={}),
                bundle=bundle,
                warmed_up=True,
                error=f"MPC failed: {exc}",
            )

        return ControlOutput(
            inner_action=inner_action,
            outer_plan=outer_plan,
            bundle=bundle,
            warmed_up=True,
        )

    @property
    def tick_count(self) -> int:
        """How many ticks have been processed so far."""
        return self._tick_count


# Helpers

def _enrich_with_weather(
    sensor_row: Dict[str, Any],
    weather_client: Optional[Any],
) -> Dict[str, Any]:
    """
    Return a copy of sensor_row with current weather values merged in.

    Calls weather_client.get_current() (15-min cached) to obtain outdoor_temp,
    weather_condition, and sunlight.

    If weather_client is None or the call raises, NaN / "cloudy" defaults are
    used — the buffer stores them and the sklearn SimpleImputer absorbs them.
    """
    row = dict(sensor_row)   # shallow copy — never mutate caller's dict

    if weather_client is None:
        row.setdefault("outdoor_temp", float("nan"))
        row.setdefault("weather_condition", float("nan"))
        row.setdefault("sunlight", float("nan"))
        return row

    try:
        snap = weather_client.get_current()
        row["outdoor_temp"] = snap.outdoor_temp
        row["weather_condition"] = snap.weather_condition
        row["sunlight"] = snap.sunlight
    except Exception:
        row.setdefault("outdoor_temp", float("nan"))
        row.setdefault("weather_condition", float("nan"))
        row.setdefault("sunlight", float("nan"))

    return row


def _build_state(
    sensor_row: Dict[str, Any],
    override: Optional[Dict[str, Any]],
    cfg: TickRunnerConfig,
) -> Dict[str, Any]:
    """Merge sensor row into state dict, then apply explicit overrides."""
    passthrough_keys = {
        "total_act_power", "total_current", "total_aprt_power",
        "temp", "co2", "humidity", "num_targets", "outdoor_temp", "sunlight",
    }
    state: Dict[str, Any] = {"temp_target": cfg.temp_target}
    for k in passthrough_keys:
        if k in sensor_row and sensor_row[k] is not None:
            state[k] = float(sensor_row[k])
    if override:
        state.update(override)
    return state
