from __future__ import annotations

import asyncio
import json
import os
import ssl
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional
from urllib.error import URLError
from urllib.request import Request as UrlRequest
from urllib.request import urlopen

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Float,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    inspect,
    select,
)
from sqlalchemy.engine import Engine

from .parsers import (
    parse_lsg01_payload_dynamically,
    parse_minew_data,
    parse_mst01_ht_payload,
)


MATCH_CARRY_COLUMNS = {
    "quality",
    "version",
    "co2",
    "temp",
    "humidity",
    "voc",
    "pm2p5",
    "pm10",
    "pm1",
    "pm4",
    "total_current",
    "total_act_power",
    "total_aprt_power",
    "a_current",
    "a_voltage",
    "a_act_power",
    "a_aprt_power",
    "a_pf",
    "a_freq",
    "b_current",
    "b_voltage",
    "b_act_power",
    "b_aprt_power",
    "b_pf",
    "b_freq",
    "c_current",
    "c_voltage",
    "c_act_power",
    "c_aprt_power",
    "c_pf",
    "c_freq",
    "num_targets",
    "entries",
    "exits",
    "outdoor_temp",
    "weather_condition",
    "sunlight",
}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _parse_timestamp(value: Any) -> datetime:
    if value is None or value == "":
        return _utcnow()
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return _utcnow()
        if text.isdigit():
            return datetime.fromtimestamp(float(text), tz=timezone.utc)
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return _utcnow()
    return _utcnow()


def _as_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_int(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _scaled_temp(value: Any) -> Optional[float]:
    out = _as_float(value)
    if out is None:
        return None
    if abs(out) > 200:
        out /= 1000.0
    return out


def _scaled_humidity(value: Any) -> Optional[float]:
    out = _as_float(value)
    if out is None:
        return None
    if abs(out) > 100:
        out /= 1000.0
    return out


def _aq_action(values: Mapping[str, Any]) -> str:
    actions: List[str] = []
    co2 = _as_float(values.get("co2"))
    pm2p5 = _as_float(values.get("pm2p5"))
    temp = _as_float(values.get("temp"))

    if co2 is not None and co2 > 1000:
        actions.append("ALERT - HIGH_CO2 - Increase Ventilation")
    elif co2 is not None and co2 > 800:
        actions.append("HIGH_CO2 - Increase Ventilation")
    if pm2p5 is not None and pm2p5 > 35:
        actions.append("HIGH_PM2P5 - Increase Ventilation")
    if temp is not None and temp > 30:
        actions.append("ALERT - HIGH_TEMP - Increase Cooling")
    elif temp is not None and temp > 26:
        actions.append("HIGH_TEMP - Increase Cooling")
    if temp is not None and temp < 18:
        actions.append("LOW_TEMP - Increase Heating")

    return " | ".join(actions) if actions else "NORMAL_AQ"


def _energy_action(values: Mapping[str, Any]) -> str:
    total_act_power = _as_float(values.get("total_act_power"))
    a_current = _as_float(values.get("a_current"))
    if total_act_power is not None and total_act_power > 7000:
        return "HIGH_POWER_USAGE"
    if a_current is not None and a_current > 10:
        return "HIGH_CURRENT"
    return "NORMAL_EM"


def _occupancy_action(entries: int, exits: int, total_entries: int, total_exits: int) -> str:
    if total_entries > total_exits + 100:
        return "VERY_POPULATED - Increase HVAC"
    if total_entries <= total_exits:
        return "Decrease HVAC"
    if entries > 0:
        return "ENTRY_DETECTED"
    if exits > 0:
        return "EXIT_DETECTED"
    return "NO_MOVEMENT"


def _occupancy_event_type(entries: int, exits: int, total_entries: int, total_exits: int) -> str:
    if total_entries > total_exits + 100:
        return "Increase HVAC"
    if total_entries <= total_exits:
        return "Decrease HVAC"
    if entries > 0 and exits > 0:
        return "MOVEMENT_DETECTED"
    if entries > 0:
        return "ENTRY_DETECTED"
    if exits > 0:
        return "EXIT_DETECTED"
    return "NO_MOVEMENT"


def _radar_action(num_targets: int) -> str:
    if num_targets > 3:
        return "VERY_POPULATED - Increase HVAC"
    return "NO_MOVEMENT"


def _radar_event_type(num_targets: int) -> str:
    return "MOVEMENT_DETECTED" if num_targets > 0 else "NO_MOVEMENT"


class IngestionService:
    def __init__(
        self,
        engine: Engine,
        *,
        forecast_service: Any = None,
        default_group_id: str = "1",
    ) -> None:
        self.engine = engine
        self.forecast_service = forecast_service
        self.default_group_id = str(default_group_id)
        self.metadata = MetaData()
        self._define_tables(self.metadata)
        self.metadata.create_all(self.engine, checkfirst=True)

        reflected = MetaData()
        self.sensors = Table("ingestion_sensors", reflected, autoload_with=self.engine)
        self.raw_payloads = Table("ingestion_raw_payloads", reflected, autoload_with=self.engine)
        self.air_quality = Table("ingestion_air_quality", reflected, autoload_with=self.engine)
        self.energy = Table("ingestion_energy", reflected, autoload_with=self.engine)
        self.occupancy = Table("ingestion_occupancy", reflected, autoload_with=self.engine)
        self.radar = Table("ingestion_radar", reflected, autoload_with=self.engine)
        self.matches = Table("matches", reflected, autoload_with=self.engine)

    @staticmethod
    def _define_tables(metadata: MetaData) -> None:
        Table(
            "ingestion_sensors",
            metadata,
            Column("id", Integer, primary_key=True),
            Column("sensor_key", String(255), nullable=False, unique=True, index=True),
            Column("sensor_type", String(16), nullable=False, index=True),
            Column("logical_group_id", String(255), nullable=False, index=True),
            Column("description", String(255), nullable=True),
            Column("active", Boolean, nullable=False, default=True),
            Column("meta", JSON, nullable=True),
            Column("created_at", DateTime(timezone=True), nullable=False, default=_utcnow),
        )
        Table(
            "ingestion_raw_payloads",
            metadata,
            Column("id", Integer, primary_key=True),
            Column("source_kind", String(64), nullable=False, index=True),
            Column("sensor_key", String(255), nullable=True, index=True),
            Column("payload", JSON, nullable=False),
            Column("received_at", DateTime(timezone=True), nullable=False, default=_utcnow),
        )
        Table(
            "ingestion_air_quality",
            metadata,
            Column("id", Integer, primary_key=True),
            Column("sensor_key", String(255), nullable=False, index=True),
            Column("logical_group_id", String(255), nullable=False, index=True),
            Column("device_id", String(255), nullable=False),
            Column("quality", String(64), nullable=True),
            Column("co2", Float, nullable=True),
            Column("temp", Float, nullable=True),
            Column("humidity", Float, nullable=True),
            Column("voc", Float, nullable=True),
            Column("pm2p5", Float, nullable=True),
            Column("pm10", Float, nullable=True),
            Column("pm1", Float, nullable=True),
            Column("pm4", Float, nullable=True),
            Column("version", String(64), nullable=True),
            Column("action", String(255), nullable=True),
            Column("timestamp", DateTime(timezone=True), nullable=False, index=True),
            Column("raw_payload", JSON, nullable=True),
            Column("created_at", DateTime(timezone=True), nullable=False, default=_utcnow),
        )
        Table(
            "ingestion_energy",
            metadata,
            Column("id", Integer, primary_key=True),
            Column("sensor_key", String(255), nullable=False, index=True),
            Column("logical_group_id", String(255), nullable=False, index=True),
            Column("device_id", String(255), nullable=False),
            Column("circuit_id", String(64), nullable=True),
            Column("a_current", Float, nullable=True),
            Column("a_voltage", Float, nullable=True),
            Column("a_act_power", Float, nullable=True),
            Column("a_aprt_power", Float, nullable=True),
            Column("a_pf", Float, nullable=True),
            Column("a_freq", Float, nullable=True),
            Column("b_current", Float, nullable=True),
            Column("b_voltage", Float, nullable=True),
            Column("b_act_power", Float, nullable=True),
            Column("b_aprt_power", Float, nullable=True),
            Column("b_pf", Float, nullable=True),
            Column("b_freq", Float, nullable=True),
            Column("c_current", Float, nullable=True),
            Column("c_voltage", Float, nullable=True),
            Column("c_act_power", Float, nullable=True),
            Column("c_aprt_power", Float, nullable=True),
            Column("c_pf", Float, nullable=True),
            Column("c_freq", Float, nullable=True),
            Column("total_current", Float, nullable=True),
            Column("total_act_power", Float, nullable=True),
            Column("total_aprt_power", Float, nullable=True),
            Column("action", String(255), nullable=True),
            Column("timestamp", DateTime(timezone=True), nullable=False, index=True),
            Column("raw_payload", JSON, nullable=True),
            Column("created_at", DateTime(timezone=True), nullable=False, default=_utcnow),
        )
        Table(
            "ingestion_occupancy",
            metadata,
            Column("id", Integer, primary_key=True),
            Column("sensor_key", String(255), nullable=False, index=True),
            Column("logical_group_id", String(255), nullable=False, index=True),
            Column("mac", String(255), nullable=True),
            Column("frame_version", String(16), nullable=True),
            Column("battery", Integer, nullable=True),
            Column("firmware_version", String(64), nullable=True),
            Column("peripheral_support", String(64), nullable=True),
            Column("salt", String(32), nullable=True),
            Column("digital_signature", String(32), nullable=True),
            Column("usage", String(32), nullable=True),
            Column("serial_number", Integer, nullable=True),
            Column("entries", Integer, nullable=True),
            Column("exits", Integer, nullable=True),
            Column("total_entries", Integer, nullable=False, default=0),
            Column("total_exits", Integer, nullable=False, default=0),
            Column("num_targets", Integer, nullable=True),
            Column("random_number", String(32), nullable=True),
            Column("rssi", Integer, nullable=True),
            Column("event_type", String(64), nullable=True),
            Column("action", String(255), nullable=True),
            Column("raw_data", Text, nullable=True),
            Column("raw_payload", JSON, nullable=True),
            Column("timestamp", DateTime(timezone=True), nullable=False, index=True),
            Column("created_at", DateTime(timezone=True), nullable=False, default=_utcnow),
        )
        Table(
            "ingestion_radar",
            metadata,
            Column("id", Integer, primary_key=True),
            Column("sensor_key", String(255), nullable=False, index=True),
            Column("logical_group_id", String(255), nullable=False, index=True),
            Column("mac", String(255), nullable=False),
            Column("sn", Integer, nullable=True),
            Column("num_targets", Integer, nullable=True),
            Column("coordinates", JSON, nullable=True),
            Column("event_type", String(64), nullable=True),
            Column("action", String(255), nullable=True),
            Column("raw_payload", JSON, nullable=True),
            Column("timestamp", DateTime(timezone=True), nullable=False, index=True),
            Column("created_at", DateTime(timezone=True), nullable=False, default=_utcnow),
        )
        Table(
            "matches",
            metadata,
            Column("id", Integer, primary_key=True),
            Column("timestamp", DateTime(timezone=True), nullable=False, index=True),
            Column("sensor_id", String(255), nullable=False, index=True),
            Column("source_sensor_id", String(255), nullable=True, index=True),
            Column("sensor_type", String(16), nullable=True),
            Column("event_type", String(64), nullable=True, index=True),
            Column("action", String(255), nullable=True),
            Column("device_id", String(255), nullable=True),
            Column("mac", String(255), nullable=True),
            Column("circuit_id", String(64), nullable=True),
            Column("quality", String(64), nullable=True),
            Column("version", String(64), nullable=True),
            Column("co2", Float, nullable=True),
            Column("temp", Float, nullable=True),
            Column("humidity", Float, nullable=True),
            Column("voc", Float, nullable=True),
            Column("pm2p5", Float, nullable=True),
            Column("pm10", Float, nullable=True),
            Column("pm1", Float, nullable=True),
            Column("pm4", Float, nullable=True),
            Column("a_current", Float, nullable=True),
            Column("a_voltage", Float, nullable=True),
            Column("a_act_power", Float, nullable=True),
            Column("a_aprt_power", Float, nullable=True),
            Column("a_pf", Float, nullable=True),
            Column("a_freq", Float, nullable=True),
            Column("b_current", Float, nullable=True),
            Column("b_voltage", Float, nullable=True),
            Column("b_act_power", Float, nullable=True),
            Column("b_aprt_power", Float, nullable=True),
            Column("b_pf", Float, nullable=True),
            Column("b_freq", Float, nullable=True),
            Column("c_current", Float, nullable=True),
            Column("c_voltage", Float, nullable=True),
            Column("c_act_power", Float, nullable=True),
            Column("c_aprt_power", Float, nullable=True),
            Column("c_pf", Float, nullable=True),
            Column("c_freq", Float, nullable=True),
            Column("total_current", Float, nullable=True),
            Column("total_act_power", Float, nullable=True),
            Column("total_aprt_power", Float, nullable=True),
            Column("num_targets", Integer, nullable=True),
            Column("entries", Integer, nullable=True),
            Column("exits", Integer, nullable=True),
            Column("outdoor_temp", Float, nullable=True),
            Column("weather_condition", String(64), nullable=True),
            Column("sunlight", Float, nullable=True),
            Column("raw_payload", JSON, nullable=True),
            Column("created_at", DateTime(timezone=True), nullable=False, default=_utcnow),
        )

    def status(self) -> Dict[str, Any]:
        return {
            "ready": True,
            "default_group_id": self.default_group_id,
            "tables": sorted(inspect(self.engine).get_table_names()),
            "polling_enabled": _env_flag("INGESTION_POLLING_ENABLED"),
        }

    def _latest_raw_payload(self, conn) -> Dict[str, Any]:
        row = conn.execute(
            select(self.raw_payloads)
            .order_by(self.raw_payloads.c.received_at.desc(), self.raw_payloads.c.id.desc())
            .limit(1)
        ).mappings().first()
        return dict(row) if row else {}

    def _card_status(self, polling_enabled: bool, value: Any) -> str:
        if not polling_enabled:
            return "inactive"
        return "active" if value is not None else "pending"

    @staticmethod
    def _deviation_percent(actual: float, ideal: float) -> float:
        return round(((actual - ideal) / ideal) * 100.0, 1) if ideal else 0.0

    def _deviation_status(self, pct: Optional[float]) -> str:
        if pct is None:
            return "pending"
        abs_pct = abs(pct)
        if abs_pct > 20:
            return "critical"
        if abs_pct > 10:
            return "warning"
        return "good"

    def get_home_snapshot(self) -> Dict[str, Any]:
        polling_enabled = _env_flag("INGESTION_POLLING_ENABLED", False)
        with self.engine.begin() as conn:
            latest_match = self._latest_match(conn, self.default_group_id)
            latest_raw = self._latest_raw_payload(conn)

        state = "inactive"
        if polling_enabled:
            state = "active" if latest_match else "pending"

        temperature = _as_float(latest_match.get("temp")) if latest_match else None
        air_quality = _as_float(latest_match.get("co2")) if latest_match else None
        occupancy = _as_int(latest_match.get("num_targets")) if latest_match else None
        energy_watts = _as_float(latest_match.get("total_act_power")) if latest_match else None
        energy_kw = round(energy_watts / 1000.0, 2) if energy_watts is not None else None

        temperature_dev = None
        if temperature is not None:
            if temperature < 21:
                temperature_dev = self._deviation_percent(temperature, 21)
            elif temperature > 24:
                temperature_dev = self._deviation_percent(temperature, 24)
            else:
                temperature_dev = 0.0

        air_quality_dev = (
            0.0 if air_quality is not None and air_quality <= 650
            else self._deviation_percent(air_quality, 650) if air_quality is not None
            else None
        )

        occupancy_dev = (
            0.0 if occupancy is not None and occupancy <= 50
            else self._deviation_percent(float(occupancy), 50.0) if occupancy is not None
            else None
        )

        energy_upper = max(2.5, 2.2 + max(float(occupancy or 0), 0.0) * 0.05)
        energy_dev = (
            0.0 if energy_kw is not None and energy_kw <= energy_upper
            else self._deviation_percent(energy_kw, energy_upper) if energy_kw is not None
            else None
        )

        deviation_candidates = [
            abs(val)
            for val in (temperature_dev, air_quality_dev, occupancy_dev, energy_dev)
            if val is not None
        ]
        overall_deviation = max(deviation_candidates) if deviation_candidates else None
        overall_status = self._deviation_status(overall_deviation)

        latest_update = latest_match.get("timestamp") if latest_match else latest_raw.get("received_at")
        pending_reason = None
        if polling_enabled and not latest_match:
            pending_reason = "Waiting for first ingested values and the next 15-minute clock tick."

        return {
            "state": state,
            "polling_enabled": polling_enabled,
            "last_update": latest_update.isoformat() if latest_update else None,
            "pending_reason": pending_reason,
            "cards": {
                "temperature": {
                    "label": "Temperature",
                    "status": self._card_status(polling_enabled, temperature),
                    "value": round(temperature, 1) if temperature is not None else None,
                    "unit": "degC",
                    "deviation": temperature_dev,
                    "deviation_status": self._deviation_status(temperature_dev),
                },
                "airQuality": {
                    "label": "Air Quality",
                    "status": self._card_status(polling_enabled, air_quality),
                    "value": round(air_quality) if air_quality is not None else None,
                    "unit": "ppm",
                    "deviation": air_quality_dev,
                    "deviation_status": self._deviation_status(air_quality_dev),
                },
                "occupancy": {
                    "label": "Occupancy",
                    "status": self._card_status(polling_enabled, occupancy),
                    "value": occupancy,
                    "unit": "ppl",
                    "deviation": occupancy_dev,
                    "deviation_status": self._deviation_status(occupancy_dev),
                },
                "energyLoad": {
                    "label": "Energy Load",
                    "status": self._card_status(polling_enabled, energy_kw),
                    "value": energy_kw,
                    "unit": "kW",
                    "deviation": energy_dev,
                    "deviation_status": self._deviation_status(energy_dev),
                },
                "deviation": {
                    "label": "Deviation",
                    "status": "inactive" if not polling_enabled else ("pending" if overall_deviation is None else overall_status),
                    "value": overall_deviation,
                    "unit": "%",
                },
            },
        }

    def _filter_values(self, table: Table, values: Mapping[str, Any]) -> Dict[str, Any]:
        cols = set(table.c.keys())
        return {k: v for k, v in values.items() if k in cols}

    def _insert(self, conn, table: Table, values: Mapping[str, Any]) -> Dict[str, Any]:
        clean = self._filter_values(table, values)
        result = conn.execute(table.insert().values(**clean))
        row = dict(clean)
        if "id" in table.c and result.inserted_primary_key:
            row["id"] = result.inserted_primary_key[0]
        return row

    def _get_or_create_sensor(
        self,
        conn,
        *,
        sensor_key: str,
        sensor_type: str,
        logical_group_id: str,
        description: Optional[str] = None,
        meta: Optional[Mapping[str, Any]] = None,
    ) -> Dict[str, Any]:
        existing = conn.execute(
            select(self.sensors)
            .where(self.sensors.c.sensor_key == sensor_key)
            .limit(1)
        ).mappings().first()
        if existing:
            return dict(existing)
        return self._insert(
            conn,
            self.sensors,
            {
                "sensor_key": sensor_key,
                "sensor_type": sensor_type,
                "logical_group_id": logical_group_id,
                "description": description or f"Auto-created {sensor_type} sensor",
                "active": True,
                "meta": dict(meta or {}),
                "created_at": _utcnow(),
            },
        )

    def _record_raw(self, conn, source_kind: str, sensor_key: Optional[str], payload: Any) -> Dict[str, Any]:
        return self._insert(
            conn,
            self.raw_payloads,
            {
                "source_kind": source_kind,
                "sensor_key": sensor_key,
                "payload": payload,
                "received_at": _utcnow(),
            },
        )

    def _latest_match(self, conn, logical_group_id: str) -> Dict[str, Any]:
        row = conn.execute(
            select(self.matches)
            .where(self.matches.c.sensor_id == logical_group_id)
            .order_by(self.matches.c.timestamp.desc(), self.matches.c.id.desc())
            .limit(1)
        ).mappings().first()
        return dict(row) if row else {}

    def _insert_match_snapshot(
        self,
        conn,
        *,
        logical_group_id: str,
        source_sensor_id: str,
        sensor_type: str,
        timestamp: datetime,
        event_type: str,
        action: str,
        updates: Mapping[str, Any],
        raw_payload: Any,
    ) -> Dict[str, Any]:
        previous = self._latest_match(conn, logical_group_id)
        snapshot = {
            col: previous.get(col)
            for col in MATCH_CARRY_COLUMNS
            if col in self.matches.c and col in previous
        }
        snapshot.update(
            {
                "timestamp": timestamp,
                "sensor_id": logical_group_id,
                "source_sensor_id": source_sensor_id,
                "sensor_type": sensor_type,
                "event_type": event_type,
                "action": action,
                "raw_payload": raw_payload,
                "created_at": _utcnow(),
            }
        )
        snapshot.update(updates)
        row = self._insert(conn, self.matches, snapshot)
        self._push_forecast(row)
        return row

    def _push_forecast(self, match_row: Mapping[str, Any]) -> None:
        if self.forecast_service is None:
            return
        try:
            from equitwin_dnm_integration_point import matches_row_to_ingest

            self.forecast_service.ingest(matches_row_to_ingest(dict(match_row)))
        except Exception as exc:
            print(f"[EquiTwin] Live ingestion did not reach ForecastService: {exc}")

    def ingest_air_quality_payload(self, body: Mapping[str, Any]) -> Dict[str, Any]:
        payload = body.get("msg") if isinstance(body.get("msg"), Mapping) else body
        raw_payload = body.get("raw_payload", body) if isinstance(body, Mapping) else body
        device_id = str(payload.get("device_id") or payload.get("device") or "").strip()
        if not device_id:
            raise ValueError("Missing air-quality device id.")

        logical_group_id = str(body.get("group_id") or payload.get("group_id") or self.default_group_id)
        timestamp = _parse_timestamp(payload.get("timestamp"))
        record = {
            "sensor_key": device_id,
            "logical_group_id": logical_group_id,
            "device_id": device_id,
            "quality": payload.get("quality") or "Unknown",
            "co2": _as_float(payload.get("co2")),
            "temp": _scaled_temp(payload.get("temperature", payload.get("temp"))),
            "humidity": _scaled_humidity(payload.get("humidity")),
            "voc": _as_float(payload.get("tvoc_index", payload.get("tvoc", payload.get("voc")))),
            "pm2p5": _as_float(payload.get("pm_2p5", payload.get("pm2p5", payload.get("pm25")))),
            "pm10": _as_float(payload.get("pm_10", payload.get("pm10"))),
            "pm1": _as_float(payload.get("pm_1", payload.get("pm1"))),
            "pm4": _as_float(payload.get("pm_4", payload.get("pm4"))),
            "version": payload.get("company_name", payload.get("version", "Unknown")),
            "timestamp": timestamp,
            "raw_payload": raw_payload,
        }
        record["action"] = _aq_action(record)

        with self.engine.begin() as conn:
            sensor = self._get_or_create_sensor(
                conn,
                sensor_key=device_id,
                sensor_type="AQ",
                logical_group_id=logical_group_id,
            )
            aq_row = self._insert(conn, self.air_quality, record)
            match_row = self._insert_match_snapshot(
                conn,
                logical_group_id=logical_group_id,
                source_sensor_id=device_id,
                sensor_type="AQ",
                timestamp=timestamp,
                event_type="NORMAL_AQ",
                action=record["action"],
                raw_payload=raw_payload,
                updates={
                    "device_id": device_id,
                    "quality": record["quality"],
                    "version": record["version"],
                    "co2": record["co2"],
                    "temp": record["temp"],
                    "humidity": record["humidity"],
                    "voc": record["voc"],
                    "pm2p5": record["pm2p5"],
                    "pm10": record["pm10"],
                    "pm1": record["pm1"],
                    "pm4": record["pm4"],
                },
            )
        return {
            "status": "created",
            "sensor": sensor.get("sensor_key"),
            "air_quality_id": aq_row.get("id"),
            "match_id": match_row.get("id"),
        }

    def ingest_temperature_humidity_payload(self, body: Mapping[str, Any]) -> Dict[str, Any]:
        data = body.get("data") or {}
        frm_payload = ((data.get("uplink_message") or {}).get("frm_payload"))
        device_id = str(((data.get("end_device_ids") or {}).get("device_id")) or "").strip()
        if not frm_payload:
            raise ValueError("Missing frm_payload.")
        if not device_id:
            raise ValueError("Missing device_id.")
        parsed = parse_mst01_ht_payload(frm_payload)
        if parsed.get("error"):
            raise ValueError(str(parsed["error"]))
        return self.ingest_air_quality_payload(
            {
                "group_id": body.get("group_id", self.default_group_id),
                "device_id": device_id,
                "temperature": parsed.get("temperature"),
                "humidity": parsed.get("humidity"),
                "version": "MST01",
                "timestamp": _utcnow().isoformat(),
                "raw_payload": body,
            }
        )

    def ingest_lsg01_payload(self, body: Mapping[str, Any]) -> Dict[str, Any]:
        device_id = str((((body.get("end_device_ids") or {}).get("device_id")) or "")).strip()
        frm_payload = (((body.get("uplink_message") or {}).get("frm_payload")))
        if not frm_payload:
            raise ValueError("Missing frm_payload.")
        if not device_id:
            raise ValueError("Missing device_id.")
        parsed = parse_lsg01_payload_dynamically(frm_payload)
        if parsed.get("error"):
            raise ValueError(str(parsed["error"]))
        return self.ingest_air_quality_payload(
            {
                "group_id": body.get("group_id", self.default_group_id),
                "device_id": device_id,
                "co2": parsed.get("co2"),
                "temperature": parsed.get("temperature"),
                "humidity": parsed.get("humidity"),
                "tvoc": parsed.get("tvoc"),
                "pm25": parsed.get("pm25"),
                "version": "LSG01",
                "timestamp": _utcnow().isoformat(),
                "raw_payload": body,
            }
        )

    def ingest_energy_payload(self, body: Mapping[str, Any]) -> Dict[str, Any]:
        device_id = str(body.get("device_id") or body.get("device") or "").strip()
        if not device_id:
            raise ValueError("Missing energy device_id.")
        logical_group_id = str(body.get("group_id") or self.default_group_id)
        timestamp = _parse_timestamp(body.get("timestamp"))
        circuit_id = str(body.get("circuit_id") or device_id)
        record = {
            "sensor_key": device_id,
            "logical_group_id": logical_group_id,
            "device_id": device_id,
            "circuit_id": circuit_id,
            "a_current": _as_float(body.get("a_current")),
            "a_voltage": _as_float(body.get("a_voltage")),
            "a_act_power": _as_float(body.get("a_act_power")),
            "a_aprt_power": _as_float(body.get("a_aprt_power")),
            "a_pf": _as_float(body.get("a_pf")),
            "a_freq": _as_float(body.get("a_freq")),
            "b_current": _as_float(body.get("b_current")),
            "b_voltage": _as_float(body.get("b_voltage")),
            "b_act_power": _as_float(body.get("b_act_power")),
            "b_aprt_power": _as_float(body.get("b_aprt_power")),
            "b_pf": _as_float(body.get("b_pf")),
            "b_freq": _as_float(body.get("b_freq")),
            "c_current": _as_float(body.get("c_current")),
            "c_voltage": _as_float(body.get("c_voltage")),
            "c_act_power": _as_float(body.get("c_act_power")),
            "c_aprt_power": _as_float(body.get("c_aprt_power")),
            "c_pf": _as_float(body.get("c_pf")),
            "c_freq": _as_float(body.get("c_freq")),
            "total_current": _as_float(body.get("total_current")),
            "total_act_power": _as_float(body.get("total_act_power")),
            "total_aprt_power": _as_float(body.get("total_aprt_power")),
            "timestamp": timestamp,
            "raw_payload": body,
        }
        record["action"] = _energy_action(record)

        with self.engine.begin() as conn:
            sensor = self._get_or_create_sensor(
                conn,
                sensor_key=device_id,
                sensor_type="EM",
                logical_group_id=logical_group_id,
            )
            em_row = self._insert(conn, self.energy, record)
            match_row = self._insert_match_snapshot(
                conn,
                logical_group_id=logical_group_id,
                source_sensor_id=device_id,
                sensor_type="EM",
                timestamp=timestamp,
                event_type="NORMAL_EM",
                action=record["action"],
                raw_payload=body,
                updates={
                    "device_id": device_id,
                    "circuit_id": circuit_id,
                    "a_current": record["a_current"],
                    "a_voltage": record["a_voltage"],
                    "a_act_power": record["a_act_power"],
                    "a_aprt_power": record["a_aprt_power"],
                    "a_pf": record["a_pf"],
                    "a_freq": record["a_freq"],
                    "b_current": record["b_current"],
                    "b_voltage": record["b_voltage"],
                    "b_act_power": record["b_act_power"],
                    "b_aprt_power": record["b_aprt_power"],
                    "b_pf": record["b_pf"],
                    "b_freq": record["b_freq"],
                    "c_current": record["c_current"],
                    "c_voltage": record["c_voltage"],
                    "c_act_power": record["c_act_power"],
                    "c_aprt_power": record["c_aprt_power"],
                    "c_pf": record["c_pf"],
                    "c_freq": record["c_freq"],
                    "total_current": record["total_current"],
                    "total_act_power": record["total_act_power"],
                    "total_aprt_power": record["total_aprt_power"],
                },
            )
        return {
            "status": "created",
            "sensor": sensor.get("sensor_key"),
            "energy_id": em_row.get("id"),
            "match_id": match_row.get("id"),
        }

    def store_raw_payload(self, body: Any, *, source_kind: str, sensor_key: Optional[str] = None) -> Dict[str, Any]:
        with self.engine.begin() as conn:
            raw_row = self._record_raw(conn, source_kind, sensor_key, body)
        return {"status": "stored", "raw_payload_id": raw_row.get("id")}

    def _latest_occupancy_state(self, conn, sensor_key: str) -> Dict[str, int]:
        row = conn.execute(
            select(self.occupancy)
            .where(self.occupancy.c.sensor_key == sensor_key)
            .order_by(self.occupancy.c.created_at.desc(), self.occupancy.c.id.desc())
            .limit(1)
        ).mappings().first()
        return {
            "total_entries": int((row or {}).get("total_entries") or 0),
            "total_exits": int((row or {}).get("total_exits") or 0),
            "serial_number": int((row or {}).get("serial_number") or -1),
        }

    def ingest_occupancy_batch(self, body: Any) -> Dict[str, Any]:
        if not isinstance(body, list):
            raise ValueError("Occupancy parser expects a list payload.")

        created = 0
        errors: List[str] = []
        cache: Dict[str, Dict[str, int]] = {}

        with self.engine.begin() as conn:
            self._record_raw(conn, "occupancy_batch", None, body)

            for item in body:
                if not isinstance(item, Mapping):
                    errors.append(f"Unsupported occupancy item: {item!r}")
                    continue
                if "gateway" in item or "raw" not in item:
                    continue

                raw_hex = str(item.get("raw") or "")
                parsed = parse_minew_data(raw_hex)
                if parsed.get("frame_version") == "00":
                    continue
                if parsed.get("error"):
                    errors.append(f"{item!r}: {parsed['error']}")
                    continue

                sensor_key = str(item.get("mac") or parsed.get("mac") or "unknown-mac")
                logical_group_id = str(item.get("group_id") or self.default_group_id)
                timestamp = _utcnow()
                serial_number = int(parsed.get("serial_number") or 0)
                entries = int(parsed.get("entries") or 0)
                exits = int(parsed.get("exits") or 0)
                rssi = _as_int(item.get("rssi"))

                self._get_or_create_sensor(
                    conn,
                    sensor_key=sensor_key,
                    sensor_type="OC",
                    logical_group_id=logical_group_id,
                )

                state = cache.get(sensor_key)
                if state is None:
                    state = self._latest_occupancy_state(conn, sensor_key)
                    cache[sensor_key] = state

                if serial_number != state["serial_number"]:
                    state["total_entries"] += entries
                    state["total_exits"] += exits
                    state["serial_number"] = serial_number

                total_entries = state["total_entries"]
                total_exits = state["total_exits"]
                num_targets = max(total_entries - total_exits, 0)
                action = _occupancy_action(entries, exits, total_entries, total_exits)
                event_type = _occupancy_event_type(entries, exits, total_entries, total_exits)

                self._insert(
                    conn,
                    self.occupancy,
                    {
                        "sensor_key": sensor_key,
                        "logical_group_id": logical_group_id,
                        "mac": parsed.get("mac", sensor_key),
                        "frame_version": parsed.get("frame_version"),
                        "battery": _as_int(parsed.get("battery")),
                        "firmware_version": parsed.get("firmware_version"),
                        "peripheral_support": parsed.get("peripheral_support"),
                        "salt": parsed.get("salt"),
                        "digital_signature": parsed.get("digital_signature"),
                        "usage": parsed.get("usage"),
                        "serial_number": serial_number,
                        "entries": entries,
                        "exits": exits,
                        "total_entries": total_entries,
                        "total_exits": total_exits,
                        "num_targets": num_targets,
                        "random_number": parsed.get("random_number"),
                        "rssi": rssi,
                        "event_type": event_type,
                        "action": action,
                        "raw_data": raw_hex,
                        "raw_payload": item,
                        "timestamp": timestamp,
                        "created_at": _utcnow(),
                    },
                )
                self._insert_match_snapshot(
                    conn,
                    logical_group_id=logical_group_id,
                    source_sensor_id=sensor_key,
                    sensor_type="OC",
                    timestamp=timestamp,
                    event_type=event_type,
                    action=action,
                    raw_payload=item,
                    updates={
                        "mac": sensor_key,
                        "entries": entries,
                        "exits": exits,
                        "num_targets": num_targets,
                    },
                )
                created += 1

        return {"created": created, "errors": errors}

    def ingest_radar_payload(self, body: Mapping[str, Any]) -> Dict[str, Any]:
        mac = str(body.get("mac") or "").strip()
        if not mac:
            raise ValueError("Missing radar mac.")

        logical_group_id = str(body.get("group_id") or self.default_group_id)
        radar_info = body.get("radar") or {}
        coordinates = radar_info.get("coord") or {}
        num_targets = int(radar_info.get("num") or 0)
        timestamp = _utcnow()
        action = _radar_action(num_targets)
        event_type = _radar_event_type(num_targets)

        with self.engine.begin() as conn:
            sensor = self._get_or_create_sensor(
                conn,
                sensor_key=mac,
                sensor_type="RD",
                logical_group_id=logical_group_id,
            )
            radar_row = self._insert(
                conn,
                self.radar,
                {
                    "sensor_key": mac,
                    "logical_group_id": logical_group_id,
                    "mac": mac,
                    "sn": _as_int(body.get("sn")),
                    "num_targets": num_targets,
                    "coordinates": coordinates,
                    "event_type": event_type,
                    "action": action,
                    "raw_payload": body,
                    "timestamp": timestamp,
                    "created_at": _utcnow(),
                },
            )
            match_row = self._insert_match_snapshot(
                conn,
                logical_group_id=logical_group_id,
                source_sensor_id=mac,
                sensor_type="RD",
                timestamp=timestamp,
                event_type=event_type,
                action=action,
                raw_payload=body,
                updates={
                    "mac": mac,
                    "num_targets": num_targets,
                },
            )
        return {
            "status": "created",
            "sensor": sensor.get("sensor_key"),
            "radar_id": radar_row.get("id"),
            "match_id": match_row.get("id"),
        }


def _fetch_json(url: str, *, insecure_ssl: bool = False) -> Any:
    ctx = ssl._create_unverified_context() if insecure_ssl else None
    req = UrlRequest(url, headers={"Accept": "application/json"})
    with urlopen(req, context=ctx, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


async def _poll_loop(name: str, url: str, interval_seconds: float, handler, *, insecure_ssl: bool = False) -> None:
    while True:
        try:
            payload = await asyncio.to_thread(_fetch_json, url, insecure_ssl=insecure_ssl)
            handler(payload)
        except asyncio.CancelledError:
            raise
        except URLError as exc:
            print(f"[EquiTwin] {name} poll failed for {url}: {exc}")
        except Exception as exc:
            print(f"[EquiTwin] {name} ingestion failed for {url}: {exc}")
        await asyncio.sleep(interval_seconds)


def start_optional_pollers(service: IngestionService) -> List[asyncio.Task]:
    if not _env_flag("INGESTION_POLLING_ENABLED", False):
        return []

    interval_seconds = float(os.environ.get("INGESTION_POLL_INTERVAL_SECONDS", "10"))
    aq_url = os.environ.get("INGESTION_POLL_AQ_URL")
    insecure_aq = _env_flag("INGESTION_POLL_AQ_INSECURE_SSL", True)
    tasks: List[asyncio.Task] = []

    if aq_url:
        tasks.append(
            asyncio.create_task(
                _poll_loop(
                    "air-quality",
                    aq_url,
                    interval_seconds,
                    service.ingest_air_quality_payload,
                    insecure_ssl=insecure_aq,
                )
            )
        )

    em_urls: List[str] = []
    em_urls_raw = os.environ.get("INGESTION_POLL_EM_URLS")
    if em_urls_raw:
        em_urls.extend([part.strip() for part in em_urls_raw.split(",") if part.strip()])
    for key in ("INGESTION_POLL_EM_URL_LEVEL3", "INGESTION_POLL_EM_URL_LEVEL4"):
        url = os.environ.get(key)
        if url:
            em_urls.append(url)

    for idx, url in enumerate(em_urls):
        tasks.append(
            asyncio.create_task(
                _poll_loop(
                    f"energy-{idx}",
                    url,
                    interval_seconds,
                    service.ingest_energy_payload,
                )
            )
        )

    return tasks
