"""
Generates a physically realistic synthetic 15-minute timeseries dataset
for training the EquiTwin forecasting models.

Unlike synthesize_dashboard_timeseries.py (which fills gaps in existing data),
this script generates a COMPLETE dataset from scratch with proper physical
relationships between variables.

Physical model:
  Occupancy  - trapezoid profile (arrival 7-9am, peak 9am-5pm, leave 5-7pm)
              - weekend 10% of weekday capacity, sporadic
  Temperature - HVAC drives toward setpoint during occupied hours
              - drifts toward outdoor temp when empty
              - thermal inertia time constant ~2h (α = exp(-dt/τ))
  Energy      - base load + occupancy component + HVAC thermal load
              - HVAC pre-heat starts 1h before occupancy
  CO2         - ventilation equation: accumulates with people, decays when empty
              - outdoor ambient ~420ppm
  Humidity    - base 42% + occupancy effect
  Weather     - Glasgow seasonal temperature + diurnal variation

Usage:
  python -m integration.generate_synthetic_training_data \\
      --weeks 16 --out exports/dashboard.csv

  # Merge with existing real data (preserves real rows, appends synthetic weeks):
  python -m integration.generate_synthetic_training_data \\
      --weeks 12 --merge-real exports/dashboard.csv --out exports/dashboard.csv
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

# Physical constants / building parameters

class BuildingParams:
    """Tuneable building physics parameters."""

    # Occupancy
    max_occupancy: float = 80.0       # peak people count (weekday)
    weekend_fraction: float = 0.08    # fraction of max on weekends

    # Working hours (24h clock, fractional)
    work_start: float = 7.0           # people start arriving
    work_peak_start: float = 9.0      # full occupancy begins
    work_peak_end: float = 17.0       # people start leaving
    work_end: float = 19.0            # building empty

    # HVAC / Temperature
    setpoint_occupied: float = 22.0   # °C during occupied hours
    setpoint_unoccupied: float = 19.0 # °C night setback
    hvac_start_offset: float = 1.0    # h before work_start to pre-heat
    thermal_tau_min: float = 90.0     # thermal inertia time constant (minutes)
    outdoor_influence: float = 0.12   # outdoor→indoor coupling fraction

    # Energy (kW)
    energy_base: float = 1.9          # always-on load (servers, refrigeration)
    energy_lighting: float = 1.2      # max lighting at full occupancy
    energy_equipment: float = 1.5     # max equipment (computers) at full occupancy
    energy_hvac_coeff: float = 0.35   # kW per °C delta from setpoint
    energy_hvac_max: float = 3.5      # max HVAC power (kW)

    # CO2 (ppm)
    co2_ambient: float = 420.0        # outdoor ambient
    co2_generation_per_person: float = 0.4  # ppm/min per person in the space
    ventilation_occupied: float = 0.08      # air exchanges per minute when HVAC on
    ventilation_unoccupied: float = 0.015   # natural infiltration only

    # Humidity (%)
    humidity_base: float = 42.0
    humidity_per_person: float = 0.25

    # Weather: Glasgow (lat=55.86)
    annual_temp_mean: float = 9.5     # °C
    annual_temp_amp: float = 6.5      # seasonal amplitude
    diurnal_temp_amp: float = 4.5     # day/night swing
    annual_peak_day: int = 200        # ~mid-July

    # Noise levels (σ)
    noise_occupancy: float = 0.05     # fraction of current value
    noise_temp: float = 0.18          # °C
    noise_energy: float = 0.10        # kW
    noise_co2: float = 15.0           # ppm
    noise_humidity: float = 0.8       # %
    noise_outdoor: float = 0.5        # °C


def _occupancy_profile(hour_frac: np.ndarray, dow: np.ndarray, p: BuildingParams) -> np.ndarray:
    """
    Returns an occupancy fraction [0..1] per timestep.
    Uses a trapezoid profile for weekdays, scaled down for weekends.
    """
    is_weekday = (dow < 5).astype(float)
    is_weekend = 1.0 - is_weekday

    ws, wps, wpe, we = p.work_start, p.work_peak_start, p.work_peak_end, p.work_end

    # Trapezoid: ramp up, plateau, ramp down
    ramp_up   = np.clip((hour_frac - ws) / (wps - ws), 0.0, 1.0)
    plateau   = np.where(hour_frac >= wps, 1.0, 0.0)
    ramp_down = np.clip((we - hour_frac) / (we - wpe), 0.0, 1.0)
    profile   = np.minimum(np.minimum(ramp_up, plateau), ramp_down)

    # Zero outside work_start..work_end
    profile = np.where((hour_frac < ws) | (hour_frac > we), 0.0, profile)

    weekday_occ = profile * p.max_occupancy
    weekend_occ = profile * p.max_occupancy * p.weekend_fraction

    return weekday_occ * is_weekday + weekend_occ * is_weekend


def _outdoor_temperature(day_of_year: np.ndarray, hour_frac: np.ndarray, p: BuildingParams, rng: np.random.Generator) -> np.ndarray:
    """Seasonal + diurnal outdoor temperature."""
    seasonal = p.annual_temp_mean + p.annual_temp_amp * np.sin(
        2 * np.pi * (day_of_year - p.annual_peak_day) / 365.25
    )
    diurnal = p.diurnal_temp_amp * np.sin(2 * np.pi * (hour_frac - 15.0) / 24.0)
    noise = rng.normal(0.0, p.noise_outdoor, len(day_of_year))
    return seasonal + diurnal + noise


def _simulate(
    timestamps: pd.DatetimeIndex,
    p: BuildingParams,
    rng: np.random.Generator,
) -> pd.DataFrame:
    """Core physics simulation — returns a DataFrame with all signals."""
    n = len(timestamps)
    dt_min = 15.0  # minutes per step (assumes uniform 15-min steps)

    hour_frac = timestamps.hour + timestamps.minute / 60.0
    day_of_year = timestamps.dayofyear
    dow = timestamps.dayofweek

    #  Outdoor temperature 
    outdoor = _outdoor_temperature(
        np.array(day_of_year, dtype=float),
        np.array(hour_frac, dtype=float),
        p, rng,
    )

    #  Occupancy 
    occ_profile = _occupancy_profile(
        np.array(hour_frac, dtype=float),
        np.array(dow, dtype=int),
        p,
    )
    # Add Poisson-like noise that scales with current value (integer counts)
    occ_noise = rng.normal(0.0, np.maximum(occ_profile * p.noise_occupancy, 0.5))
    occ_raw = np.clip(occ_profile + occ_noise, 0.0, p.max_occupancy)
    # Smooth with a MILD exponential filter (τ = 2 steps = 30 min)
    alpha_occ = 1.0 - np.exp(-dt_min / 30.0)  # α ≈ 0.39
    occ = np.empty(n)
    occ[0] = occ_raw[0]
    for i in range(1, n):
        occ[i] = (1 - alpha_occ) * occ[i - 1] + alpha_occ * occ_raw[i]
    occ = np.round(np.clip(occ, 0.0, p.max_occupancy))

    #  HVAC setpoint schedule 
    hvac_on = np.zeros(n, dtype=bool)
    for i in range(n):
        hf = hour_frac[i]
        d = dow[i]
        # HVAC runs from hvac_start_offset before work to work_end, on weekdays
        if d < 5:
            hvac_on[i] = (p.work_start - p.hvac_start_offset) <= hf <= p.work_end
        else:
            # Weekend: HVAC only if there are people
            hvac_on[i] = occ[i] > 2

    setpoint = np.where(hvac_on, p.setpoint_occupied, p.setpoint_unoccupied)

    #  Indoor Temperature 
    # HVAC drives temp toward setpoint; outdoor leaks through envelope.
    # dT/dt ≈ (T_target - T_indoor) / τ  where T_target blends setpoint + outdoor
    alpha_t = 1.0 - np.exp(-dt_min / p.thermal_tau_min)  # α ≈ 0.15 at 90 min τ
    temp = np.empty(n)
    temp[0] = p.setpoint_occupied
    for i in range(1, n):
        target_raw = setpoint[i] * (1 - p.outdoor_influence) + outdoor[i] * p.outdoor_influence
        temp[i] = (1 - alpha_t) * temp[i - 1] + alpha_t * target_raw
    temp += rng.normal(0.0, p.noise_temp, n)
    temp = np.clip(temp, 14.0, 30.0)

    #  Energy (kW) 
    occ_fraction = occ / p.max_occupancy
    thermal_delta = np.abs(temp - setpoint)
    hvac_power = np.clip(p.energy_hvac_coeff * thermal_delta, 0.0, p.energy_hvac_max)
    # HVAC only draws power when active
    hvac_power = np.where(hvac_on, hvac_power, hvac_power * 0.25)  # small residual for frost protection
    lighting = p.energy_lighting * occ_fraction
    equipment = p.energy_equipment * occ_fraction

    energy_raw = p.energy_base + hvac_power + lighting + equipment
    energy_raw += rng.normal(0.0, p.noise_energy, n)
    # Mild smoothing (τ = 15 min = 1 step), this keeps variance visible
    alpha_e = 1.0 - np.exp(-dt_min / 15.0)  # α ≈ 0.63
    energy = np.empty(n)
    energy[0] = energy_raw[0]
    for i in range(1, n):
        energy[i] = (1 - alpha_e) * energy[i - 1] + alpha_e * energy_raw[i]
    energy = np.clip(energy, 0.5, p.energy_base + p.energy_lighting + p.energy_equipment + p.energy_hvac_max + 1.0)

    #  CO2 (ppm) 
    # Differential equation per step:
    #   C(t+dt) = C(t) + dt * (generation_rate - ventilation_rate * (C(t) - C_amb))
    # generation_rate: ppm/min per person in space_volume
    # ventilation_rate: fraction of air replaced per minute
    co2 = np.empty(n)
    co2[0] = p.co2_ambient + 50.0  # slightly elevated start
    for i in range(1, n):
        vent = p.ventilation_occupied if hvac_on[i] else p.ventilation_unoccupied
        generation = occ[i] * p.co2_generation_per_person  # ppm/min
        decay = vent * (co2[i - 1] - p.co2_ambient)
        co2[i] = co2[i - 1] + dt_min * (generation - decay)
    co2 += rng.normal(0.0, p.noise_co2, n)
    co2 = np.clip(co2, 390.0, 3000.0)

    #  Humidity (%) 
    humidity = p.humidity_base + p.humidity_per_person * occ + rng.normal(0.0, p.noise_humidity, n)
    humidity = np.clip(humidity, 28.0, 72.0)

    #  Circuits 
    # Split energy into two circuits: HVAC on c0, lighting+equipment on c1
    circuit0 = np.clip(p.energy_base + hvac_power, 0.5, energy)
    circuit1 = np.clip(energy - circuit0, 0.0, energy)

    #  Weather condition string 
    conditions_pool = ["clear", "partly_cloudy", "overcast", "light_rain", "fog"]
    # Rough seasonal probability weighting: more rain in winter
    month = np.array(timestamps.month, dtype=int)
    is_summer = (month >= 6) & (month <= 8)
    cond_idx = np.where(
        is_summer,
        rng.integers(0, 3, n),     # clear/partly_cloudy/overcast in summer
        rng.integers(1, 5, n),     # partly_cloudy..fog in winter
    )
    condition = np.array([conditions_pool[i] for i in cond_idx])

    #  Sunlight (0..1 fraction, 0 at night) 
    # Simple sinusoid between sunrise and sunset
    # Glasgow: summer sunrise ~4am, sunset ~10pm; winter ~8am..4pm
    daylen_hours = 8.0 + 6.0 * np.sin(2 * np.pi * (day_of_year - 80) / 365.25)
    sunrise = 12.0 - daylen_hours / 2.0
    sunset = 12.0 + daylen_hours / 2.0
    sun_angle = np.pi * (hour_frac - sunrise) / (sunset - sunrise)
    sunlight = np.where(
        (hour_frac >= sunrise) & (hour_frac <= sunset),
        np.clip(np.sin(sun_angle), 0.0, 1.0),
        0.0,
    )
    # Cloud cover reduces sunlight
    cloud_factor = np.where(cond_idx == 0, 1.0,
                   np.where(cond_idx == 1, 0.7,
                   np.where(cond_idx == 2, 0.3, 0.1)))
    sunlight *= cloud_factor

    df = pd.DataFrame({
        "timestamp": timestamps.strftime("%Y-%m-%d %H:%M:%S"),
        "temperature": np.round(temp, 2),
        "airQuality": np.round(co2, 1),
        "occupancy": occ.astype(float),
        "energy": np.round(energy, 3),
        "circuit0": np.round(circuit0, 3),
        "circuit1": np.round(circuit1, 3),
        "weather": np.round(outdoor, 1),
        "condition": condition,
        "humidity": np.round(humidity, 1),
        "sunlight": np.round(sunlight, 3),
        "row_synthetic": 1,
        "temperature_synthetic": 1,
        "airQuality_synthetic": 1,
        "occupancy_synthetic": 1,
        "energy_synthetic": 1,
    })
    return df


def generate(
    *,
    weeks: int = 16,
    start_date: str | None = None,
    seed: int = 42,
    params: BuildingParams | None = None,
) -> pd.DataFrame:
    """
    Generate `weeks` weeks of 15-minute synthetic building data.

    Parameters
    ----------
    weeks : int
        Number of weeks to generate. 16 weeks (4 months) is recommended
        to ensure full weekday/weekend + seasonal coverage.
    start_date : str or None
        ISO date string for the first timestamp.  Defaults to (today - weeks).
    seed : int
        NumPy random seed for reproducibility.
    params : BuildingParams or None
        Override default building physics.
    """
    p = params or BuildingParams()
    rng = np.random.default_rng(seed)

    if start_date is None:
        end = pd.Timestamp.now(tz="UTC").normalize()
        start = end - pd.Timedelta(weeks=weeks)
    else:
        start = pd.Timestamp(start_date, tz="UTC")
        end = start + pd.Timedelta(weeks=weeks)

    timestamps = pd.date_range(start=start, end=end, freq="15min", tz="UTC")
    return _simulate(timestamps, p, rng)


def merge_with_real(synthetic: pd.DataFrame, real_csv: Path) -> pd.DataFrame:
    """
    Combine a synthetic DataFrame with the existing real dashboard.csv.

    Strategy:
    - Keep all rows from real_csv that are within the same date range (they
      take priority at their timestamps).
    - Append synthetic rows only for timestamps NOT covered by the real data.
    """
    real = pd.read_csv(real_csv)
    real["timestamp"] = pd.to_datetime(real["timestamp"], utc=True, errors="coerce")
    real = real.dropna(subset=["timestamp"]).sort_values("timestamp")

    syn_ts = pd.to_datetime(synthetic["timestamp"], utc=True, errors="coerce")
    real_ts_set = set(real["timestamp"].dt.strftime("%Y-%m-%d %H:%M:%S"))
    syn_mask = ~syn_ts.dt.strftime("%Y-%m-%d %H:%M:%S").isin(real_ts_set)

    real["timestamp"] = real["timestamp"].dt.strftime("%Y-%m-%d %H:%M:%S")
    combined = pd.concat(
        [real, synthetic[syn_mask]],
        ignore_index=True,
        sort=False,
    )
    combined = combined.sort_values("timestamp").reset_index(drop=True)
    return combined


def _build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Generate realistic synthetic building timeseries for training.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--weeks", type=int, default=16,
                    help="Number of weeks of synthetic data to generate.")
    ap.add_argument("--start-date", default=None,
                    help="Start date (YYYY-MM-DD). Defaults to today minus --weeks.")
    ap.add_argument("--seed", type=int, default=42,
                    help="Random seed.")
    ap.add_argument("--max-occupancy", type=float, default=80.0,
                    help="Peak occupancy count.")
    ap.add_argument("--out", required=True,
                    help="Output CSV path.")
    ap.add_argument("--merge-real", default=None,
                    help="If set, merge with existing CSV at this path (real rows take priority).")
    return ap


def main() -> int:
    args = _build_parser().parse_args()
    p = BuildingParams()
    p.max_occupancy = args.max_occupancy

    df = generate(weeks=args.weeks, start_date=args.start_date, seed=args.seed, params=p)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if args.merge_real and Path(args.merge_real).exists():
        df = merge_with_real(df, Path(args.merge_real))
        print(f"Merged with real data from: {args.merge_real}")

    df.to_csv(out_path, index=False)

    ts = pd.to_datetime(df["timestamp"], errors="coerce")
    print(f"Rows:      {len(df)}")
    print(f"Range:     {ts.min()} to {ts.max()}")
    print(f"Duration:  {(ts.max() - ts.min()).days} days")
    synth_col = df.get("row_synthetic", pd.Series(dtype=int))
    if synth_col is not None:
        n_synth = int(synth_col.sum())
        print(f"Synthetic: {n_synth} rows ({100*n_synth/len(df):.1f}%)")
    print(f"Wrote:     {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
