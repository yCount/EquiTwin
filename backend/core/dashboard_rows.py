from __future__ import annotations

import re
from decimal import Decimal
from typing import Any, List, Sequence, Tuple

from sqlalchemy import text


DASHBOARD_DEFAULT_COLS: List[str] = [
    "id",
    "timestamp",
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

_SAFE_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def ensure_safe_identifier(name: str, label: str = "identifier") -> str:
    """Validate a SQL identifier used in string-built SQL statements."""
    if not _SAFE_IDENT_RE.match(name):
        raise ValueError(f"Unsafe {label}: '{name}'")
    return name


def discover_table_columns(conn, table: str) -> List[str]:
    """Return table columns in ordinal position order."""
    table = ensure_safe_identifier(table, "table")
    rows = conn.execute(
        text(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = :t ORDER BY ordinal_position"
        ),
        {"t": table},
    )
    return [r[0] for r in rows]


def build_count_query(table: str):
    table = ensure_safe_identifier(table, "table")
    return text(f"SELECT COUNT(*) FROM {table}")


def _build_order_by_clause(
    schema_cols: Sequence[str],
    *,
    ts_col: str = "timestamp",
    id_col: str = "id",
) -> str:
    parts: List[str] = []
    if ts_col in schema_cols:
        parts.append(ts_col)
    if id_col in schema_cols:
        parts.append(id_col)
    if not parts:
        raise ValueError(
            "Unable to build stable ordering: neither timestamp nor id exists in table schema."
        )
    return ", ".join(parts)


def build_extra_select_and_columns(
    schema_cols: Sequence[str],
    *,
    ts_col: str = "timestamp",
    id_col: str = "id",
) -> Tuple[str, List[str]]:
    """
    Build dashboard-engineered SQL fragment and the appended result column names.
    """
    colset = set(schema_cols)
    extra_select = ""
    result_extra: List[str] = []
    order_clause = _build_order_by_clause(schema_cols, ts_col=ts_col, id_col=id_col)

    if {"entries", "exits"}.issubset(colset) and ts_col in colset:
        extra_select += (
            ",\n  GREATEST(0,\n"
            "    SUM(COALESCE(entries,0)) OVER (\n"
            f"      PARTITION BY DATE_TRUNC('day', {ts_col})\n"
            f"      ORDER BY {order_clause}\n"
            "      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) -\n"
            "    SUM(COALESCE(exits,0))   OVER (\n"
            f"      PARTITION BY DATE_TRUNC('day', {ts_col})\n"
            f"      ORDER BY {order_clause}\n"
            "      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)\n"
            "  ) AS net_occupancy"
        )
        result_extra.append("net_occupancy")

    if "event_type" in colset:
        extra_select += (
            ",\n  CASE event_type\n"
            "    WHEN 'NO_MOVEMENT'    THEN 'No Motion'\n"
            "    WHEN 'EXIT_DETECTED'  THEN 'Exit Detected'\n"
            "    WHEN 'NORMAL_EM'      THEN 'Energy Meter'\n"
            "    WHEN 'NORMAL_AQ'      THEN 'Air Quality'\n"
            "    ELSE event_type\n"
            "  END AS event_label"
        )
        result_extra.append("event_label")

    return extra_select, result_extra


def build_dashboard_rows_query(
    table: str,
    schema_cols: Sequence[str],
    *,
    with_limit: bool = False,
    with_offset: bool = False,
    ts_col: str = "timestamp",
    id_col: str = "id",
):
    """
    Build SELECT SQL for dashboard rows and return (sql, result_columns).
    """
    table = ensure_safe_identifier(table, "table")
    order_clause = _build_order_by_clause(schema_cols, ts_col=ts_col, id_col=id_col)
    extra_select, result_extra = build_extra_select_and_columns(
        schema_cols,
        ts_col=ts_col,
        id_col=id_col,
    )

    sql = (
        f"SELECT *{extra_select}\n"
        f"FROM {table}\n"
        f"ORDER BY {order_clause}"
    )
    if with_limit:
        sql += "\nLIMIT :lim"
    if with_offset:
        sql += "\nOFFSET :off"

    return text(sql), list(schema_cols) + result_extra


def coerce_value(v: Any):
    """Make values JSON/CSV-serialisable."""
    if v is None:
        return None
    if hasattr(v, "isoformat"):  # datetime / date-like
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (bytes, bytearray)):
        return v.hex()
    return v


def resolve_output_columns(requested: Sequence[str], available: Sequence[str]) -> List[str]:
    """
    Keep requested order and drop missing/duplicate columns.
    """
    available_set = set(available)
    out: List[str] = []
    seen = set()

    for col in requested:
        name = col.strip()
        if not name or name in seen:
            continue
        if name in available_set:
            out.append(name)
            seen.add(name)
    return out

