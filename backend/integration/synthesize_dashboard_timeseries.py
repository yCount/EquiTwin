from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd


REQUIRED_COLS = ["timestamp", "temperature", "airQuality", "occupancy", "energy"]


def _hourly_profile_from_observed(
    ts: pd.Series,
    values: pd.Series,
    *,
    default: float,
) -> np.ndarray:
    tmp = pd.DataFrame({"ts": ts, "v": values})
    tmp = tmp.dropna(subset=["ts"])
    tmp["hour"] = tmp["ts"].dt.hour
    med = tmp.groupby("hour", dropna=False)["v"].median()
    return np.array([float(med.get(h, default)) for h in range(24)], dtype=float)


def _synthesize_missing(df: pd.DataFrame, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    out = df.copy()
    ts = out["timestamp"]

    hour = ts.dt.hour
    dow = ts.dt.dayofweek
    is_weekend = (dow >= 5).astype(float)
    minute = ts.dt.minute
    day_of_year = ts.dt.dayofyear

    # --- Occupancy -----------------------------------------------------------
    occ = pd.to_numeric(out["occupancy"], errors="coerce")
    occ_obs = occ.dropna()
    occ_max_obs = float(occ_obs.quantile(0.95)) if not occ_obs.empty else 22.0
    occ_cap = max(12.0, min(80.0, occ_max_obs * 1.35))

    office_wave = np.exp(-((hour - 13.0) / 3.6) ** 2)
    shoulder = np.exp(-((hour - 9.0) / 2.0) ** 2) + np.exp(-((hour - 17.0) / 2.0) ** 2)
    occ_profile = (0.78 * office_wave + 0.22 * shoulder) * (1.0 - 0.62 * is_weekend)
    occ_profile = occ_profile / np.maximum(occ_profile.max(), 1e-6) * occ_cap
    occ_profile = np.where((hour < 5) | (hour >= 22), 0.0, occ_profile)
    occ_noise = rng.normal(0.0, max(0.5, occ_cap * 0.03), len(out))
    occ_syn = np.clip(occ_profile + occ_noise, 0.0, occ_cap)

    # Smooth occupancy changes so adjacent 15-min points behave realistically.
    for i in range(1, len(occ_syn)):
        occ_syn[i] = 0.74 * occ_syn[i - 1] + 0.26 * occ_syn[i]
    occ_syn = np.round(occ_syn).astype(float)
    occ = occ.fillna(pd.Series(occ_syn, index=out.index))
    out["occupancy"] = occ

    # --- Outdoor proxy for thermal/energy realism ---------------------------
    annual = 11.5 + 7.2 * np.sin(2 * np.pi * (day_of_year - 35) / 365.25)
    diurnal = 4.0 * np.sin(2 * np.pi * (hour - 15) / 24.0)
    outdoor_proxy = annual + diurnal + rng.normal(0.0, 0.6, len(out))

    # --- Temperature ---------------------------------------------------------
    temp = pd.to_numeric(out["temperature"], errors="coerce")
    temp_obs = temp.dropna()
    temp_center = float(temp_obs.median()) if not temp_obs.empty else 22.0
    setpoint = np.where((hour >= 8) & (hour <= 18) & (is_weekend < 0.5), 22.0, 20.0)
    temp_syn = (
        0.60 * setpoint
        + 0.22 * outdoor_proxy
        + 0.06 * occ.to_numpy()
        + 0.12 * temp_center
        + rng.normal(0.0, 0.35, len(out))
    )
    temp_syn = np.clip(temp_syn, 16.0, 29.0)
    for i in range(1, len(temp_syn)):
        temp_syn[i] = 0.82 * temp_syn[i - 1] + 0.18 * temp_syn[i]
    temp = temp.fillna(pd.Series(np.round(temp_syn, 2), index=out.index))
    out["temperature"] = temp

    # --- Energy (kW in dashboard timeseries) --------------------------------
    en = pd.to_numeric(out["energy"], errors="coerce")
    en_obs = en.dropna()
    en_base = float(en_obs.quantile(0.15)) if not en_obs.empty else 2.4
    en_p95 = float(en_obs.quantile(0.95)) if not en_obs.empty else 8.5
    thermal_load = np.maximum(0.0, np.abs(temp.to_numpy() - setpoint) - 0.3)
    occ_load = 0.065 * occ.to_numpy()
    night_setback = np.where((hour < 6) | (hour >= 22), -0.25, 0.0)
    en_syn = en_base + occ_load + 0.55 * thermal_load + night_setback + rng.normal(0.0, 0.14, len(out))
    en_syn = np.clip(en_syn, 0.7, max(1.0, en_p95 * 1.18))
    for i in range(1, len(en_syn)):
        en_syn[i] = 0.70 * en_syn[i - 1] + 0.30 * en_syn[i]
    en = en.fillna(pd.Series(np.round(en_syn, 3), index=out.index))
    out["energy"] = en

    # --- Air Quality (CO2 ppm) ----------------------------------------------
    aq = pd.to_numeric(out["airQuality"], errors="coerce")
    aq_obs = aq.dropna()
    aq_base = float(aq_obs.quantile(0.2)) if not aq_obs.empty else 470.0
    ventilation = np.clip((en.to_numpy() - en_base) * 32.0, 0.0, 170.0)
    aq_syn = aq_base + 24.0 * occ.to_numpy() + 1.8 * np.maximum(temp.to_numpy() - 22.0, 0.0) - ventilation
    aq_syn += rng.normal(0.0, 18.0, len(out))
    aq_syn = np.clip(aq_syn, 390.0, 2400.0)
    for i in range(1, len(aq_syn)):
        aq_syn[i] = 0.78 * aq_syn[i - 1] + 0.22 * aq_syn[i]
    aq = aq.fillna(pd.Series(np.round(aq_syn, 1), index=out.index))
    out["airQuality"] = aq

    # Optional helpers for downstream debug/QA
    for c in ["temperature", "airQuality", "occupancy", "energy"]:
        out[f"{c}_synthetic"] = pd.to_numeric(df[c], errors="coerce").isna().astype(int)

    return out


def _densify_to_15min(df: pd.DataFrame) -> pd.DataFrame:
    """
    Ensure a continuous 15-minute timeline from min(timestamp) to max(timestamp).
    Missing timestamps are inserted as empty rows (to be fully synthesized later).
    """
    base = df.sort_values("timestamp").drop_duplicates(subset=["timestamp"], keep="first").copy()
    if base.empty:
        return base

    full_ts = pd.date_range(
        start=base["timestamp"].min(),
        end=base["timestamp"].max(),
        freq="15min",
        tz="UTC",
    )
    full = pd.DataFrame({"timestamp": full_ts})
    dense = full.merge(base, on="timestamp", how="left", sort=True, indicator=True)
    dense["row_synthetic"] = (dense["_merge"] == "left_only").astype(int)
    dense = dense.drop(columns=["_merge"])
    return dense


def _build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description=(
            "Fill missing dashboard timeseries metrics with realistic synthetic values.\n"
            "Ensures temperature, airQuality, occupancy, and energy are complete on every row."
        )
    )
    ap.add_argument("--in", dest="in_csv", required=True, help="Input dashboard CSV path")
    ap.add_argument("--out", dest="out_csv", required=True, help="Output mixed CSV path")
    ap.add_argument("--seed", type=int, default=42, help="Random seed for reproducibility")
    return ap


def main() -> int:
    args = _build_parser().parse_args()
    in_path = Path(args.in_csv)
    out_path = Path(args.out_csv)

    df = pd.read_csv(in_path)
    missing_required = [c for c in REQUIRED_COLS if c not in df.columns]
    if missing_required:
        raise SystemExit(f"Missing required columns: {', '.join(missing_required)}")

    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    df = df.dropna(subset=["timestamp"]).sort_values("timestamp").reset_index(drop=True)
    df = _densify_to_15min(df)

    # Keep original display format used in dashboard exports.
    mixed = _synthesize_missing(df, seed=args.seed)
    mixed["timestamp"] = mixed["timestamp"].dt.strftime("%Y-%m-%d %H:%M:%S")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    mixed.to_csv(out_path, index=False)

    print(f"Input rows: {len(df)}")
    print(f"Output rows: {len(mixed)}")
    for c in ["temperature", "airQuality", "occupancy", "energy"]:
        na_count = int(pd.to_numeric(mixed[c], errors='coerce').isna().sum())
        synth_count = int(mixed.get(f"{c}_synthetic", pd.Series(dtype=int)).sum())
        print(f"{c}: nulls={na_count}, synthetic_fills={synth_count}")
    print(f"Wrote: {out_path}")
    ts = pd.to_datetime(mixed["timestamp"], errors="coerce")
    max_gap = ts.sort_values().diff().dropna().max()
    print(f"Max timestamp gap after synthesis: {max_gap}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
