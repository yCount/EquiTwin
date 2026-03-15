"""
Closed-loop digital-twin simulation of a real house.

Every iteration = 15 simulated minutes.  The EquiTwin MPC stack
(trained models + TickRunner) observes the current sensor readings,
produces HVAC setpoints, the house physics model responds to those
setpoints, and the resulting state becomes the next tick's sensor row
closing the feedback loop exactly as it would with real deployed sensors.

Physics model
-------------
Thermal:  First-order RC model
             dT/dt = (T_out - T_in) / tau + Q_hvac / C

CO2:      dCO2/dt = n_people * rate - vent_rate * (CO2 - CO2_outdoor)

Humidity: Driven by occupancy + HVAC dehumidification

Energy:   HVAC electrical draw from MPC output + base household load
"""
from __future__ import annotations

import argparse
import math
import os
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Tuple

import numpy as np
import pandas as pd

# House physics constants

HVAC_MAX_W       = 2500.0   # max HVAC electrical power [W]
HVAC_STANDBY_W   = 80.0     # fan-only draw when HVAC 'off' [W]
BASE_LOAD_W      = 380.0    # always-on household load (lighting, appliances) [W]
TAU_THERMAL_S    = 3 * 3600 # thermal time constant 3 h [s]
C_THERMAL_WH_C   = 800.0    # thermal capacitance [Wh/°C] — heavier construction
COP_HEAT         = 3.2      # heating coefficient of performance
COP_COOL         = 2.6      # cooling COP
PHASE_V          = [231.0, 232.0, 230.0]   # A, B, C phase voltages [V]
PHASE_SPLIT      = [0.35, 0.35, 0.30]      # fraction of load per phase

CO2_OUTDOOR_PPM  = 420.0    # outdoor CO2 baseline [ppm]
CO2_PER_PPL_TICK = 6.0      # CO2 added per person per 15-min tick [ppm]
CO2_VENT_FRAC    = 1 - math.exp(-15 / 120)  # standby ventilation fraction (tau=120 min)
                             # Used as default when no MPC vent_rate is provided.
VENT_BASE_FRAC   = CO2_VENT_FRAC             # alias — matches hierarchical.py _VENT_BASE_FRAC
VENT_MAX_FRAC    = 0.40                      # maximum ventilation fraction at full fan

HUM_BASE_PCT     = 45.0     # baseline indoor humidity [%RH]
HUM_PER_PPL_TICK = 0.1      # humidity added per person per tick [%RH]
                             # (reduced from 0.3 so dehumidification can overcome occupancy load;
                             #  real-world moisture generation varies widely with activity level)
HUM_DECAY_FRAC   = 1 - math.exp(-15 / 180)  # humidity decay per tick (tau=3 h)
HUM_DEHUMID_MIN  = 0.3      # %RH removed per tick at cooling threshold (500 W)
HUM_DEHUMID_MAX  = 1.5      # %RH removed per tick at maximum cooling power

DT_S             = 900.0    # seconds per tick (15 min)

# Building operation modes
class BuildingMode:
    PRE       = "PRE"
    WORKSHIFT = "WORKSHIFT"
    POST      = "POST"
    NIGHT     = "NIGHT"

_BMODE_LABEL: Dict[str, str] = {
    BuildingMode.PRE:       "PRE ",
    BuildingMode.WORKSHIFT: "WORK",
    BuildingMode.POST:      "POST",
    BuildingMode.NIGHT:     "NGHT",
}


@dataclass
class ScheduleConfig:
    """
    Building daily schedule.

    Phases (default):
      NIGHT     00:00 - 06:00  frost-protection, nobody present
      PRE       06:00 - 09:00  pre-condition building before staff arrive
      WORKSHIFT 09:00 - 18:00  max comfort, full occupancy
      POST      18:00 - 22:00  setpoint ramps down as building empties
      NIGHT     22:00 - 24:00  frost-protection again

    --- HVAC aggressiveness per mode
      PRE:  tight proportional band (1.5 °C) - heat up fast before staff arrive
      WORK: normal band (3.0 °C) - steady comfort
      POST: band widens linearly 3 to 6 °C - drifts toward night setpoint
      NIGHT: very wide band (8 °C), power capped at 600 W - frost-protection only
    """
    pre_start:   float = 6.0    # hour: NIGHT -> PRE
    work_start:  float = 9.0    # hour: PRE   -> WORKSHIFT
    work_end:    float = 18.0   # hour: WORKSHIFT -> POST
    night_start: float = 22.0   # hour: POST  -> NIGHT

    work_setpoint:  float = 21.0  # comfort target  [°C]
    night_setpoint: float = 15.0  # frost-protection minimum  [°C]
    n_occupants:    int   = 10    # headcount during WORKSHIFT

    # Proportional-band widths [°C]
    pre_band:   float = 1.5
    work_band:  float = 3.0
    post_band:  float = 6.0   # reached at end of POST; starts at work_band
    night_band: float = 8.0

    night_max_w: float = 600.0   # HVAC power cap during NIGHT  [W]


def get_building_mode(
    tick: int,
    start_hour: float,
    cfg: ScheduleConfig,
) -> Tuple[str, float, float, float, bool]:
    """
    Return (mode, setpoint, band, max_hvac_w, heating_only) for this tick.

    heating_only=True  - HVAC only heats; if indoor >= setpoint the unit idles
                         at standby and natural heat-loss cools the building.
                         Used for POST/NIGHT to avoid cooling a gradually
                         emptying building that just needs to drift down.
    """
    hour = (start_hour + tick * 15 / 60) % 24

    if cfg.pre_start <= hour < cfg.work_start:
        # PRE: heat up fast — tight band, full power, heat+cool allowed
        return (BuildingMode.PRE,
                cfg.work_setpoint, cfg.pre_band, HVAC_MAX_W, False)

    elif cfg.work_start <= hour < cfg.work_end:
        # WORKSHIFT: max comfort, no energy-saving constraints
        return (BuildingMode.WORKSHIFT,
                cfg.work_setpoint, cfg.work_band, HVAC_MAX_W, False)

    elif cfg.work_end <= hour < cfg.night_start:
        # POST: linearly ramp setpoint work_setpoint - night_setpoint
        #       and widen band work_band → post_band  (heating only)
        p = (hour - cfg.work_end) / (cfg.night_start - cfg.work_end)
        setpoint = cfg.work_setpoint + p * (cfg.night_setpoint - cfg.work_setpoint)
        band     = cfg.work_band     + p * (cfg.post_band      - cfg.work_band)
        return (BuildingMode.POST, setpoint, band, HVAC_MAX_W, True)

    else:
        # NIGHT: frost-protection only, heating only, capped power
        return (BuildingMode.NIGHT,
                cfg.night_setpoint, cfg.night_band, cfg.night_max_w, True)


def commercial_occupancy_at(
    tick: int,
    start_hour: float,
    cfg: ScheduleConfig,
) -> Tuple[int, int, int]:
    """
    Return (n_people, entries, exits) for a commercial building.
    All occupants arrive at work_start and leave at work_end.
    Building is empty during PRE, POST, and NIGHT.
    """
    hour      = (start_hour + tick * 15 / 60) % 24
    prev_hour = (start_hour + (tick - 1) * 15 / 60) % 24

    def _n(h: float) -> int:
        return cfg.n_occupants if cfg.work_start <= h < cfg.work_end else 0

    n_now   = _n(hour)
    n_prev  = _n(prev_hour)
    entries = max(0, n_now  - n_prev)
    exits   = max(0, n_prev - n_now)
    return n_now, entries, exits

# Synthetic weather  (used when WeatherClient not available)

def synthetic_weather(tick: int) -> Tuple[float, str, float]:
    """
    Return (outdoor_temp_C, weather_condition, sunlight_Wm2)
    based on a simple daily cycle.  Diurnal range 8-18 °C, sun 6am-8pm.
    """
    hour = (tick * 15 / 60) % 24

    # Temperature: min at ~6am, max at ~2pm
    temp = 8.0 + 5.0 * (1 + math.sin(2 * math.pi * (hour - 6) / 24))

    # Sunlight arc between sunrise (6h) and sunset (20h)
    if 6 <= hour <= 20:
        sun = max(0.0, 800.0 * math.sin(math.pi * (hour - 6) / 14))
    else:
        sun = 0.0

    if sun > 500:
        cond = "sunny"
    elif sun > 100:
        cond = "mostly_sunny"
    else:
        cond = "cloudy"

    return round(temp, 1), cond, round(sun, 1)


# House state + physics step
@dataclass
class HouseState:
    """Mutable simulation state updated every tick."""
    indoor_temp:      float = 20.0
    co2:              float = 600.0
    humidity:         float = 45.0
    cumulative_kwh:   float = 0.0
    hvac_power_w:     float = 0.0    # current electrical draw of HVAC
    n_people:         int   = 2

    def step(
        self,
        hvac_w:       float,
        outdoor_temp: float,
        n_people:     int,
        temp_target:  float,
        vent_rate:    Optional[float] = None,
    ) -> None:
        """Advance physics by one 15-minute tick.

        vent_rate: independent ventilation fraction [0, VENT_MAX_FRAC].
                   None → use standby baseline (CO2_VENT_FRAC).
                   Controlled directly by the MPC; decoupled from HVAC power.
        """
        self.n_people    = n_people
        self.hvac_power_w = hvac_w

        # Thermal
        # Q_hvac: positive = heating, negative = cooling  [W]
        if self.indoor_temp < temp_target:
            q_hvac = hvac_w * COP_HEAT
        else:
            q_hvac = -hvac_w * COP_COOL

        dT = (
            DT_S / TAU_THERMAL_S * (outdoor_temp - self.indoor_temp)
            + (q_hvac * DT_S / 3600.0) / C_THERMAL_WH_C
        )
        self.indoor_temp = round(self.indoor_temp + dT, 2)

        # CO2 — ventilation is now independent of HVAC power
        eff_vent_frac = vent_rate if vent_rate is not None else CO2_VENT_FRAC
        self.co2 += n_people * CO2_PER_PPL_TICK
        self.co2 -= eff_vent_frac * (self.co2 - CO2_OUTDOOR_PPM)
        self.co2  = max(CO2_OUTDOOR_PPM, round(self.co2, 1))

        # Humidity — decay toward baseline; ventilation above standby brings
        # in drier outdoor air for mild dehumidification
        self.humidity += n_people * HUM_PER_PPL_TICK
        if vent_rate is not None and vent_rate > VENT_BASE_FRAC:
            self.humidity -= (vent_rate - VENT_BASE_FRAC) * 2.0
        self.humidity -= HUM_DECAY_FRAC * (self.humidity - HUM_BASE_PCT)
        self.humidity  = max(20.0, min(95.0, round(self.humidity, 1)))

        # Energy — include ventilation fan draw
        vent_fan_w = (vent_rate if vent_rate is not None else VENT_BASE_FRAC) / VENT_MAX_FRAC * 200.0
        total_w = hvac_w + BASE_LOAD_W + vent_fan_w
        self.cumulative_kwh += total_w * DT_S / 3_600_000.0

    def to_sensor_row(
        self,
        timestamp:         pd.Timestamp,
        sensor_id:         str,
        outdoor_temp:      float,
        weather_condition: str,
        sunlight:          float,
        n_people:          int,
        entries:           int,
        exits:             int,
    ) -> Dict[str, Any]:
        """Build a sensor-row dict matching the EquiTwin signal schema."""
        total_w        = self.hvac_power_w + BASE_LOAD_W
        total_aprt_w   = total_w * 1.05          # power factor ~0.95
        total_current  = total_w / (PHASE_V[0] * math.sqrt(3))
        per_phase_w    = [total_w * f for f in PHASE_SPLIT]

        # Derive noisy-but-realistic ancillary readings
        rng = float(n_people)
        voc   = max(50.0,  80.0 + rng * 15.0  + float(np.random.normal(0, 4)))
        pm25  = max(1.0,    3.0 + rng * 0.5   + float(np.random.normal(0, 0.3)))
        pm10  = max(2.0,    5.0 + rng * 1.0   + float(np.random.normal(0, 0.6)))
        pm1   = max(0.5,    2.0 + rng * 0.3)
        pm4   = max(1.5,    4.0 + rng * 0.7)

        action = "NORMAL_EM" if self.hvac_power_w > HVAC_STANDBY_W else "NO_MOVEMENT"

        return {
            "timestamp":        timestamp,
            "sensor_id":        sensor_id,
            # Energy meter
            "total_act_power":  round(total_w, 1),
            "total_aprt_power": round(total_aprt_w, 1),
            "total_current":    round(total_current, 3),
            # Per-phase
            "a_act_power":      round(per_phase_w[0], 1),
            "b_act_power":      round(per_phase_w[1], 1),
            "c_act_power":      round(per_phase_w[2], 1),
            "a_voltage":        PHASE_V[0],
            "b_voltage":        PHASE_V[1],
            "c_voltage":        PHASE_V[2],
            # Indoor air quality
            "temp":             self.indoor_temp,
            "humidity":         self.humidity,
            "co2":              self.co2,
            "voc":              round(voc, 1),
            "pm2p5":            round(pm25, 2),
            "pm10":             round(pm10, 2),
            "pm1":              round(pm1, 2),
            "pm4":              round(pm4, 2),
            # Occupancy
            "num_targets":      float(n_people),
            "entries":          float(entries),
            "exits":            float(exits),
            # HVAC operating mode
            "action":           action,
            # Weather (TickRunner may overwrite with live values)
            "outdoor_temp":     outdoor_temp,
            "weather_condition": weather_condition,
            "sunlight":         sunlight,
        }

# Mode-aware HVAC controller
def mode_hvac(
    indoor_temp:  float,
    setpoint:     float,
    band:         float,
    max_w:        float,
    heating_only: bool,
) -> float:
    """
    Proportional HVAC controller parameterised by building mode.

    band        : proportional band [°C] — full power at this distance from setpoint
    max_w       : HVAC electrical power cap for this mode  [W]
    heating_only: if True and indoor_temp >= setpoint, return standby (no cooling);
                  the building drifts down naturally.  Used for POST and NIGHT.
    """
    if heating_only and indoor_temp >= setpoint:
        return HVAC_STANDBY_W          # already warm enough — no cooling needed

    error = abs(setpoint - indoor_temp)
    if error < 0.1:
        return HVAC_STANDBY_W
    fraction = min(1.0, error / band)
    return HVAC_STANDBY_W + fraction * (max_w - HVAC_STANDBY_W)

# Display helpers

_HDR = (
    f"{'Tick':>4}  {'Time':>5}  {'Mode':>6}  "
    f"{'T_in':>5}  {'T_out':>5}  {'T_set':>5}  {'CO2':>5}  "
    f"{'Hum':>4}  {'Occ':>3}  "
    f"{'HVAC_W':>6}  {'E_kwh':>6}  "
    f"{'Forecast_E_ST1':>14}  {'Refs'}"
)
_SEP = "-" * 106


def _print_header() -> None:
    print(_SEP)
    print(_HDR)
    print(_SEP)


def _print_tick(
    tick:         int,
    sim_ts:       pd.Timestamp,
    mode:         str,          # e.g. "WORK+" or "NGHT " (5 chars)
    house:        HouseState,
    outdoor_temp: float,
    setpoint:     float,        # active mode setpoint
    hvac_w:       float,        # decided HVAC command for this tick
    output,                     # ControlOutput | None
) -> None:
    time_str = sim_ts.strftime("%H:%M")

    # Forecast energy ST h=1 (next 15-min predicted power)
    fc_e = ""
    refs_str = ""
    if output is not None and output.warmed_up and output.error is None:
        eb = output.bundle.by_feature.get("energy")
        if eb and 1 in eb.st:
            fc_e = f"{eb.st[1][0]:>8.0f} W"
        else:
            fc_e = f"{'n/a':>8}"
        refs = output.outer_plan.refs
        parts = []
        if refs.get("energy_budget_lt"):
            first_step = min(refs["energy_budget_lt"])
            parts.append(f"E_budget={refs['energy_budget_lt'][first_step]:.0f}W")
        if refs.get("temp_ref_lt"):
            first_step = min(refs["temp_ref_lt"])
            parts.append(f"T_ref={refs['temp_ref_lt'][first_step]:.1f}C")
        if refs.get("outdoor_temp_ref_lt"):
            first_step = min(refs["outdoor_temp_ref_lt"])
            parts.append(f"T_out_ref={refs['outdoor_temp_ref_lt'][first_step]:.1f}C")
        inner = output.inner_action.info or {}
        if inner.get("solver") == "SLSQP":
            conv = "ok" if inner.get("converged") else "nc"
            parts.append(f"QP[{conv},it={inner.get('n_iter',0)}]")
        refs_str = "  ".join(parts)
    else:
        fc_e = f"{'warming':>8}"
        if output is not None and output.error:
            refs_str = output.error[:40]

    n_people = house.n_people
    print(
        f"[{mode:>5}]  "
        f"{time_str:>5}  "
        f"{house.indoor_temp:>5.1f}C  "
        f"{outdoor_temp:>5.1f}C  "
        f"{setpoint:>5.1f}C  "
        f"{house.co2:>5.0f}  "
        f"{house.humidity:>4.1f}%  "
        f"{n_people:>3}  "
        f"{hvac_w:>6.0f}  "
        f"{house.cumulative_kwh:>6.2f}  "
        f"{fc_e}  "
        f"{refs_str}"
    )

# Main simulation

SIGNAL_COLS = [
    "total_current", "total_act_power", "total_aprt_power",
    "temp", "humidity", "co2", "voc",
    "pm2p5", "pm10", "pm1", "pm4",
    "entries", "exits", "num_targets",
    "action",
    "a_voltage", "b_voltage", "c_voltage",
    "a_act_power", "b_act_power", "c_act_power",
    "outdoor_temp", "weather_condition", "sunlight",
]


def main() -> None:
    ap = argparse.ArgumentParser(
        description="EquiTwin digital-twin building simulation with 4 operational modes.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Building modes (default schedule):\n"
            "  NGHT  00:00-06:00  Night — frost-protection only, nobody present\n"
            "  PRE   06:00-09:00  Pre-shift — aggressive pre-heat, still empty\n"
            "  WORK  09:00-18:00  Workshift — max comfort, full occupancy\n"
            "  POST  18:00-22:00  Post-shift — setpoint ramps down as building empties\n"
            "  NGHT  22:00-24:00  Night again\n"
            "\n"
            "Display mode column: XXXX+ = MPC active,  XXXX  = warmup thermostat"
        ),
    )
    # Simulation basics
    ap.add_argument("--ticks",      type=int,   default=96,    help="Ticks to simulate (96=24h)")
    ap.add_argument("--speed",      type=float, default=0.0,   help="Sleep seconds per tick (0=fast)")
    ap.add_argument("--group",      type=str,   default="1",   help="Sensor group / zone ID")
    ap.add_argument("--artifacts",  type=str,   default="artifacts", help="Artifacts root directory")
    ap.add_argument("--start-hour", type=float, default=0.0,   help="Simulation start hour (0-24)")
    ap.add_argument("--init-temp",  type=float, default=14.0,  help="Initial indoor temperature [C]")
    # Schedule
    ap.add_argument("--pre-start",   type=float, default=6.0,  help="Hour NIGHT->PRE (default 6)")
    ap.add_argument("--work-start",  type=float, default=9.0,  help="Hour PRE->WORKSHIFT (default 9)")
    ap.add_argument("--work-end",    type=float, default=18.0, help="Hour WORKSHIFT->POST (default 18)")
    ap.add_argument("--night-start", type=float, default=22.0, help="Hour POST->NIGHT (default 22)")
    # Setpoints
    ap.add_argument("--setpoint",       type=float, default=21.0,
                    help="WORKSHIFT / PRE comfort setpoint [C]")
    ap.add_argument("--night-setpoint", type=float, default=15.0,
                    help="NIGHT frost-protection setpoint [C]")
    # Occupancy
    ap.add_argument("--occupants", type=int, default=10,
                    help="Number of occupants during WORKSHIFT")
    args = ap.parse_args()

    GROUP_ID = args.group

    # Build schedule config
    schedule = ScheduleConfig(
        pre_start=args.pre_start,
        work_start=args.work_start,
        work_end=args.work_end,
        night_start=args.night_start,
        work_setpoint=args.setpoint,
        night_setpoint=args.night_setpoint,
        n_occupants=args.occupants,
    )

    # Print
    lat = os.environ.get("WEATHER_LAT", "?")
    lon = os.environ.get("WEATHER_LON", "?")
    weather_src = f"Open-Meteo ({lat},{lon})" if lat != "?" else "synthetic (set WEATHER_LAT/LON)"
    print()
    print("=" * 80)
    print("  EquiTwin  |  Digital-Twin Building Simulation")
    print("=" * 80)
    print(f"  Ticks        : {args.ticks} x 15min = {args.ticks*15//60}h {args.ticks*15%60}min")
    print(f"  Initial temp : {args.init_temp} C")
    print(f"  Artifacts    : {args.artifacts}/")
    print(f"  Weather      : {weather_src}")
    print(f"  Speed        : {'max (no delay)' if args.speed == 0 else str(args.speed) + ' s/tick'}")
    print(f"  Schedule     : NGHT until {schedule.pre_start:.0f}h  |"
          f"  PRE {schedule.pre_start:.0f}-{schedule.work_start:.0f}h  |"
          f"  WORK {schedule.work_start:.0f}-{schedule.work_end:.0f}h  |"
          f"  POST {schedule.work_end:.0f}-{schedule.night_start:.0f}h  |"
          f"  NGHT {schedule.night_start:.0f}-24h")
    print(f"  Setpoints    : WORK/PRE={schedule.work_setpoint} C   "
          f"NIGHT={schedule.night_setpoint} C   "
          f"Occupants={schedule.n_occupants}")
    print("=" * 80)

    # Build EquiTwin stack
    print("\n[+] Building EquiTwin stack...")
    from equitwin_integration.bootstrap import EquiTwinConfig, build_equitwin_stack
    from equitwin_integration.tick_runner import TickRunner, TickRunnerConfig

    eq_cfg = EquiTwinConfig(
        artifacts_root=args.artifacts,
        default_group_id=GROUP_ID,
        signal_cols=SIGNAL_COLS,
    )
    stack  = build_equitwin_stack(eq_cfg)
    runner = TickRunner(
        stack,
        TickRunnerConfig(
            group_id=GROUP_ID,
            temp_target=schedule.work_setpoint,
            min_warm_rows=70,          # 70 x 15min = 17.5h before MPC activates
        ),
    )
    print(f"    Predictors loaded : {list(stack.predictors.keys())}")
    print(f"    Weather client    : {'active' if stack.weather_client else 'none (NaN)'}")

    # Initialise house state
    house = HouseState(
        indoor_temp=args.init_temp,
        co2=450.0,
        humidity=40.0,
    )

    # Simulation time base
    sim_start = pd.Timestamp("2025-06-01", tz="UTC") + pd.Timedelta(hours=args.start_hour)

    print(f"\n[+] Simulation starts at {sim_start.strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"    Thermal time const : {TAU_THERMAL_S//3600}h  |  "
          f"HVAC max: {HVAC_MAX_W:.0f} W  |  "
          f"COP heat/cool: {COP_HEAT}/{COP_COOL}")

    print()
    print("  [Mode+]  time  T_in  T_out  T_set  CO2  Hum  Occ  HVAC_W  E_kWh  FC_E_ST1  MPC_refs")
    print("  Mode: NGHT=Night  PRE=Pre-shift  WORK=Workshift  POST=Post-shift  +=MPC active")
    _print_header()

    # Main loop
    mpc_tick_count = 0

    for tick in range(args.ticks):
        sim_ts = sim_start + pd.Timedelta(minutes=15 * tick)

        # 1. Determine building mode and occupancy for this tick
        b_mode, setpoint, band, max_hvac_w, heating_only = get_building_mode(
            tick, args.start_hour, schedule)
        n_people, entries, exits = commercial_occupancy_at(
            tick, args.start_hour, schedule)

        # 2. Determine outdoor conditions
        t_out_synth, cond_synth, sun_synth = synthetic_weather(tick)
        outdoor_temp_phys = t_out_synth

        # 3. Build sensor row from current house state
        sensor_row = house.to_sensor_row(
            timestamp=sim_ts,
            sensor_id=GROUP_ID,
            outdoor_temp=outdoor_temp_phys,
            weather_condition=cond_synth,
            sunlight=sun_synth,
            n_people=n_people,
            entries=entries,
            exits=exits,
        )

        # 4. Run TickRunner tick  (buffer ingest + forecast + MPC)
        #    TickRunner._enrich_with_weather() overrides weather fields
        #    with live API values if WeatherClient is active.
        output = runner.tick(
            sensor_row=sensor_row,
            state={
                "temp_target":     setpoint,
                "temp":            house.indoor_temp,
                "total_act_power": house.hvac_power_w + BASE_LOAD_W,
                "heating_only":    heating_only,
            },
        )

        # 5. Compute HVAC power.
        #    When MPC is active use its optimised command (receding-horizon QP).
        #    Clip to mode limits so night-cap and heating-only rules are respected.
        #    Fall back to the mode-aware proportional controller during warm-up.
        mpc_active = output.warmed_up and output.error is None
        if mpc_active and output.inner_action.u.get("hvac_power_w") is not None:
            mpc_hvac = float(output.inner_action.u["hvac_power_w"])
            if heating_only and house.indoor_temp >= setpoint:
                hvac_w = HVAC_STANDBY_W
            else:
                hvac_w = float(np.clip(mpc_hvac, HVAC_STANDBY_W, max_hvac_w))
        else:
            hvac_w = mode_hvac(house.indoor_temp, setpoint, band, max_hvac_w, heating_only)

        # 6. Build display mode string
        if mpc_active:
            mpc_tick_count += 1
        display_mode = f"{_BMODE_LABEL[b_mode]}{'+'  if mpc_active else ' '}"

        # 7. Print status BEFORE physics step
        _print_tick(tick, sim_ts, display_mode, house, outdoor_temp_phys,
                    setpoint, hvac_w, output)

        # 8. Advance house physics
        vent_rate = None
        if mpc_active and output.inner_action.u.get("vent_rate") is not None:
            vent_rate = float(output.inner_action.u["vent_rate"])
        house.step(
            hvac_w=hvac_w,
            outdoor_temp=outdoor_temp_phys,
            n_people=n_people,
            temp_target=setpoint,
            vent_rate=vent_rate,
        )

        if args.speed > 0:
            time.sleep(args.speed)

    # Summary
    print(_SEP)
    print()
    b_mode_final, setpoint_final, *_ = get_building_mode(
        args.ticks - 1, args.start_hour, schedule)
    print("=" * 80)
    print("  Simulation complete")
    print("=" * 80)
    print(f"  Final indoor temp  : {house.indoor_temp:.2f} C"
          f"  (active setpoint: {setpoint_final:.1f} C  [{b_mode_final}])")
    print(f"  Final CO2          : {house.co2:.0f} ppm")
    print(f"  Final humidity     : {house.humidity:.1f} %RH")
    print(f"  Total energy used  : {house.cumulative_kwh:.2f} kWh"
          f"  (HVAC + base load over {args.ticks} ticks)")
    print(f"  MPC ticks          : {mpc_tick_count} / {args.ticks}")
    print()


if __name__ == "__main__":
    main()
