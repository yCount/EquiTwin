from __future__ import annotations
import math
from typing import Any, Dict, List, Optional

import numpy as np

try:
    from scipy.optimize import minimize, Bounds, LinearConstraint
    _HAS_SCIPY = True
except ImportError:
    _HAS_SCIPY = False

from equitwin_forecasting.types import ForecastBundle
from equitwin_mpc.types import OuterPlan, InnerAction

# Physical constants — must stay in sync with simulate_house.py
_DT_H        = 15.0 / 60.0           # 0.25 h per 15-min step
_TAU_H       = 3.0                    # building thermal time-constant [h]
_A           = 1.0 - _DT_H / _TAU_H  # ≈ 0.9167  discrete-time thermal pole
_B_HEAT      = 3.2  * _DT_H / 800.0  # ≈ 0.001   °C per W per step (heating)
_B_COOL      = 2.6  * _DT_H / 800.0  # ≈ 0.000813 °C per W per step (cooling)
_HVAC_MAX_W  = 2500.0                 # maximum HVAC electrical input [W]
_HVAC_MIN_W  = 80.0                   # standby / fan-only draw [W]
_BASE_LOAD_W = 380.0                  # always-on base load [W]
_META_W_PPL  = 70.0                   # metabolic heat per occupant [W]
_BASE_LOAD_HEAT_FRAC = 0.55           # share of internal electric load that warms the zone
_SOLAR_GAIN_W_PER_WM2 = 0.12          # lumped solar heat gain [W] per W/m² sunlight

# Solar correction constants
_SOLAR_THRESHOLD_WM2     = 200.0
_SOLAR_EFFICIENCY_FACTOR = _SOLAR_GAIN_W_PER_WM2

# Comfort / setpoint scheduling
_T_ECONOMY      = 17.0   # economy setpoint when building is unoccupied [°C]
_PREHEAT_STEPS  = 6      # 15-min steps (90 min) of pre-conditioning before occupancy
_N_OCC_THRESH   = 0.5    # people count threshold to treat a step as "occupied"

# ---------------------------------------------------------------------------
# v[k] is a dimensionless fraction: 0 = closed, VENT_MAX_FRAC = full fresh-air rate
_CO2_OUTDOOR    = 420.0                           # outdoor CO2 baseline [ppm]
_CO2_REF        = 800.0                           # default CO2 reference / target [ppm]
_VENT_BASE_FRAC = 1 - math.exp(-15 / 120)         # standby ventilation fraction ≈ 0.117
_VENT_MAX_FRAC  = 0.40                            # maximum ventilation fraction at full fan
_VENT_FAN_W     = 200.0                           # electrical draw at max ventilation [W]
_A_CO2          = 1.0 - _VENT_BASE_FRAC           # CO2 decay pole ≈ 0.883
_OUTER_BLOCK_STEPS = 16                           # 4h / 15min = 16 inner steps

# QP cost weights  (2D state-space: temperature + CO2)
# _W_COMFORT  — temperature error weight, scaled per-step by occupancy Q_T[k]
# _W_AIRQUAL  — CO2 error weight (ppm² scale)
# _W_ENERGY   — linear electricity cost per Wh (heating + ventilation fan)
# _W_SMOOTH   — actuator rate-of-change penalty (Δu² + Δv²)
# ---------------------------------------------------------------------------
_W_COMFORT    = 120.0   # temperature tracking weight (× Q_T[k] occupancy scale)
_W_AIRQUAL    = 0.08    # CO2 tracking weight
_W_ENERGY     = 0.075   # linear energy cost [per Wh]
_W_SMOOTH     = 2e-4    # actuator smoothness penalty (raised from 5e-5 to dampen oscillation)
_T_ML_BLEND_NEAR = 0.35  # trust physics more on the next few steps
_T_ML_BLEND_FAR  = 0.70  # trust ML more deeper into the horizon
_T_OBSERVER_GAIN = 0.55  # partial disturbance correction to avoid tick-to-tick zigzag
_T_OBSERVER_CLIP = 2.0   # hard clamp on innovation magnitude [°C]

# Per-step occupancy scaling for temperature comfort weight
_Q_OCC_SCALE   = 1.4    # Q_T = 1.4 at full occupancy  → effective weight = 168
_Q_EMPTY_SCALE = 0.35   # Q_T = 0.35 when empty        → effective weight = 42
_Q_TERMINAL    = 1.5    # terminal step multiplier (reduced from 3.0 to soften horizon-end aggression)


# Helpers

def _sensitivity_matrix(N: int, B: float) -> np.ndarray:
    """
    Lower-triangular N×N thermal sensitivity matrix.

        S[k, j] = B · A^(k−j)   for k ≥ j,  else 0

    Each entry encodes: "1 W of HVAC power applied at step j shifts the
    indoor temperature at step k by S[k,j] °C."  The geometric decay with
    base A ≈ 0.917 reflects heat loss through the building envelope.

    Prediction model:
        T_pred[k] = T̂_ML[k]  +  (S · δu)[k]
    """
    S = np.zeros((N, N))
    for k in range(N):
        for j in range(k + 1):
            S[k, j] = B * (_A ** (k - j))
    return S


def _thermal_actuation_w(power_w: float) -> float:
    """Electrical standby draw does not create active heating/cooling."""
    return max(0.0, float(power_w) - _HVAC_MIN_W)


def _dense_forecast(st_dict: Dict[int, Any], N: int, default: float = float("nan")) -> np.ndarray:
    """
    Interpolate sparse {horizon → prediction-array} ML forecast to a dense
    length-N array (index 0 = step 1).  Extrapolates by clamping to boundary
    values.  Returns array filled with `default` if st_dict is empty.
    """
    pts = {}
    for h, v in st_dict.items():
        if 1 <= h <= N:
            try:
                pts[h] = float(v[0])
            except (TypeError, IndexError):
                pass
    if not pts:
        return np.full(N, default)
    xs = np.array(sorted(pts)) - 1           # 0-indexed
    ys = np.array([pts[h] for h in sorted(pts)])
    return np.interp(np.arange(N), xs, ys)


def _expand_outer_ref(
    refs: Optional[Dict[int, Any]],
    N: int,
    block_phase: int,
    default: float = float("nan"),
) -> np.ndarray:
    """Expand sparse outer-plan block refs to a dense per-step trajectory."""
    if not refs:
        return np.full(N, default)

    numeric_refs: Dict[int, float] = {}
    for step, value in refs.items():
        try:
            numeric_refs[int(step)] = float(value)
        except (TypeError, ValueError):
            continue

    if not numeric_refs:
        return np.full(N, default)

    last_step = max(numeric_refs)
    last_val = numeric_refs[last_step]
    dense = np.full(N, default)
    for k in range(N):
        block_idx = 1 + (block_phase + k) // _OUTER_BLOCK_STEPS
        dense[k] = numeric_refs.get(block_idx, last_val)
    return dense


def _outer_block_segments(N: int, block_phase: int) -> List[tuple[int, int, int]]:
    """Return contiguous inner-horizon slices grouped by outer 4h block."""
    segments: List[tuple[int, int, int]] = []
    start = 0
    while start < N:
        block_idx = 1 + (block_phase + start) // _OUTER_BLOCK_STEPS
        steps_left_in_block = _OUTER_BLOCK_STEPS - ((block_phase + start) % _OUTER_BLOCK_STEPS)
        end = min(N, start + steps_left_in_block)
        segments.append((block_idx, start, end))
        start = end
    return segments


def _temperature_baseline(
    T_now: float,
    outdoor_now: float,
    outdoor_traj: np.ndarray,
    u_now: float,
    B: float,
    occ_traj: np.ndarray,
    sunlight_traj: np.ndarray,
) -> np.ndarray:
    """
    Build a physically plausible open-loop temperature baseline.

    This projects indoor temperature toward the outdoor temperature rather than
    toward 0°C, and includes the effect of maintaining the current HVAC power.
    """
    N = len(outdoor_traj)
    T = float(T_now)
    baseline = np.zeros(N, dtype=float)
    fallback_outdoor = outdoor_now if not math.isnan(outdoor_now) else T_now

    for k in range(N):
        T_out = float(outdoor_traj[k])
        if math.isnan(T_out):
            T_out = fallback_outdoor
        n_occ = max(0.0, float(occ_traj[k])) if k < len(occ_traj) else 0.0
        sunlight = max(0.0, float(sunlight_traj[k])) if k < len(sunlight_traj) else 0.0
        q_internal = (
            _BASE_LOAD_W * _BASE_LOAD_HEAT_FRAC
            + n_occ * _META_W_PPL
            + sunlight * _SOLAR_GAIN_W_PER_WM2
        )
        T = _A * T + (1.0 - _A) * T_out + B * _thermal_actuation_w(u_now) + (q_internal * _DT_H / 800.0)
        baseline[k] = T
        fallback_outdoor = T_out

    return baseline


def _occupancy_setpoints(
    n_occ_st: np.ndarray,
    T_comfort: float,
    T_economy: float,
) -> np.ndarray:
    """
    Compute per-step temperature setpoints T*[k] based on the occupancy
    ST forecast, with pre-conditioning logic.

    Rules:
      - Occupied step (n̂ > threshold)        → T* = T_comfort
      - Empty step within PREHEAT_STEPS of    → T* = T_comfort (pre-heat at
        the first forecast-occupied step         full comfort target so QP
                                                 heats aggressively from the
                                                 start of the pre-heat window)
      - Empty step with no upcoming occupancy → T* = T_economy

    This enables the MPC to naturally pre-heat the building 90 min before
    people arrive without any explicit mode logic.
    """
    N = len(n_occ_st)
    T_star = np.full(N, T_economy)

    # Mark occupied steps
    occ_mask = n_occ_st > _N_OCC_THRESH
    T_star[occ_mask] = T_comfort

    # Find first occupied step in the horizon
    occ_indices = np.where(occ_mask)[0]
    if len(occ_indices) == 0:
        return T_star

    first_occ = int(occ_indices[0])
    preheat_start = max(0, first_occ - _PREHEAT_STEPS)

    for k in range(preheat_start, first_occ):
        if not occ_mask[k]:
            # Target comfort immediately — QP heats aggressively from the
            # start of the pre-heat window rather than ramping from economy.
            T_star[k] = T_comfort

    return T_star


def _occupancy_weights(n_occ_st: np.ndarray, n_max: float = 10.0) -> np.ndarray:
    """
    Per-step occupancy scale Q_T[k] ∈ [Q_EMPTY_SCALE, Q_OCC_SCALE].

    Used as a per-step multiplier inside the temperature cost:
        cost_temp = _W_COMFORT · Σ_k Q_T[k] · (T_pred[k] − T*[k])²

    - Empty (n=0):      Q_T = 0.35  → effective weight = 42
    - Full  (n=n_max):  Q_T = 1.4   → effective weight = 168
    """
    frac = np.clip(n_occ_st / max(1.0, n_max), 0.0, 1.0)
    scale = _Q_EMPTY_SCALE + frac * (_Q_OCC_SCALE - _Q_EMPTY_SCALE)
    return scale.astype(float)


def _co2_sensitivity_matrix(N: int, co2_hat: np.ndarray, co2_now: float) -> np.ndarray:
    """
    Lower-triangular NxN CO2 sensitivity to ventilation fraction.

        S[k, j] = -(co2_bar[j] - CO2_outdoor) · A_co2^(k-j)   for k ≥ j, else 0

    where co2_bar[j] is the CO2 **at the start of step j** (before v[j] is applied):
        j = 0  →  co2_now   (current measured CO2)
        j ≥ 1  →  co2_hat[j-1]  (ML forecast at horizon h=j, 0-indexed)

    Negative because more ventilation → lower CO2.

    Derivation: CO2[k+1] = A_co2·CO2[k] + src[k] − (CO2[k] − CO2_out)·δv[k]
    Linearising around v̄ ≈ _VENT_BASE_FRAC and co2_bar[j]:
        ∂CO2[k+1] / ∂δv[j] = −(co2_bar[j] − CO2_out) · A_co2^(k−j)

    The baseline CO2 at step j is the state immediately before v[j] is applied.
    For j=0 that is the measured state; for j≥1 it is the h=j ML prediction
    (co2_hat[j-1] in 0-indexed terms), not the h=j+1 prediction (co2_hat[j]).
    """
    S = np.zeros((N, N))
    for k in range(N):
        for j in range(k + 1):
            co2_at_j = co2_now if j == 0 else co2_hat[j - 1]
            S[k, j] = -(co2_at_j - _CO2_OUTDOOR) * (_A_CO2 ** (k - j))
    return S


# Outer MPC  (slow 4-hour loop)

class OuterMPC:
    """
    Slow planning loop (4h, 24h horizon).

    Consumes LT ML forecasts for all four features and the 24-hour weather
    forecast to produce the OuterPlan that constrains and guides the InnerMPC:

      energy_budget_lt   — total-power budget per 4h block [W], occupancy-
                           and solar-adjusted
      u_max_lt           — HVAC power ceiling per block (budget - base_load)
      temp_ref_lt        — 4h comfort temperature reference [°C]
      t_star_lt          — occupancy-aware dynamic setpoint per block [°C]
      co2_ref_lt         — forecast CO2 [ppm] for informational display
      occupancy_ref_lt   — forecast occupant count
      outdoor_temp_ref_lt— outdoor temperature for feedforward
    """

    def __init__(self, lt_steps: List[int]):
        self.lt_steps = [int(x) for x in lt_steps]

    def solve(
        self,
        forecasts: ForecastBundle,
        state: Dict[str, Any],
        weather_forecast: Optional[List[Any]] = None,
    ) -> OuterPlan:
        refs: Dict[str, Any] = {}
        T_comfort = float(state.get("temp_target", 21.0))

        # LT energy budget (raw ML forecast)
        budget: Optional[Dict[int, float]] = None
        if "energy" in forecasts.by_feature:
            budget = {
                k: float(forecasts.by_feature["energy"].lt[k][0])
                for k in sorted(forecasts.by_feature["energy"].lt)
            }

        # LT temperature reference
        if "temperature" in forecasts.by_feature:
            refs["temp_ref_lt"] = {
                k: float(forecasts.by_feature["temperature"].lt[k][0])
                for k in sorted(forecasts.by_feature["temperature"].lt)
            }

        # LT occupancy forecast
        occ_ref: Optional[Dict[int, float]] = None
        if "occupancy" in forecasts.by_feature:
            occ_ref = {
                k: float(forecasts.by_feature["occupancy"].lt[k][0])
                for k in sorted(forecasts.by_feature["occupancy"].lt)
            }
        refs["occupancy_ref_lt"] = occ_ref

        # 4. LT CO2 forecast
        co2_ref: Optional[Dict[int, float]] = None
        if "airquality" in forecasts.by_feature:
            co2_ref = {
                k: float(forecasts.by_feature["airquality"].lt[k][0])
                for k in sorted(forecasts.by_feature["airquality"].lt)
            }
        refs["co2_ref_lt"] = co2_ref

        # Occupancy-adjusted energy budget
        # Occupants generate ~80 W of metabolic heat, reducing the heating
        # demand the HVAC needs to supply in that block.
        if budget is not None and occ_ref is not None:
            adj: Dict[int, float] = {}
            for step, base_w in budget.items():
                n_occ       = max(0.0, occ_ref.get(step, 0.0))
                occ_heat_w  = n_occ * _META_W_PPL
                adj[step]   = max(_HVAC_MIN_W + _BASE_LOAD_W, base_w - occ_heat_w)
            budget = adj

        # Weather feedforward + solar gain correction
        if weather_forecast:
            wf_by_step: Dict[int, Any] = {
                i + 1: snap for i, snap in enumerate(weather_forecast)
            }

            outdoor_ref: Dict[int, float] = {}
            sunlight_ref: Dict[int, float] = {}
            for step, snap in sorted(wf_by_step.items()):
                t = snap.outdoor_temp
                if not (isinstance(t, float) and math.isnan(t)):
                    outdoor_ref[step] = t
                sun = snap.sunlight
                if not (isinstance(sun, float) and math.isnan(sun)):
                    sunlight_ref[step] = sun
            if outdoor_ref:
                refs["outdoor_temp_ref_lt"] = outdoor_ref
            if sunlight_ref:
                refs["sunlight_ref_lt"] = sunlight_ref

            if budget is not None:
                solar_adj: Dict[int, float] = {}
                for step, base_w in budget.items():
                    snap = wf_by_step.get(step)
                    if snap is not None:
                        sun = snap.sunlight
                        if (
                            isinstance(sun, float)
                            and not math.isnan(sun)
                            and sun > _SOLAR_THRESHOLD_WM2
                        ):
                            offset_w = sun * _SOLAR_EFFICIENCY_FACTOR
                            solar_adj[step] = max(0.0, base_w - offset_w)
                        else:
                            solar_adj[step] = base_w
                    else:
                        solar_adj[step] = base_w
                budget = solar_adj

        refs["energy_budget_lt"] = budget

        # Per-step HVAC power bounds for InnerMPC

        # Upper bound: budget − base load
        if budget:
            refs["u_max_lt"] = {
                step: float(np.clip(w - _BASE_LOAD_W, _HVAC_MIN_W, _HVAC_MAX_W))
                for step, w in budget.items()
            }

        # Occupancy-aware dynamic temperature setpoint per block
        # Pre-conditioning: blocks that are empty but precede an occupied block
        # get a ramped-up setpoint so the outer plan already anticipates heating.
        if occ_ref:
            steps_sorted  = sorted(occ_ref)
            n_occ_arr     = np.array([occ_ref[s] for s in steps_sorted])
            T_star_arr    = _occupancy_setpoints(n_occ_arr, T_comfort, _T_ECONOMY)
            refs["t_star_lt"] = {s: float(T_star_arr[i]) for i, s in enumerate(steps_sorted)}

        return OuterPlan(refs=refs)


# Inner MPC  (fast 15-minute loop)

class InnerMPC:
    """
    Fast control loop (15-min cadence).  Solves a 2D state-space Quadratic
    Program over N steps (N = max ST horizon, typically 8 → 2 hours).

    States:   x = [T_room, CO2]
    Controls: u = [heating_power (W), ventilation_rate (fraction)]
    Reference: r = [T_comfort (°C), co2_target (ppm)]

    Cost function (4 named weights):
    ---------------------------------
        J = W_comfort · Σ_k Q_T[k] · (T̂[k] + (S_T·δu)[k] - T*[k])²   [temperature]
          + W_airqual · Σ_k         · (CO2̂[k] + (S_CO2·δv)[k] - co2_ref)²  [CO2]
          + W_energy  · Σ_k         · (u[k]·dt + v[k]·VENT_FAN_W·dt)        [energy]
          + W_smooth  · Σ_k         · (Δu[k]² + Δv[k]²)                     [smoothness]

    Per-step occupancy scaling Q_T[k]:
        0.35x when empty → 1.4x at full occupancy

    Energy budget hard constraint (from OuterMPC):
        Σ (u[k] + v[k]·VENT_FAN_W) · dt ≤ E_budget_Wh

    Decision vector w ∈ R^{2N} = [δu_heat(N), δv(N)]
    Receding horizon: solve → apply [u[0], v[0]] → re-solve next tick.
    """

    def __init__(self, st_steps: List[int], control_horizon_steps: Optional[int] = None):
        self.st_steps = sorted(int(x) for x in st_steps)
        self.N = max(max(self.st_steps), int(control_horizon_steps or 0))
        # Bug 2 fix: stores 1-step-ahead T prediction from previous solve
        self._last_T1hat: Optional[float] = None

    def solve(
        self,
        forecasts: ForecastBundle,
        state: Dict[str, Any],
        outer: OuterPlan,
    ) -> InnerAction:
        # Run QP whenever scipy is available — no need to wait for ML warm-up.
        # If ML forecasts aren't ready yet, _solve_qp falls back to a physics-based
        # cold-start T_hat so the optimizer works from tick 1 onward.
        if _HAS_SCIPY:
            try:
                return self._solve_qp(forecasts, state, outer)
            except Exception as exc:
                return self._fallback(forecasts, state, outer,
                                      extra={"qp_error": str(exc)})
        return self._fallback(forecasts, state, outer)

    # QP solver

    def _solve_qp(
        self,
        forecasts: ForecastBundle,
        state: Dict[str, Any],
        outer: OuterPlan,
    ) -> InnerAction:
        N = self.N

        # Current state
        T_now     = float(state.get("temp", 20.0))
        T_comfort = float(state.get("temp_target", 21.0))
        H_now     = float(state.get("humidity", 45.0))
        P_now     = float(state.get("total_act_power", _BASE_LOAD_W + _HVAC_MIN_W))
        v_now     = float(np.clip(state.get("vent_rate", _VENT_BASE_FRAC), 0.0, _VENT_MAX_FRAC))
        if "hvac_power_w" in state:
            u_now = float(np.clip(state["hvac_power_w"], _HVAC_MIN_W, _HVAC_MAX_W))
        else:
            vent_fan_now = v_now * _VENT_FAN_W
            u_now = float(np.clip(P_now - _BASE_LOAD_W - vent_fan_now, _HVAC_MIN_W, _HVAC_MAX_W))
        cooling_allowed = not bool(state.get("heating_only", False))
        co2_now   = float(state.get("co2", 600.0))
        co2_ref   = float(state.get("co2_target", _CO2_REF))
        block_phase = int(np.clip(state.get("outer_block_phase", 0), 0, _OUTER_BLOCK_STEPS - 1))
        outdoor_now = float(state.get("outdoor_temp", float("nan")))
        sunlight_now = float(state.get("sunlight", 0.0))

        # Thermal sensitivity sign
        # Heating mode (T < target or heating-only): B > 0 → more power raises T
        # Cooling mode (T >= target and cooling allowed): B < 0 → more power lowers T
        # Must stay in sync with simulate_house.py step() which uses the same threshold.
        # A dead-band here would create a model-physics mismatch in the overlap zone,
        # causing the disturbance observer to accumulate a systematic bias every tick.
        if T_now >= T_comfort and cooling_allowed:
            B = -_B_COOL
        else:
            B = _B_HEAT
        S_T = _sensitivity_matrix(N, B)
        outdoor_ref = _expand_outer_ref(
            outer.refs.get("outdoor_temp_ref_lt"),
            N,
            block_phase,
            default=outdoor_now,
        )
        occ_baseline = np.clip(
            _expand_outer_ref(
                outer.refs.get("occupancy_ref_lt"),
                N,
                block_phase,
                default=float(state.get("num_targets", 0.0)),
            ),
            0.0,
            None,
        )
        sunlight_ref = np.clip(
            _expand_outer_ref(
                outer.refs.get("sunlight_ref_lt"),
                N,
                block_phase,
                default=sunlight_now,
            ),
            0.0,
            None,
        )
        T_phys = _temperature_baseline(
            T_now,
            outdoor_now,
            outdoor_ref,
            u_now,
            B,
            occ_baseline,
            sunlight_ref,
        )

        # Dense ST forecasts
        # Use ML forecast when available; otherwise synthesise a physics-based
        # cold-start trajectory so the QP works from the very first tick.
        if "temperature" in forecasts.by_feature:
            T_ml = _dense_forecast(forecasts.by_feature["temperature"].st, N)
            if np.any(np.isnan(T_ml)):
                T_ml = np.where(np.isnan(T_ml), T_phys, T_ml)
            ml_weight = np.linspace(_T_ML_BLEND_NEAR, _T_ML_BLEND_FAR, N)
            T_hat = ml_weight * T_ml + (1.0 - ml_weight) * T_phys
        else:
            T_hat = T_phys.copy()

        # Disturbance observer (offset-free MPC).
        if self._last_T1hat is not None:
            d = float(np.clip(T_now - self._last_T1hat, -_T_OBSERVER_CLIP, _T_OBSERVER_CLIP))
            T_hat = T_hat + (_T_OBSERVER_GAIN * d) * (_A ** np.arange(N))

        # Keep the near-term baseline trajectory physically plausible.
        # The first few points should stay close to both the measured current
        # state and the open-loop thermal baseline, even if the ML forecast is noisy.
        max_dev_from_phys = np.linspace(0.5, 2.0, N)
        max_dev_from_now = np.linspace(0.8, 2.5, N)
        T_hat = np.clip(T_hat, T_phys - max_dev_from_phys, T_phys + max_dev_from_phys)
        T_hat = np.clip(T_hat, T_now - max_dev_from_now, T_now + max_dev_from_now)

        # Occupancy ST forecast (default 0 if feature not available)
        if "occupancy" in forecasts.by_feature:
            n_occ_st = np.clip(
                _dense_forecast(forecasts.by_feature["occupancy"].st, N, default=0.0),
                0.0, None,
            )
        else:
            n_occ_st = np.zeros(N)
        n_occ_outer = np.clip(
            _expand_outer_ref(outer.refs.get("occupancy_ref_lt"), N, block_phase, default=0.0),
            0.0,
            None,
        )
        if len(self.st_steps) > 0:
            outer_takeover_idx = max(self.st_steps)
            if outer_takeover_idx < N:
                n_occ_st[outer_takeover_idx:] = np.maximum(
                    n_occ_st[outer_takeover_idx:],
                    n_occ_outer[outer_takeover_idx:],
                )

        # CO2 ST forecast (default to current reading)
        if "airquality" in forecasts.by_feature:
            co2_st = _dense_forecast(
                forecasts.by_feature["airquality"].st, N, default=co2_now
            )
        else:
            co2_st = np.full(N, co2_now)

        # CO2 sensitivity matrix (linearised around forecast trajectory)
        S_CO2 = _co2_sensitivity_matrix(N, co2_st, co2_now)

        # Per-step dynamic temperature setpoints T*[k]
        # Economy setpoint is bounded by T_comfort so night mode (T_comfort=15°C)
        # never causes unnecessary heating toward the hardcoded 17°C economy value.
        T_economy = min(_T_ECONOMY, T_comfort)

        # Occupancy-aware: economy when empty, comfort when occupied,
        # full-comfort target during pre-conditioning window.
        T_star = _occupancy_setpoints(n_occ_st, T_comfort, T_economy)

        # Fallback pre-heat: if the occupancy forecast is flat-zero (model
        # cold-start or poor training) and the building is significantly below
        # the comfort setpoint, override economy-level steps to T_comfort so
        # the QP still pre-heats correctly regardless of system type.
        # Bug fix: removed `cooling_allowed and` — pre-heat applies to both
        # heating-only and full-HVAC systems when temperature is far below setpoint.
        if T_now < T_comfort - 2.0:
            T_star = np.where(T_star < T_comfort - 1.0, T_comfort, T_star)

        t_star_lt_refs = outer.refs.get("t_star_lt") or {}
        outer_t_star = _expand_outer_ref(t_star_lt_refs, N, block_phase)
        if not np.all(np.isnan(outer_t_star)):
            valid = ~np.isnan(outer_t_star)
            if B >= 0.0:
                T_star[valid] = np.maximum(T_star[valid], outer_t_star[valid])
            else:
                T_star[valid] = np.minimum(T_star[valid], outer_t_star[valid])

        # User-overridable QP cost weights
        # These can be tuned from the UI via the SimConfig weight sliders.
        # Defaults fall back to the module-level constants.
        # UI sends integer "dial" values; app.py scales them to real weights:
        #   W_smooth  = wSmooth  * 1e-5  (UI: 0–100, default 5  → 5e-5)
        #   W_energy  = wEnergy  * 1e-5  (UI: 0–100, default 30 → 3e-4)
        #   W_comfort and Q_terminal passed as-is
        W_comfort  = float(state.get("w_comfort",  _W_COMFORT))
        W_airqual  = float(state.get("w_airqual",  _W_AIRQUAL))
        W_energy   = float(state.get("w_energy",   _W_ENERGY))
        W_smooth   = float(state.get("w_smooth",   _W_SMOOTH))
        Q_terminal = float(state.get("q_terminal", _Q_TERMINAL))

        # Per-step comfort weights Q_T[k]
        # Occupancy scale: 0.25 (empty) → 1.8 (full).  Terminal step gets boost.
        n_max = float(state.get("n_occupants_max", 10.0))
        occ_for_weights = np.maximum(n_occ_st, n_occ_outer)
        Q_T   = _occupancy_weights(occ_for_weights, n_max)
        Q_T[-1] *= Q_terminal

        # HVAC power bounds (no CO2 u_min floor — CO2 via cost)
        u_max_lt     = outer.refs.get("u_max_lt") or {}
        u_max_vec = np.clip(
            _expand_outer_ref(u_max_lt, N, block_phase, default=_HVAC_MAX_W),
            _HVAC_MIN_W,
            _HVAC_MAX_W,
        )
        u_max_global = float(np.max(u_max_vec))
        u_min_vec    = np.full(N, _HVAC_MIN_W)

        # Energy budget hard constraint
        # Accounts for both heating power and ventilation fan draw.
        # Bug 1 fix: TickRunner tracks block-level consumption and injects
        # remaining_energy_budget_wh so the constraint tightens across ticks.
        energy_budget_lt = outer.refs.get("energy_budget_lt")
        block_budget_limits_wh: Dict[int, float] = {}
        if energy_budget_lt:
            for block_idx, start_idx, end_idx in _outer_block_segments(N, block_phase):
                steps = end_idx - start_idx
                if block_idx == 1 and "remaining_energy_budget_wh" in state:
                    budget_wh = max(0.0, float(state["remaining_energy_budget_wh"]))
                else:
                    avg_total_w = float(energy_budget_lt.get(block_idx, energy_budget_lt.get(1, _BASE_LOAD_W)))
                    hvac_avg_w = max(0.0, avg_total_w - _BASE_LOAD_W)
                    budget_wh = hvac_avg_w * steps * _DT_H
                block_budget_limits_wh[block_idx] = budget_wh
        else:
            block_budget_limits_wh[1] = (u_max_global + _VENT_FAN_W) * N * _DT_H

        E_budget_wh = float(sum(block_budget_limits_wh.values()))
        for block_idx, start_idx, end_idx in _outer_block_segments(N, block_phase):
            budget_wh = block_budget_limits_wh.get(block_idx)
            if budget_wh is None:
                continue
            steps = end_idx - start_idx
            min_hvac_wh = _HVAC_MIN_W * steps * _DT_H
            if budget_wh < min_hvac_wh and steps > 0:
                u_min_vec[start_idx:end_idx] = max(0.0, budget_wh / (steps * _DT_H))

        # Build combined 2N decision vector w = [δu_heat(N), δv(N)]
        u_baseline = np.full(N, u_now)
        v_baseline = np.full(N, v_now)

        lb_u = u_min_vec - u_baseline
        ub_u = u_max_vec - u_baseline
        lb_v = -v_baseline                                  # v ≥ 0
        ub_v = np.full(N, _VENT_MAX_FRAC) - v_baseline     # v ≤ VENT_MAX_FRAC

        lb_w = np.concatenate([lb_u, lb_v])
        ub_w = np.concatenate([ub_u, ub_v])

        energy_constraints = []
        for block_idx, start_idx, end_idx in _outer_block_segments(N, block_phase):
            budget_wh = block_budget_limits_wh.get(block_idx)
            if budget_wh is None:
                continue
            A_energy = np.zeros(2 * N)
            A_energy[start_idx:end_idx] = _DT_H
            A_energy[N + start_idx:N + end_idx] = _VENT_FAN_W * _DT_H
            baseline_wh = (
                float(np.sum(u_baseline[start_idx:end_idx])) * _DT_H
                + float(np.sum(v_baseline[start_idx:end_idx])) * _VENT_FAN_W * _DT_H
            )
            e_slack = budget_wh - baseline_wh
            energy_constraints.append(
                LinearConstraint(A_energy.reshape(1, -1), -np.inf, e_slack)
            )

        # Nominal errors at baseline control
        T_err_nom   = T_hat - T_star     # shape (N,)
        CO2_err_nom = co2_st - co2_ref   # shape (N,)

        def _cost(w: np.ndarray) -> float:
            dv_u = w[:N]
            dv_v = w[N:]

            T_err   = T_err_nom + S_T @ dv_u
            c_temp  = W_comfort * float(Q_T @ (T_err ** 2))

            CO2_err = CO2_err_nom + S_CO2 @ dv_v
            c_co2   = W_airqual * float(np.dot(CO2_err, CO2_err))

            u_vec    = u_baseline + dv_u
            v_vec    = v_baseline + dv_v
            c_energy = W_energy * float(
                np.sum(u_vec * _DT_H + v_vec * _VENT_FAN_W * _DT_H)
            )

            c_smooth = W_smooth * (
                float(np.sum(np.diff(dv_u) ** 2)) +
                float(np.sum(np.diff(dv_v) ** 2))
            )

            return c_temp + c_co2 + c_energy + c_smooth

        def _grad(w: np.ndarray) -> np.ndarray:
            dv_u = w[:N]
            dv_v = w[N:]

            T_err   = T_err_nom + S_T @ dv_u
            CO2_err = CO2_err_nom + S_CO2 @ dv_v

            # Temperature gradient w.r.t. δu
            g_temp_u = 2.0 * W_comfort * (S_T.T @ (Q_T * T_err))

            # CO2 gradient w.r.t. δv
            g_co2_v  = 2.0 * W_airqual * (S_CO2.T @ CO2_err)

            # Energy gradient (linear)
            g_energy_u = np.full(N, W_energy * _DT_H)
            g_energy_v = np.full(N, W_energy * _VENT_FAN_W * _DT_H)

            # Smoothness gradient δu
            diff_u = np.diff(dv_u)
            g_smooth_u = np.zeros(N)
            for i in range(N - 1):
                g_smooth_u[i]     += 2.0 * W_smooth * diff_u[i]
                g_smooth_u[i + 1] -= 2.0 * W_smooth * diff_u[i]

            # Smoothness gradient δv
            diff_v = np.diff(dv_v)
            g_smooth_v = np.zeros(N)
            for i in range(N - 1):
                g_smooth_v[i]     += 2.0 * W_smooth * diff_v[i]
                g_smooth_v[i + 1] -= 2.0 * W_smooth * diff_v[i]

            g_u = g_temp_u + g_energy_u + g_smooth_u
            g_v = g_co2_v  + g_energy_v + g_smooth_v
            return np.concatenate([g_u, g_v])

        result = minimize(
            _cost,
            x0=np.zeros(2 * N),
            jac=_grad,
            method="SLSQP",
            bounds=Bounds(lb=lb_w, ub=ub_w),
            constraints=energy_constraints,
            options={"ftol": 1e-8, "maxiter": 500},
        )

        w_opt  = result.x
        u_opt  = np.clip(u_baseline + w_opt[:N], u_min_vec, u_max_vec)
        v_opt  = np.clip(v_baseline + w_opt[N:], 0.0, _VENT_MAX_FRAC)
        u_next = float(u_opt[0])
        v_next = float(v_opt[0])
        T_pred = T_hat + S_T @ w_opt[:N]

        # Store the nominal physics prediction for the next tick.
        # This is the disturbance-observer reference: d[k+1] = T_measured - _last_T1hat.
        # Must include ALL terms of the nominal model (_temperature_baseline) so the
        # observer only captures true unmodeled disturbances, not known internal gains
        # (Pannocchia & Rawlings 2003 §3 — reference must use the same nominal model).
        # Do NOT store T_pred[0] here — that already contains the ML correction
        # and prior disturbance, which would create a d(k+1) = -d(k) oscillator.
        outdoor_next = float(outdoor_ref[0]) if not math.isnan(float(outdoor_ref[0])) else (
            outdoor_now if not math.isnan(outdoor_now) else T_now
        )
        n_occ_next   = float(n_occ_st[0]) if len(n_occ_st) > 0 else 0.0
        sun_next     = float(sunlight_ref[0]) if not math.isnan(float(sunlight_ref[0])) else sunlight_now
        q_int_next   = (
            _BASE_LOAD_W * _BASE_LOAD_HEAT_FRAC
            + n_occ_next * _META_W_PPL
            + sun_next * _SOLAR_GAIN_W_PER_WM2
        )
        self._last_T1hat = (
            _A * T_now
            + (1.0 - _A) * outdoor_next
            + B * _thermal_actuation_w(u_next)
            + q_int_next * _DT_H / 800.0
        )

        # ── Convert to metered quantities ────────────────────────────────
        total_act  = u_next + _BASE_LOAD_W
        total_aprt = total_act * 1.05
        total_cur  = total_act / (231.0 * math.sqrt(3.0))

        return InnerAction(
            u={
                "total_act_power":  round(total_act,  1),
                "total_aprt_power": round(total_aprt, 1),
                "total_current":    round(total_cur,  4),
                "hvac_power_w":     round(u_next,     1),
                "vent_rate":        round(v_next,      4),
                "vent_fan_w":       round(v_next * _VENT_FAN_W, 1),
            },
            info={
                "solver":            "SLSQP",
                "converged":         bool(result.success),
                "n_iter":            int(result.nit),
                "cost":              float(result.fun),
                "u_sequence_w":      [round(v, 1) for v in u_opt.tolist()],
                "v_sequence":        [round(v, 4) for v in v_opt.tolist()],
                "T_forecast_dense":  [round(v, 2) for v in T_hat.tolist()],
                "T_pred_trajectory": [round(v, 2) for v in T_pred.tolist()],
                "T_baseline_phys":   [round(v, 2) for v in T_phys.tolist()],
                "T_star_per_step":   [round(v, 2) for v in T_star.tolist()],
                "T_star_outer_per_step": [round(v, 2) for v in outer_t_star.tolist()],
                "Q_T_per_step":      [round(v, 3) for v in Q_T.tolist()],
                "n_occ_forecast":    [round(v, 1) for v in n_occ_st.tolist()],
                "n_occ_outer":       [round(v, 1) for v in n_occ_outer.tolist()],
                "co2_forecast":      [round(v, 1) for v in co2_st.tolist()],
                "co2_ref":           round(co2_ref, 1),
                "humidity_now":      round(H_now, 1),
                "E_budget_wh":       round(E_budget_wh, 1),
                "u_max_applied_w":   round(float(u_max_vec[0]), 1),
                "u_max_sequence_w":  [round(v, 1) for v in u_max_vec.tolist()],
                "outer_block_phase": block_phase,
                "B_sensitivity":     round(B, 6),
                "horizon_steps":     N,
                "W_comfort":         W_comfort,
                "W_airqual":         W_airqual,
                "W_energy":          W_energy,
                "W_smooth":          W_smooth,
                "Q_terminal":        Q_terminal,
            },
        )

    # Proportional fallback  (when scipy absent or QP fails)

    def _fallback(
        self,
        forecasts: ForecastBundle,
        state: Dict[str, Any],
        outer: OuterPlan,
        extra: Optional[Dict[str, Any]] = None,
    ) -> InnerAction:
        P_now  = float(state.get("total_act_power", _BASE_LOAD_W + _HVAC_MIN_W))
        u_hvac = max(_HVAC_MIN_W, P_now - _BASE_LOAD_W)

        if "temperature" in forecasts.by_feature:
            T_target = float(state.get("temp_target", 21.0))
            T_now    = float(state.get("temp", T_target))
            t1       = float(
                forecasts.by_feature["temperature"].st.get(
                    1, np.array([T_now])
                )[0]
            )
            err    = T_target - t1
            u_hvac = float(np.clip(
                u_hvac + 50.0 * err,
                _HVAC_MIN_W, _HVAC_MAX_W,
            ))

        total_act  = u_hvac + _BASE_LOAD_W
        total_aprt = total_act * 1.05
        total_cur  = total_act / (231.0 * math.sqrt(3.0))

        return InnerAction(
            u={
                "total_act_power":  round(total_act,  1),
                "total_aprt_power": round(total_aprt, 1),
                "total_current":    round(total_cur,  4),
                "hvac_power_w":     round(u_hvac,     1),
                "vent_rate":        round(_VENT_BASE_FRAC, 4),
                "vent_fan_w":       round(_VENT_BASE_FRAC * _VENT_FAN_W, 1),
            },
            info={"solver": "proportional_fallback", **(extra or {})},
        )
