from __future__ import annotations

import threading
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd


CSV_DB_COLUMNS = [
    "id",
    "timestamp",
    "event_type",
    "event_label",
    "net_occupancy",
    "temp",
    "humidity",
    "co2",
    "total_act_power",
    "num_targets",
    "entries",
    "exits",
]

_CACHE_LOCK = threading.Lock()
_CACHE: Dict[str, Any] = {
    "sig": None,
    "rows_table": None,
    "timeseries_payload": None,
}


def _load_archive_weather_rows(start_date: str, end_date: str) -> List[Dict[str, Any]]:
    try:
        from core.weather_client import WeatherClient

        wc = WeatherClient(55.8617, -4.2583)  # Glasgow (same backend default)
        wdf = wc.get_historical_df(start_date, end_date)
        if wdf.empty:
            return []

        rows: List[Dict[str, Any]] = []
        for _, row in wdf.iterrows():
            ts = row.get("timestamp")
            outdoor_temp = row.get("outdoor_temp")
            if pd.isna(ts) or pd.isna(outdoor_temp):
                continue
            rows.append(
                {
                    "ts": ts.isoformat(),
                    "value": round(float(outdoor_temp), 1),
                    "condition": str(row.get("weather_condition", "cloudy")),
                }
            )
        return rows
    except Exception as exc:
        print(f"[csv_source] Weather archive backfill failed for {start_date}..{end_date}: {exc}")
        return []


def _build_weather_payload(
    df: pd.DataFrame,
    *,
    ts_values: pd.Series,
) -> List[Dict[str, Any]]:
    weather_by_ts: Dict[str, Dict[str, Any]] = {}
    latest_weather_ts = None

    if "weather" in df.columns:
        weather = pd.to_numeric(df["weather"], errors="coerce")
        condition = (
            df["condition"].fillna("cloudy").astype(str)
            if "condition" in df.columns
            else pd.Series("cloudy", index=df.index)
        )

        for ts, value, cond in zip(ts_values, weather, condition):
            if pd.isna(ts) or pd.isna(value):
                continue
            ts_key = ts if isinstance(ts, str) else ts.isoformat()
            weather_by_ts[ts_key] = {
                "ts": ts_key,
                "value": round(float(value), 1),
                "condition": str(cond),
            }

        valid_weather_mask = weather.notna()
        if valid_weather_mask.any():
            latest_weather_ts = pd.to_datetime(
                df.loc[valid_weather_mask, "timestamp"],
                utc=True,
                errors="coerce",
            ).max()

    max_sensor_ts = pd.to_datetime(df["timestamp"], utc=True, errors="coerce").max()
    needs_backfill = (
        max_sensor_ts is not None
        and not pd.isna(max_sensor_ts)
        and (
            latest_weather_ts is None
            or pd.isna(latest_weather_ts)
            or latest_weather_ts < max_sensor_ts
        )
    )
    if needs_backfill:
        start_ts = latest_weather_ts if latest_weather_ts is not None and not pd.isna(latest_weather_ts) else pd.to_datetime(
            df["timestamp"], utc=True, errors="coerce"
        ).min()
        if start_ts is not None and not pd.isna(start_ts):
            archive_rows = _load_archive_weather_rows(
                start_ts.strftime("%Y-%m-%d"),
                max_sensor_ts.strftime("%Y-%m-%d"),
            )
            for row in archive_rows:
                weather_by_ts.setdefault(row["ts"], row)

    return [weather_by_ts[ts] for ts in sorted(weather_by_ts)]


def load_dashboard_csv(path) -> pd.DataFrame:
    df = pd.read_csv(path)
    if "timestamp" not in df.columns:
        raise ValueError("CSV must contain a 'timestamp' column.")
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    df = df.dropna(subset=["timestamp"]).sort_values("timestamp").reset_index(drop=True)
    return df


def _file_sig(path) -> tuple:
    p = str(path)
    st = path.stat()
    return (p, int(st.st_mtime_ns), int(st.st_size))


def _to_iso_series(ts: pd.Series) -> pd.Series:
    return ts.dt.strftime("%Y-%m-%dT%H:%M:%S+00:00")


def build_timeseries_from_csv(df: pd.DataFrame) -> Dict[str, Any]:
    out = {
        "temperature": [],
        "airQuality": [],
        "occupancy": [],
        "energy": [],
        "weather": [],
        "source_mode": "csv",
    }

    if "temperature" in df.columns:
        vals = pd.to_numeric(df["temperature"], errors="coerce")
        out["temperature"] = [
            {"ts": ts.isoformat(), "value": round(float(v), 2)}
            for ts, v in zip(df["timestamp"], vals)
            if pd.notna(v)
        ]

    if "airQuality" in df.columns:
        vals = pd.to_numeric(df["airQuality"], errors="coerce")
        out["airQuality"] = [
            {"ts": ts.isoformat(), "value": round(float(v), 1)}
            for ts, v in zip(df["timestamp"], vals)
            if pd.notna(v)
        ]

    if "occupancy" in df.columns:
        vals = pd.to_numeric(df["occupancy"], errors="coerce")
        out["occupancy"] = [
            {"ts": ts.isoformat(), "value": int(max(0, round(float(v))))}
            for ts, v in zip(df["timestamp"], vals)
            if pd.notna(v)
        ]

    if "energy" in df.columns:
        e = pd.to_numeric(df["energy"], errors="coerce")
        c0 = pd.to_numeric(df.get("circuit0"), errors="coerce") if "circuit0" in df.columns else e
        c1 = pd.to_numeric(df.get("circuit1"), errors="coerce") if "circuit1" in df.columns else pd.Series(0.0, index=df.index)
        out["energy"] = [
            {
                "ts": ts.isoformat(),
                "value": round(float(ev), 3),
                "circuit0": round(float(cv0), 3) if pd.notna(cv0) else 0.0,
                "circuit1": round(float(cv1), 3) if pd.notna(cv1) else 0.0,
            }
            for ts, ev, cv0, cv1 in zip(df["timestamp"], e, c0, c1)
            if pd.notna(ev)
        ]

    out["weather"] = _build_weather_payload(df, ts_values=df["timestamp"])

    return out


def _build_rows_table(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["id"] = np.arange(1, len(out) + 1)
    out["event_type"] = "SYNTHETIC_TS"
    out["event_label"] = "Synthetic+Observed Mix"

    occ = pd.to_numeric(out.get("occupancy"), errors="coerce").fillna(0)
    out["net_occupancy"] = np.maximum(0, np.round(occ)).astype(int)
    out["num_targets"] = out["net_occupancy"]

    occ_diff = out["net_occupancy"].diff().fillna(0)
    out["entries"] = occ_diff.clip(lower=0).astype(int)
    out["exits"] = (-occ_diff.clip(upper=0)).astype(int)

    out["temp"] = pd.to_numeric(out.get("temperature"), errors="coerce")
    out["co2"] = pd.to_numeric(out.get("airQuality"), errors="coerce")

    energy = pd.to_numeric(out.get("energy"), errors="coerce")
    scale = 1000.0 if (float(energy.median()) if energy.notna().any() else 0.0) < 50.0 else 1.0
    out["total_act_power"] = energy * scale

    if "humidity" not in out.columns:
        out["humidity"] = np.clip(
            42.0 + 0.28 * out["num_targets"].fillna(0) - 0.35 * (out["temp"].fillna(22.0) - 22.0),
            28.0,
            70.0,
        )

    out["timestamp"] = out["timestamp"].dt.strftime("%Y-%m-%d %H:%M:%S")
    return out[CSV_DB_COLUMNS].copy()


def _build_timeseries_payload(df: pd.DataFrame) -> Dict[str, Any]:
    ts_iso = _to_iso_series(df["timestamp"])
    out = {
        "temperature": [],
        "airQuality": [],
        "occupancy": [],
        "energy": [],
        "weather": [],
        "source_mode": "csv",
    }

    if "temperature" in df.columns:
        t = pd.to_numeric(df["temperature"], errors="coerce")
        m = t.notna()
        out["temperature"] = [
            {"ts": ts, "value": round(float(v), 2)}
            for ts, v in zip(ts_iso[m], t[m])
        ]

    if "airQuality" in df.columns:
        aq = pd.to_numeric(df["airQuality"], errors="coerce")
        m = aq.notna()
        out["airQuality"] = [
            {"ts": ts, "value": round(float(v), 1)}
            for ts, v in zip(ts_iso[m], aq[m])
        ]

    if "occupancy" in df.columns:
        occ = pd.to_numeric(df["occupancy"], errors="coerce")
        m = occ.notna()
        out["occupancy"] = [
            {"ts": ts, "value": int(max(0, round(float(v))))}
            for ts, v in zip(ts_iso[m], occ[m])
        ]

    if "energy" in df.columns:
        e = pd.to_numeric(df["energy"], errors="coerce")
        c0 = pd.to_numeric(df.get("circuit0"), errors="coerce") if "circuit0" in df.columns else e
        c1 = pd.to_numeric(df.get("circuit1"), errors="coerce") if "circuit1" in df.columns else pd.Series(0.0, index=df.index)
        m = e.notna()
        out["energy"] = [
            {
                "ts": ts,
                "value": round(float(ev), 3),
                "circuit0": round(float(cv0), 3) if pd.notna(cv0) else 0.0,
                "circuit1": round(float(cv1), 3) if pd.notna(cv1) else 0.0,
            }
            for ts, ev, cv0, cv1 in zip(ts_iso[m], e[m], c0[m], c1[m])
        ]

    out["weather"] = _build_weather_payload(df, ts_values=ts_iso)

    return out


def _ensure_cache(path) -> None:
    sig = _file_sig(path)
    with _CACHE_LOCK:
        if _CACHE["sig"] == sig:
            return
        df = load_dashboard_csv(path)
        _CACHE["rows_table"] = _build_rows_table(df)
        _CACHE["timeseries_payload"] = _build_timeseries_payload(df)
        _CACHE["sig"] = sig


def get_cached_timeseries_from_csv(path) -> Dict[str, Any]:
    _ensure_cache(path)
    return _CACHE["timeseries_payload"]


def get_cached_db_rows_page_from_csv(path, *, page: int = 1, page_size: int = 50) -> Dict[str, Any]:
    _ensure_cache(path)
    out = _CACHE["rows_table"]
    page_size = max(1, min(int(page_size), 200))
    page = max(1, int(page))

    total = len(out)
    total_pages = max(1, (total + page_size - 1) // page_size)
    start = (page - 1) * page_size
    end = start + page_size
    view = out.iloc[start:end]

    rows: List[Dict[str, Any]] = [
        {col: (None if pd.isna(v) else v) for col, v in row.items()}
        for row in view.to_dict(orient="records")
    ]
    return {
        "rows": rows,
        "total": int(total),
        "page": int(page),
        "page_size": int(page_size),
        "total_pages": int(total_pages),
        "columns": list(CSV_DB_COLUMNS),
        "source_mode": "csv",
    }


def build_db_rows_from_csv(
    df: pd.DataFrame,
    *,
    page: int = 1,
    page_size: int = 50,
) -> Dict[str, Any]:
    page_size = max(1, min(int(page_size), 200))
    page = max(1, int(page))

    out = df.copy()
    out["id"] = np.arange(1, len(out) + 1)
    out["event_type"] = "SYNTHETIC_TS"
    out["event_label"] = "Synthetic+Observed Mix"

    occ = pd.to_numeric(out.get("occupancy"), errors="coerce").fillna(0)
    out["net_occupancy"] = np.maximum(0, np.round(occ)).astype(int)
    out["num_targets"] = out["net_occupancy"]

    occ_diff = out["net_occupancy"].diff().fillna(0)
    out["entries"] = occ_diff.clip(lower=0).astype(int)
    out["exits"] = (-occ_diff.clip(upper=0)).astype(int)

    out["temp"] = pd.to_numeric(out.get("temperature"), errors="coerce")
    out["co2"] = pd.to_numeric(out.get("airQuality"), errors="coerce")

    energy = pd.to_numeric(out.get("energy"), errors="coerce")
    scale = 1000.0 if (float(energy.median()) if energy.notna().any() else 0.0) < 50.0 else 1.0
    out["total_act_power"] = energy * scale

    if "humidity" not in out.columns:
        out["humidity"] = np.clip(
            42.0 + 0.28 * out["num_targets"].fillna(0) - 0.35 * (out["temp"].fillna(22.0) - 22.0),
            28.0,
            70.0,
        )

    out["timestamp"] = out["timestamp"].dt.strftime("%Y-%m-%d %H:%M:%S")

    total = len(out)
    total_pages = max(1, (total + page_size - 1) // page_size)
    start = (page - 1) * page_size
    end = start + page_size
    view = out.iloc[start:end]

    rows: List[Dict[str, Any]] = [
        {col: (None if pd.isna(v) else v) for col, v in row.items()}
        for row in view[CSV_DB_COLUMNS].to_dict(orient="records")
    ]

    return {
        "rows": rows,
        "total": int(total),
        "page": int(page),
        "page_size": int(page_size),
        "total_pages": int(total_pages),
        "columns": list(CSV_DB_COLUMNS),
        "source_mode": "csv",
    }


def build_training_frame_from_csv(df: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame()
    out["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    out = out.dropna(subset=["timestamp"]).reset_index(drop=True)
    out["sensor_id"] = "csv_agg"
    out["event_type"] = "SYNTHETIC_TS"

    out["temp"] = pd.to_numeric(df.get("temperature"), errors="coerce")
    out["co2"] = pd.to_numeric(df.get("airQuality"), errors="coerce")
    out["num_targets"] = pd.to_numeric(df.get("occupancy"), errors="coerce")

    energy = pd.to_numeric(df.get("energy"), errors="coerce")
    scale = 1000.0 if (float(energy.median()) if energy.notna().any() else 0.0) < 50.0 else 1.0
    out["total_act_power"] = energy * scale

    out["humidity"] = np.clip(
        42.0 + 0.28 * out["num_targets"].fillna(0) - 0.35 * (out["temp"].fillna(22.0) - 22.0),
        28.0,
        70.0,
    )

    occ = out["num_targets"].fillna(0)
    diff = occ.diff().fillna(0)
    out["entries"] = diff.clip(lower=0)
    out["exits"] = (-diff.clip(upper=0))

    if "weather" in df.columns:
        out["outdoor_temp"] = pd.to_numeric(df["weather"], errors="coerce")
    if "condition" in df.columns:
        out["weather_condition"] = df["condition"].astype(str)

    return out.sort_values("timestamp").reset_index(drop=True)
