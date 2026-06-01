"""
Open-Meteo weather client integration.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from urllib.request import urlopen

import pandas as pd


_WMO_MAP = {
    0: "sunny",
    1: "mostly_sunny",
    2: "mostly_sunny",
    3: "cloudy",
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

_HISTORY_COLUMNS = ["timestamp", "outdoor_temp", "sunlight", "weather_condition"]


def _wmo_to_condition(code: int) -> str:
    """
    Map weather interpretation code to a fixed categorical string.
    """
    return _WMO_MAP.get(int(code), "cloudy")


@dataclass
class WeatherSnapshot:
    """Instantaneous weather observation or forecast."""

    outdoor_temp: float
    weather_condition: str
    sunlight: float
    timestamp: datetime


def _nan_snapshot(ts: Optional[datetime] = None) -> WeatherSnapshot:
    return WeatherSnapshot(
        outdoor_temp=float("nan"),
        weather_condition="cloudy",
        sunlight=float("nan"),
        timestamp=ts or datetime.now(timezone.utc),
    )


def _empty_history_df() -> pd.DataFrame:
    return pd.DataFrame(columns=_HISTORY_COLUMNS)


def _to_utc_datetime(value: Optional[object]) -> Optional[datetime]:
    if value is None:
        return None

    if isinstance(value, pd.Timestamp):
        ts = value.to_pydatetime()
    elif isinstance(value, datetime):
        ts = value
    elif isinstance(value, str):
        ts = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    else:
        raise TypeError(f"Unsupported datetime value: {type(value)!r}")

    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone.utc)


def _floor_to_hour(ts: datetime) -> datetime:
    return ts.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


def _utc_day_start(date_str: str) -> datetime:
    return datetime.fromisoformat(date_str).replace(tzinfo=timezone.utc)


def _utc_day_end_hour(date_str: str) -> datetime:
    return _utc_day_start(date_str) + timedelta(hours=23)


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

_CACHE_TTL_SECONDS = 900


class WeatherClient:
    """
    Open-Meteo HTTP client with in-memory caching and graceful degradation.

    Parameters
    ----------
    lat, lon : float
        WGS84 location coordinates.
    timeout : int
        HTTP socket timeout in seconds (default: 5).
    """

    def __init__(self, lat: float, lon: float, timeout: int = 5) -> None:
        self.lat = float(lat)
        self.lon = float(lon)
        self.timeout = int(timeout)
        self._cache_snapshot: Optional[WeatherSnapshot] = None
        self._cache_ts: float = 0.0

    def _fetch_json(self, url: str) -> dict:
        with urlopen(url, timeout=self.timeout) as resp:
            return json.loads(resp.read())

    def _find_hourly_index(self, hourly_times: list, hour_prefix: str) -> Optional[int]:
        for i, t in enumerate(hourly_times):
            if isinstance(t, str) and t[:13] == hour_prefix:
                return i
        return None

    def _hourly_json_to_df(self, data: dict) -> pd.DataFrame:
        hourly = data.get("hourly") or {}
        times = hourly.get("time") or []
        temps = hourly.get("temperature_2m") or []
        rads = hourly.get("shortwave_radiation") or []
        codes = hourly.get("weathercode") or []

        rows = []
        for t_str, temp_val, rad_val, code_val in zip(times, temps, rads, codes):
            rows.append(
                {
                    "timestamp": t_str,
                    "outdoor_temp": float(temp_val) if temp_val is not None else float("nan"),
                    "sunlight": float(rad_val) if rad_val is not None else float("nan"),
                    "weather_condition": _wmo_to_condition(
                        int(code_val) if code_val is not None else 3
                    ),
                }
            )

        if not rows:
            return _empty_history_df()

        df = pd.DataFrame(rows, columns=_HISTORY_COLUMNS)
        df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
        return df.dropna(subset=["timestamp"]).sort_values("timestamp").reset_index(drop=True)

    def _slice_hourly_df(
        self,
        df: pd.DataFrame,
        start_ts: datetime,
        end_ts: datetime,
    ) -> pd.DataFrame:
        if df.empty:
            return _empty_history_df()

        mask = (
            (df["timestamp"] >= pd.Timestamp(start_ts))
            & (df["timestamp"] <= pd.Timestamp(end_ts))
        )
        return df.loc[mask, _HISTORY_COLUMNS].reset_index(drop=True)

    def _get_forecast_hourly_df(self) -> pd.DataFrame:
        url = _FORECAST_URL.format(lat=self.lat, lon=self.lon)
        return self._hourly_json_to_df(self._fetch_json(url))

    def get_current(self) -> WeatherSnapshot:
        """
        Return current outdoor conditions.

        The result is cached for _CACHE_TTL_SECONDS using time.monotonic().
        On failure: returns cached snapshot if available, else _nan_snapshot().
        """
        now = time.monotonic()
        if self._cache_snapshot is not None and (now - self._cache_ts) < _CACHE_TTL_SECONDS:
            return self._cache_snapshot

        try:
            url = _FORECAST_URL.format(lat=self.lat, lon=self.lon)
            data = self._fetch_json(url)

            cw = data["current_weather"]
            ts_str = str(cw["time"])
            ts = datetime.fromisoformat(ts_str).replace(tzinfo=timezone.utc)
            temp = float(cw["temperature"])
            code = int(cw["weathercode"])

            hourly_times = data["hourly"]["time"]
            hourly_rad = data["hourly"]["shortwave_radiation"]
            idx = self._find_hourly_index(hourly_times, ts_str[:13])
            sunlight = (
                float(hourly_rad[idx])
                if idx is not None and hourly_rad[idx] is not None
                else float("nan")
            )

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

    def get_forecast(self, hours: int = 24) -> List[WeatherSnapshot]:
        """
        Return up to ``hours`` hourly WeatherSnapshot objects starting from now.

        No caching: called at most once per MPC solve cycle.
        Returns an empty list on failure.
        """
        try:
            forecast_df = self._get_forecast_hourly_df()
            now_utc = datetime.now(timezone.utc)
            window = forecast_df[forecast_df["timestamp"] >= pd.Timestamp(now_utc)].head(
                max(int(hours), 0)
            )
            return [
                WeatherSnapshot(
                    outdoor_temp=float(row["outdoor_temp"]),
                    weather_condition=str(row["weather_condition"]),
                    sunlight=float(row["sunlight"]),
                    timestamp=row["timestamp"].to_pydatetime(),
                )
                for _, row in window.iterrows()
            ]
        except Exception:
            return []

    def get_historical_df(
        self,
        start_date: str,
        end_date: str,
        end_ts: Optional[object] = None,
    ) -> pd.DataFrame:
        """
        Fetch hourly weather from the archive API.

        If the request reaches the current UTC day, merge in the forecast API so
        the returned frame includes all hourly rows available up to the current
        UTC hour.
        """
        start_bound = _utc_day_start(start_date)
        requested_end = _to_utc_datetime(end_ts) if end_ts is not None else _utc_day_end_hour(end_date)
        if requested_end is None:
            return _empty_history_df()

        now_hour = _floor_to_hour(datetime.now(timezone.utc))
        end_bound = min(_floor_to_hour(requested_end), now_hour)
        if end_bound < start_bound:
            return _empty_history_df()

        history_df = _empty_history_df()
        try:
            url = _ARCHIVE_URL.format(
                lat=self.lat,
                lon=self.lon,
                start=start_bound.strftime("%Y-%m-%d"),
                end=end_bound.strftime("%Y-%m-%d"),
            )
            history_df = self._hourly_json_to_df(self._fetch_json(url))
        except Exception as exc:
            print(
                f"[WeatherClient] Historical archive fetch failed for "
                f"{start_date}..{end_date}: {exc}"
            )

        history_df = self._slice_hourly_df(history_df, start_bound, end_bound)

        if end_bound.date() == now_hour.date():
            try:
                forecast_df = self._slice_hourly_df(
                    self._get_forecast_hourly_df(),
                    start_bound,
                    end_bound,
                )
                if not forecast_df.empty:
                    history_df = (
                        pd.concat([history_df, forecast_df], ignore_index=True)
                        .sort_values("timestamp")
                        .drop_duplicates(subset=["timestamp"], keep="last")
                        .reset_index(drop=True)
                    )
            except Exception:
                pass

        return history_df

    @staticmethod
    def join_weather_to_df(
        raw_df: pd.DataFrame,
        weather_df: pd.DataFrame,
        ts_col: str = "timestamp",
    ) -> pd.DataFrame:
        """
        Merge hourly weather data into a sensor DataFrame.
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

        key = "__weather_hour_key__"
        raw[key] = raw[ts_col].dt.floor("h")
        wdf_keyed = wdf.rename(columns={"timestamp": key})[
            [key, "outdoor_temp", "sunlight", "weather_condition"]
        ]

        merged = raw.merge(wdf_keyed, on=key, how="left")
        return merged.drop(columns=[key])


def build_weather_client_from_env(timeout: int = 5) -> Optional[WeatherClient]:
    """
    Build a WeatherClient from WEATHER_LAT / WEATHER_LON environment variables.
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
