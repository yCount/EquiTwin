"""
Open-Meteo weather client for EquiTwin MPC integration.

Provides current conditions, hourly forecast, and historical data to accompany training.
"""
from __future__ import annotations

import json
import math
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import List, Optional
from urllib.error import URLError
from urllib.request import urlopen

import pandas as pd


# WMO weather code - closed category string

_WMO_MAP = {
    0:  "sunny",
    1:  "mostly_sunny",
    2:  "mostly_sunny",
    3:  "cloudy",
    45: "fog",
    48: "fog",
}
# rain codes
for _c in [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82]:
    _WMO_MAP[_c] = "rain"
# snow codes
for _c in [71, 73, 75, 77, 85, 86]:
    _WMO_MAP[_c] = "snow"
# thunderstorm codes
for _c in [95, 96, 99]:
    _WMO_MAP[_c] = "thunderstorm"


def _wmo_to_condition(code: int) -> str:
    """
    Map weather interpretation code to a fixed categorical string.

    The set is closed (7 categories + fallback "cloudy") so OneHotEncoder
    never encounters an unknown category.
    """
    return _WMO_MAP.get(int(code), "cloudy")

# Data container

@dataclass
class WeatherSnapshot:
    """Instantaneous weather observation or forecast."""
    outdoor_temp: float       # °C  (float("nan") on API failure)
    weather_condition: str    # "sunny"|"mostly_sunny"|"cloudy"|"fog"|"rain"|"snow"|"thunderstorm"
    sunlight: float           # W/m² shortwave radiation (float("nan") on failure)
    timestamp: datetime       # UTC-aware


def _nan_snapshot(ts: Optional[datetime] = None) -> WeatherSnapshot:
    """Graceful-degradation snapshot with NaN numerics."""
    return WeatherSnapshot(
        outdoor_temp=float("nan"),
        weather_condition="cloudy",   # most common; OHE will have seen it during training
        sunlight=float("nan"),
        timestamp=ts or datetime.now(timezone.utc),
    )

# API URL templates

_FORECAST_URL = (
    "https://api.open-meteo.com/v1/forecast"
    "?latitude={lat}&longitude={lon}"
    "&current_weather=true"
    "&hourly=temperature_2m,shortwave_radiation,weathercode"
    "&forecast_days=2"
    "&timezone=UTC"
)

_ARCHIVE_URL = (
    "https://archive-api.open-meteo.com/v1/archive"
    "?latitude={lat}&longitude={lon}"
    "&start_date={start}&end_date={end}"
    "&hourly=temperature_2m,shortwave_radiation,weathercode"
    "&timezone=UTC"
)

_CACHE_TTL_SECONDS = 900   # 15 minutes — one control tick


# Client

class WeatherClient:
    """
    Open-Meteo HTTP client with in-memory caching and graceful degradation.

    Parameters
    - - -
    lat, lon : float
        WGS84 location coordinates.
    timeout  : int
        HTTP socket timeout in seconds (default: 5).
    """

    def __init__(self, lat: float, lon: float, timeout: int = 5) -> None:
        self.lat = float(lat)
        self.lon = float(lon)
        self.timeout = int(timeout)
        self._cache_snapshot: Optional[WeatherSnapshot] = None
        self._cache_ts: float = 0.0

    # Private

    def _fetch_json(self, url: str) -> dict:
        with urlopen(url, timeout=self.timeout) as resp:
            return json.loads(resp.read())

    def _find_hourly_index(self, hourly_times: list, hour_prefix: str) -> Optional[int]:
        """Return the first index whose time string starts with hour_prefix (first 13 chars)."""
        for i, t in enumerate(hourly_times):
            if isinstance(t, str) and t[:13] == hour_prefix:
                return i
        return None

    # Current weather (15-min TTL cache)

    def get_current(self) -> WeatherSnapshot:
        """
        Return current outdoor conditions.

        The result is cached for _CACHE_TTL_SECONDS (15 min) using
        time.monotonic() so DST / NTP jumps don't accidentally expire the cache.
        On any failure: returns cached snapshot if available, else _nan_snapshot().
        """
        now = time.monotonic()
        if self._cache_snapshot is not None and (now - self._cache_ts) < _CACHE_TTL_SECONDS:
            return self._cache_snapshot

        try:
            url = _FORECAST_URL.format(lat=self.lat, lon=self.lon)
            data = self._fetch_json(url)

            cw = data["current_weather"]
            ts_str: str = cw["time"]
            ts = datetime.fromisoformat(ts_str).replace(tzinfo=timezone.utc)
            temp = float(cw["temperature"])
            code = int(cw["weathercode"])

            # shortwave_radiation is hourly - need to match by hour prefix
            hourly_times = data["hourly"]["time"]
            hourly_rad   = data["hourly"]["shortwave_radiation"]
            idx = self._find_hourly_index(hourly_times, ts_str[:13])
            sunlight = float(hourly_rad[idx]) if idx is not None and hourly_rad[idx] is not None else float("nan")

            snapshot = WeatherSnapshot(
                outdoor_temp=temp,
                weather_condition=_wmo_to_condition(code),
                sunlight=sunlight,
                timestamp=ts,
            )
            self._cache_snapshot = snapshot
            self._cache_ts = now
            return snapshot

        except Exception:
            return self._cache_snapshot if self._cache_snapshot is not None else _nan_snapshot()

    # Hourly forecast

    def get_forecast(self, hours: int = 24) -> List[WeatherSnapshot]:
        """
        Return up to ``hours`` hourly WeatherSnapshot objects starting from now.

        No caching — called at most once per MPC solve cycle.
        Returns an empty list on failure.
        """
        try:
            url = _FORECAST_URL.format(lat=self.lat, lon=self.lon)
            data = self._fetch_json(url)

            times = data["hourly"]["time"]
            temps = data["hourly"]["temperature_2m"]
            rads  = data["hourly"]["shortwave_radiation"]
            codes = data["hourly"]["weathercode"]

            now_utc = datetime.now(timezone.utc)
            result: List[WeatherSnapshot] = []

            for t_str, temp_val, rad_val, code_val in zip(times, temps, rads, codes):
                ts = datetime.fromisoformat(t_str).replace(tzinfo=timezone.utc)
                if ts < now_utc:
                    continue
                if len(result) >= hours:
                    break
                result.append(WeatherSnapshot(
                    outdoor_temp=float(temp_val) if temp_val is not None else float("nan"),
                    weather_condition=_wmo_to_condition(int(code_val) if code_val is not None else 3),
                    sunlight=float(rad_val) if rad_val is not None else float("nan"),
                    timestamp=ts,
                ))

            return result

        except Exception:
            return []

    # Historical data for training enrichment

    def get_historical_df(self, start_date: str, end_date: str) -> pd.DataFrame:
        """
        Fetch hourly historical weather from the Open-Meteo archive API.

        Parameters
        ----------
        start_date : str   "YYYY-MM-DD"
        end_date   : str   "YYYY-MM-DD"

        Returns
        -------
        pd.DataFrame with columns:
            timestamp         : datetime64[ns, UTC]  (hourly)
            outdoor_temp      : float64
            sunlight          : float64  (W/m² shortwave radiation)
            weather_condition : object   (categorical string)

        Returns an empty DataFrame (with correct columns) on failure.
        """
        _EMPTY = pd.DataFrame(
            columns=["timestamp", "outdoor_temp", "sunlight", "weather_condition"]
        )

        try:
            url = _ARCHIVE_URL.format(
                lat=self.lat, lon=self.lon,
                start=start_date, end=end_date,
            )
            data = self._fetch_json(url)

            times = data["hourly"]["time"]
            temps = data["hourly"]["temperature_2m"]
            rads  = data["hourly"]["shortwave_radiation"]
            codes = data["hourly"]["weathercode"]

            rows = []
            for t_str, temp_val, rad_val, code_val in zip(times, temps, rads, codes):
                rows.append({
                    "timestamp": t_str,
                    "outdoor_temp": float(temp_val) if temp_val is not None else float("nan"),
                    "sunlight": float(rad_val) if rad_val is not None else float("nan"),
                    "weather_condition": _wmo_to_condition(
                        int(code_val) if code_val is not None else 3
                    ),
                })

            df = pd.DataFrame(rows)
            df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
            return df

        except Exception as exc:
            print(
                f"[WeatherClient] Historical archive fetch failed for "
                f"{start_date}..{end_date}: {exc}"
            )
            return _EMPTY

    # Training join utility

    @staticmethod
    def join_weather_to_df(
        raw_df: pd.DataFrame,
        weather_df: pd.DataFrame,
        ts_col: str = "timestamp",
    ) -> pd.DataFrame:
        """
        Merge hourly weather data into a sensor DataFrame.

        Algorithm:
        1. Floor each sensor timestamp to the hour boundary.
        2. Left-merge on the floored key against weather_df["timestamp"].
        3. Drop the temporary key column.
        
        NaN handling:
        Rows without a matching weather hour get NaN for all three weather cols.
        The ColumnTransformer's SimpleImputer / OHE(handle_unknown="ignore")
        absorb those NaNs safely during both training and inference.
        """
        raw = raw_df.copy()

        if weather_df.empty or ts_col not in raw.columns:
            raw["outdoor_temp"] = float("nan")
            raw["weather_condition"] = float("nan")
            raw["sunlight"] = float("nan")
            return raw

        raw[ts_col] = pd.to_datetime(raw[ts_col], utc=True, errors="coerce")

        wdf = weather_df.copy()
        wdf["timestamp"] = pd.to_datetime(wdf["timestamp"], utc=True, errors="coerce")

        _KEY = "__weather_hour_key__"
        raw[_KEY] = raw[ts_col].dt.floor("h")
        wdf_keyed = wdf.rename(columns={"timestamp": _KEY})[
            [_KEY, "outdoor_temp", "sunlight", "weather_condition"]
        ]

        merged = raw.merge(wdf_keyed, on=_KEY, how="left")
        merged = merged.drop(columns=[_KEY])
        return merged


# Convenience factory (reads from env vars)

def build_weather_client_from_env(timeout: int = 5) -> Optional[WeatherClient]:
    """
    Build a WeatherClient from WEATHER_LAT / WEATHER_LON environment variables.

    Returns None (with a print message) if the variables are not set.
    """
    lat_str = os.environ.get("WEATHER_LAT")
    lon_str = os.environ.get("WEATHER_LON")
    if not lat_str or not lon_str:
        return None
    try:
        return WeatherClient(float(lat_str), float(lon_str), timeout=timeout)
    except (ValueError, TypeError) as exc:
        print(f"[WeatherClient] Invalid WEATHER_LAT/LON: {exc}")
        return None
