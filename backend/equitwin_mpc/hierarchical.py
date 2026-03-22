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

# ---------------------------------------------------------------------------
# Physical constants — must stay in sync with simulate_house.py
# ---------------------------------------------------------------------------
_DT_H        = 15.0 / 60.0           # 0.25 h per 15-min step
_TAU_H       = 3.0                    # building thermal time-constant [h]
_A           = 1.0 - _DT_H / _TAU_H  # ≈ 0.9167  discrete-time thermal pole
_B_HEAT      = 3.2  * _DT_H / 800.0  # ≈ 0.001   °C per W per step (heating)
_B_COOL      = 2.6  * _DT_H / 800.0  # ≈ 0.000813 °C per W per step (cooling)
_HVAC_MAX_W  = 2500.0                 # maximum HVAC electrical input [W]
_HVAC_MIN_W  = 80.0                   # standby / fan-only draw [W]
_BASE_LOAD_W = 380.0                  # always-on base load [W]
_META_W_PPL  = 80.0                   # metabolic heat per occupant [W]

# Solar correction constants
_SOLAR_THRESHOLD_WM2     = 200.0
_SOLAR_EFFICIENCY_FACTOR = 0.05

# ---------------------------------------------------------------------------
# Comfort / setpoint scheduling
# ---------------------------------------------------------------------------
_T_ECONOMY      = 17.0   # economy setpoint when building is unoccupied [°C]
_PREHEAT_STEPS  = 6      # 15-min steps (90 min) of pre-conditioning before occupancy
_N_OCC_THRESH   = 0.5    # people count threshold to treat a step as "occupied"

# ---------------------------------------------------------------------------
# Ventilation control (independent from heating/cooling)
# v[k] is a dimensionless fraction: 0 = closed, VENT_MAX_FRAC = full fresh-air rate
# ---------------------------------------------------------------------------
_CO2_OUTDOOR    = 420.0                           # outdoor CO2 baseline [ppm]
_CO2_REF        = 800.0                           # default CO2 reference / target [ppm]
_VENT_BASE_FRAC = 1 - math.exp(-15 / 120)         # standby ventilation fraction ≈ 0.117
_VENT_MAX_FRAC  = 0.40                            # maximum ventilation fraction at full fan
_VENT_FAN_W     = 200.0                           # electrical draw at max ventilation [W]
_A_CO2          = 1.0 - _VENT_BASE_FRAC           # CO2 decay pole ≈ 0.883

# ---------------------------------------------------------------------------
# QP cost weights  (2D state-space: temperature + CO2)
# ---------------------------------------------------------------------------
# _W_COMFORT  — temperature error weight, scaled per-step by occupancy Q_T[k]
# _W_AIRQUAL  — CO2 error weight (ppm² scale)
# _W_ENERGY   — linear electricity cost per Wh (heating + ventilation fan)
# _W_SMOOTH   — actuator rate-of-change penalty (Δu² + Δv²)
# ---------------------------------------------------------------------------
_W_COMFORT    = 200.0   # temperature tracking weight (× Q_T[k] occupancy scale)
_W_AIRQUAL    = 0.08    # CO2 tracking weight
_W_ENERGY     = 3e-4    # linear energy cost [per Wh]
_W_SMOOTH     = 5e-5    # actuator smoothness penalty

# Per-step occupancy scaling for temperature comfort weight
_Q_OCC_SCALE   = 1.8    # Q_T = 1.8 at full occupancy  → effective weight = 360
_Q_EMPTY_SCALE = 0.25   # Q_T = 0.25 when empty        → effective weight = 50
_Q_TERMINAL    = 3.0    # terminal step multiplier (closes horizon on target)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

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

    - Empty (n=0):      Q_T = 0.25  → effective weight = 50
    - Full  (n=n_max):  Q_T = 1.8   → effective weight = 360
    """
    frac = np.clip(n_occ_st / max(1.0, n_max), 0.0, 1.0)
    scale = _Q_EMPTY_SCALE + frac * (_Q_OCC_SCALE - _Q_EMPTY_SCALE)
    return scale.astype(float)


def _co2_sensitivity_matrix(N: int, co2_hat: np.ndarray) -> np.ndarray:
    """
    Lower-triangular N×N CO2 sensitivity to ventilation fraction.

        S[k, j] = -(co2_hat[j] − CO2_outdoor) · A_co2^(k−j)   for k ≥ j, else 0

    Negative because more ventilation → lower CO2.
    Linearised around the forecast CO2 trajectory co2_hat.

    Derivation: CO2[k+1] = CO2[k] + src[k] − v[k]·(CO2[k] − CO2_out)
    Linearising around v_baseline ≈ _VENT_BASE_FRAC and CO2_hat[k]:
        ∂CO2[k] / ∂v[j] ≈ S[k, j]
    """
    S = np.zeros((N, N))
    for k in range(N):
        for j in range(k + 1):
            S[k, j] = -(co2_hat[j] - _CO2_OUTDOOR) * (_A_CO2 ** (k - j))
    return S


# ---------------------------------------------------------------------------
# Outer MPC  (slow 4-hour loop)
# ---------------------------------------------------------------------------

class OuterMPC:
    """
    Slow planning loop (4h cadence, 24h horizon).

    Consumes LT ML forecasts for all four features and the 24-hour weather
    forecast to produce the OuterPlan that constrains and guides the InnerMPC:

      energy_budget_lt   — total-power budget per 4h block [W], occupancy-
                           and solar-adjusted
      u_max_lt           — HVAC power ceiling per block (budget − base_load)
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

        # ── 1. LT energy budget (raw ML forecast) ───────────────────────────
        budget: Optional[Dict[int, float]] = None
        if "energy" in forecasts.by_feature:
            budget = {
                k: float(forecasts.by_feature["energy"].lt[k][0])
                for k in sorted(forecasts.by_feature["energy"].lt)
            }

        # ── 2. LT temperature reference ─────────────────────────────────────
        if "temperature" in forecasts.by_feature:
            refs["temp_ref_lt"] = {
                k: float(forecasts.by_feature["temperature"].lt[k][0])
                for k in sorted(forecasts.by_feature["temperature"].lt)
            }

        # ── 3. LT occupancy forecast ─────────────────────────────────────────
        occ_ref: Optional[Dict[int, float]] = None
        if "occupancy" in forecasts.by_feature:
            occ_ref = {
                k: float(forecasts.by_feature["occupancy"].lt[k][0])
                for k in sorted(forecasts.by_feature["occupancy"].lt)
            }
        refs["occupancy_ref_lt"] = occ_ref

        # ── 4. LT CO2 forecast ───────────────────────────────────────────────
        co2_ref: Optional[Dict[int, float]] = None
        if "airquality" in forecasts.by_feature:
            co2_ref = {
                k: float(forecasts.by_feature["airquality"].lt[k][0])
                for k in sorted(forecasts.by_feature["airquality"].lt)
            }
        refs["co2_ref_lt"] = co2_ref

        # ── 5. Occupancy-adjusted energy budget ──────────────────────────────
        # Occupants generate ~80 W of metabolic heat, reducing the heating
        # demand the HVAC needs to supply in that block.
        if budget is not None and occ_ref is not None:
            adj: Dict[int, float] = {}
            for step, base_w in budget.items():
                n_occ       = max(0.0, occ_ref.get(step, 0.0))
                occ_heat_w  = n_occ * _META_W_PPL
                adj[step]   = max(_HVAC_MIN_W + _BASE_LOAD_W, base_w - occ_heat_w)
            budget = adj

        # ── 6. Weather feedforward + solar gain correction ───────────────────
        if weather_forecast:
            wf_by_step: Dict[int, Any] = {
                i + 1: snap for i, snap in enumerate(weather_forecast)
            }

            outdoor_ref: Dict[int, float] = {}
            for step, snap in sorted(wf_by_step.items()):
                t = snap.outdoor_temp
                if not (isinstance(t, float) and math.isnan(t)):
                    outdoor_ref[step] = t
            if outdoor_ref:
                refs["outdoor_temp_ref_lt"] = outdoor_ref

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
                            offset_w = (sun / 1000.0) * _SOLAR_EFFICIENCY_FACTOR * 1000.0
                            solar_adj[step] = max(0.0, base_w - offset_w)
                        else:
                            solar_adj[step] = base_w
                    else:
                        solar_adj[step] = base_w
                budget = solar_adj

        refs["energy_budget_lt"] = budget

        # ── 7. Per-step HVAC power bounds for InnerMPC ───────────────────────

        # Upper bound: budget − base load
        if budget:
            refs["u_max_lt"] = {
                step: float(np.clip(w - _BASE_LOAD_W, _HVAC_MIN_W, _HVAC_MAX_W))
                for step, w in budget.items()
            }

        # ── 8. Occupancy-aware dynamic temperature setpoint per block ─────────
        # Pre-conditioning: blocks that are empty but precede an occupied block
        # get a ramped-up setpoint so the outer plan already anticipates heating.
        if occ_ref:
            steps_sorted  = sorted(occ_ref)
            n_occ_arr     = np.array([occ_ref[s] for s in steps_sorted])
            T_star_arr    = _occupancy_setpoints(n_occ_arr, T_comfort, _T_ECONOMY)
            refs["t_star_lt"] = {s: float(T_star_arr[i]) for i, s in enumerate(steps_sorted)}

        return OuterPlan(refs=refs)


# ---------------------------------------------------------------------------
# Inner MPC  (fast 15-minute loop)
# ---------------------------------------------------------------------------

class InnerMPC:
    """
    Fast control loop (15-min cadence).  Solves a 2D state-space Quadratic
    Program over N steps (N = max ST horizon, typically 8 → 2 hours).

    States:   x = [T_room, CO2]
    Controls: u = [heating_power (W), ventilation_rate (fraction)]
    Reference: r = [T_comfort (°C), co2_target (ppm)]

    Cost function (4 named weights):
    ---------------------------------
        J = W_comfort · Σ_k Q_T[k] · (T̂[k] + (S_T·δu)[k] − T*[k])²   [temperature]
          + W_airqual · Σ_k         · (CO2̂[k] + (S_CO2·δv)[k] − co2_ref)²  [CO2]
          + W_energy  · Σ_k         · (u[k]·dt + v[k]·VENT_FAN_W·dt)        [energy]
          + W_smooth  · Σ_k         · (Δu[k]² + Δv[k]²)                     [smoothness]

    Per-step occupancy scaling Q_T[k]:
        0.25× when empty → 1.8× at full occupancy

    Energy budget hard constraint (from OuterMPC):
        Σ (u[k] + v[k]·VENT_FAN_W) · dt ≤ E_budget_Wh

    Decision vector w ∈ R^{2N} = [δu_heat(N), δv(N)]
    Receding horizon: solve → apply [u[0], v[0]] → re-solve next tick.
    """

    def __init__(self, st_steps: List[int]):
        self.st_steps = sorted(int(x) for x in st_steps)
        self.N = max(self.st_steps)

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

    # ------------------------------------------------------------------
    # QP solver
    # ------------------------------------------------------------------

    def _solve_qp(
        self,
        forecasts: ForecastBundle,
        state: Dict[str, Any],
        outer: OuterPlan,
    ) -> InnerAction:
        N = self.N

        # ── Current state ────────────────────────────────────────────────
        T_now     = float(state.get("temp", 20.0))
        T_comfort = float(state.get("temp_target", 21.0))
        H_now     = float(state.get("humidity", 45.0))
        P_now     = float(state.get("total_act_power", _BASE_LOAD_W + _HVAC_MIN_W))
        u_now     = max(_HVAC_MIN_W, P_now - _BASE_LOAD_W)
        cooling_allowed = not bool(state.get("heating_only", False))
        co2_now   = float(state.get("co2", 600.0))
        co2_ref   = float(state.get("co2_target", _CO2_REF))

        # ── Thermal sensitivity sign ────────────────────────────────────
        # Heating mode (T < target or heating-only): B > 0 → more power raises T
        # Cooling mode (T ≥ target and cooling allowed): B < 0 → more power lowers T
        if T_now >= T_comfort and cooling_allowed:
            B = -_B_COOL
        else:
            B = _B_HEAT
        S_T = _sensitivity_matrix(N, B)

        # ── Dense ST forecasts ──────────────────────────────────────────
        # Use ML forecast when available; otherwise synthesise a physics-based
        # cold-start trajectory so the QP works from the very first tick.
        if "temperature" in forecasts.by_feature:
            T_hat = _dense_forecast(forecasts.by_feature["temperature"].st, N)
            if np.any(np.isnan(T_hat)):
                # Physics fallback: temperature decays freely from T_now
                T_hat = np.array([(_A ** k) * T_now for k in range(1, N + 1)])
        else:
            # Cold-start: no ML yet — project temperature forward with physics
            # (flat conservative estimate; S_T will correct for HVAC action)
            T_hat = np.array([(_A ** k) * T_now for k in range(1, N + 1)])

        # Occupancy ST forecast (default 0 if feature not available)
        if "occupancy" in forecasts.by_feature:
            n_occ_st = np.clip(
                _dense_forecast(forecasts.by_feature["occupancy"].st, N, default=0.0),
                0.0, None,
            )
        else:
            n_occ_st = np.zeros(N)

        # CO2 ST forecast (default to current reading)
        if "airquality" in forecasts.by_feature:
            co2_st = _dense_forecast(
                forecasts.by_feature["airquality"].st, N, default=co2_now
            )
        else:
            co2_st = np.full(N, co2_now)

        # CO2 sensitivity matrix (linearised around forecast trajectory)
        S_CO2 = _co2_sensitivity_matrix(N, co2_st)

        # ── 1. Per-step dynamic temperature setpoints T*[k] ─────────────
        # Economy setpoint is bounded by T_comfort so night mode (T_comfort=15°C)
        # never causes unnecessary heating toward the hardcoded 17°C economy value.
        T_economy = min(_T_ECONOMY, T_comfort)

        # Occupancy-aware: economy when empty, comfort when occupied,
        # full-comfort target during pre-conditioning window.
        T_star = _occupancy_setpoints(n_occ_st, T_comfort, T_economy)

        # Fallback pre-heat: if the occupancy forecast is flat-zero (model
        # cold-start or poor training) but heating is allowed and the building
        # is significantly below the comfort setpoint, override economy-level
        # steps to T_comfort so the QP still pre-heats correctly.
        if cooling_allowed and T_now < T_comfort - 2.0:
            T_star = np.where(T_star < T_comfort - 1.0, T_comfort, T_star)

        # If the outer plan has a long-term t_star_lt, blend its first step
        # as a sanity anchor (soft override for the terminal step).
        t_star_lt = outer.refs.get("t_star_lt") or {}
        if t_star_lt and 1 in t_star_lt:
            T_star[-1] = float(0.7 * T_star[-1] + 0.3 * t_star_lt[1])

        # ── User-overridable QP cost weights ────────────────────────────
        # These can be tuned from the UI via the SimConfig weight sliders.
        # Defaults fall back to the module-level constants.
        # UI sends integer "dial" values; app.py scales them to real weights:
        #   W_smooth  = wSmooth  * 1e-5  (UI: 0–100, default 5  → 5e-5)
        #   W_energy  = wEnergy  * 1e-5  (UI: 0–100, default 30 → 3e-4)
        #   W_airqual = wAirqual * 0.01  (UI: 0–50,  default 8  → 0.08)
        #   W_comfort and Q_terminal passed as-is
        W_comfort  = float(state.get("w_comfort",  _W_COMFORT))
        W_airqual  = float(state.get("w_airqual",  _W_AIRQUAL))
        W_energy   = float(state.get("w_energy",   _W_ENERGY))
        W_smooth   = float(state.get("w_smooth",   _W_SMOOTH))
        Q_terminal = float(state.get("q_terminal", _Q_TERMINAL))

        # ── 2. Per-step comfort weights Q_T[k] ──────────────────────────
        # Occupancy scale: 0.25 (empty) → 1.8 (full).  Terminal step gets boost.
        n_max = float(state.get("n_occupants_max", 10.0))
        Q_T   = _occupancy_weights(n_occ_st, n_max)
        Q_T[-1] *= Q_terminal

        # ── 3. HVAC power bounds (no CO2 u_min floor — CO2 via cost) ────
        u_max_lt     = outer.refs.get("u_max_lt") or {}
        u_max_outer  = float(u_max_lt.get(1, _HVAC_MAX_W)) if u_max_lt else _HVAC_MAX_W
        u_max_global = float(np.clip(u_max_outer, _HVAC_MIN_W, _HVAC_MAX_W))
        u_min_vec    = np.full(N, _HVAC_MIN_W)

        # ── 4. Energy budget hard constraint ─────────────────────────────
        # Accounts for both heating power and ventilation fan draw.
        energy_budget_lt = outer.refs.get("energy_budget_lt")
        if energy_budget_lt and 1 in energy_budget_lt:
            hvac_avg_w  = max(0.0, float(energy_budget_lt[1]) - _BASE_LOAD_W)
            E_budget_wh = hvac_avg_w * N * _DT_H
        else:
            E_budget_wh = (u_max_global + _VENT_FAN_W) * N * _DT_H  # unconstrained

        # ── Build combined 2N decision vector w = [δu_heat(N), δv(N)] ───
        u_baseline = np.full(N, u_now)
        v_baseline = np.full(N, _VENT_BASE_FRAC)

        lb_u = u_min_vec - u_baseline
        ub_u = np.full(N, u_max_global) - u_baseline
        lb_v = -v_baseline                                  # v ≥ 0
        ub_v = np.full(N, _VENT_MAX_FRAC) - v_baseline     # v ≤ VENT_MAX_FRAC

        lb_w = np.concatenate([lb_u, lb_v])
        ub_w = np.concatenate([ub_u, ub_v])

        # Energy constraint: Σ (u[k]·dt + v[k]·VENT_FAN_W·dt) ≤ E_budget
        A_energy = np.hstack([np.ones(N) * _DT_H, np.ones(N) * _VENT_FAN_W * _DT_H])
        e_slack  = (E_budget_wh
                    - float(np.sum(u_baseline)) * _DT_H
                    - float(np.sum(v_baseline)) * _VENT_FAN_W * _DT_H)
        energy_con = LinearConstraint(A_energy.reshape(1, -1), -np.inf, e_slack)

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
            constraints=[energy_con],
            options={"ftol": 1e-8, "maxiter": 500},
        )

        w_opt  = result.x
        u_opt  = np.clip(u_baseline + w_opt[:N], u_min_vec, u_max_global)
        v_opt  = np.clip(v_baseline + w_opt[N:], 0.0, _VENT_MAX_FRAC)
        u_next = float(u_opt[0])
        v_next = float(v_opt[0])

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
                "T_pred_trajectory": [round(v, 2) for v in (T_hat + S_T @ w_opt[:N]).tolist()],
                "T_star_per_step":   [round(v, 2) for v in T_star.tolist()],
                "Q_T_per_step":      [round(v, 3) for v in Q_T.tolist()],
                "n_occ_forecast":    [round(v, 1) for v in n_occ_st.tolist()],
                "co2_forecast":      [round(v, 1) for v in co2_st.tolist()],
                "co2_ref":           round(co2_ref, 1),
                "humidity_now":      round(H_now, 1),
                "E_budget_wh":       round(E_budget_wh, 1),
                "u_max_applied_w":   round(u_max_global, 1),
                "B_sensitivity":     round(B, 6),
                "horizon_steps":     N,
                "W_comfort":         W_comfort,
                "W_airqual":         W_airqual,
                "W_energy":          W_energy,
                "W_smooth":          W_smooth,
                "Q_terminal":        Q_terminal,
            },
        )

    # ------------------------------------------------------------------
    # Proportional fallback  (when scipy absent or QP fails)
    # ------------------------------------------------------------------

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
