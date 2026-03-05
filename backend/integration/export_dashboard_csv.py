from __future__ import annotations

import argparse
import csv
import os
from pathlib import Path
from typing import List, Sequence

from sqlalchemy import create_engine, text

from core.dashboard_rows import (
    DASHBOARD_DEFAULT_COLS,
    build_count_query,
    build_dashboard_rows_query,
    coerce_value,
    discover_table_columns,
    ensure_safe_identifier,
    resolve_output_columns,
)


def _parse_columns_arg(columns_arg: str | None) -> List[str]:
    if not columns_arg:
        return list(DASHBOARD_DEFAULT_COLS)
    return [part.strip() for part in columns_arg.split(",") if part.strip()]


def _build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description=(
            "Export dashboard data to CSV from PostgreSQL."
        )
    )
    ap.add_argument(
        "--db-url",
        default=None,
        help="SQLAlchemy DB URL (defaults to DATABASE_URL env var)",
    )
    ap.add_argument(
        "--table",
        default="matches",
        help="Source table name (default: matches)",
    )
    ap.add_argument(
        "--out",
        required=True,
        help="Output CSV path",
    )
    ap.add_argument(
        "--view",
        default="timeseries",
        choices=["timeseries", "rows"],
        help=(
            "Dashboard view to export: 'timeseries' (default, chart data at fixed buckets) "
            "or 'rows' (DB viewer rows)."
        ),
    )
    ap.add_argument(
        "--bucket-minutes",
        type=int,
        default=15,
        help="Bucket size in minutes for --view timeseries (default: 15)",
    )
    ap.add_argument(
        "--batch-size",
        type=int,
        default=5000,
        help="Rows per DB page during streaming export for --view rows (default: 5000)",
    )
    ap.add_argument(
        "--columns",
        default=None,
        help=(
            "Comma-separated output columns. "
            "Default: dashboard column subset "
            "(id,timestamp,event_label,net_occupancy,temp,humidity,co2,total_act_power,num_targets,entries,exits)."
        ),
    )
    return ap


def _iter_batch_rows(conn, sql, *, batch_size: int, selected_cols: Sequence[str], all_cols: Sequence[str]):
    selected_indexes = [all_cols.index(c) for c in selected_cols]
    offset = 0

    while True:
        result = conn.execute(sql, {"lim": batch_size, "off": offset})
        batch_count = 0

        for row in result:
            out = {
                col: coerce_value(row[idx])
                for col, idx in zip(selected_cols, selected_indexes)
            }
            yield out
            batch_count += 1

        if batch_count == 0:
            break
        offset += batch_count
        if batch_count < batch_size:
            break


def _bucket_expr(bucket_secs: int, col: str = "timestamp") -> str:
    return (
        f"TO_TIMESTAMP(FLOOR(EXTRACT(EPOCH FROM {col}) / {bucket_secs})"
        f" * {bucket_secs})"
    )


def _group_expr(bucket_secs: int, col: str = "timestamp") -> str:
    return f"FLOOR(EXTRACT(EPOCH FROM {col}) / {bucket_secs})"


def _as_display_ts(ts_obj) -> str:
    # Match dashboard table-style timestamp rendering: "YYYY-MM-DD HH:MM:SS"
    return ts_obj.strftime("%Y-%m-%d %H:%M:%S")


def _write_timeseries_csv(conn, table: str, out_path: Path, bucket_minutes: int) -> None:
    table = ensure_safe_identifier(table, "table")
    schema_cols = discover_table_columns(conn, table)
    if not schema_cols:
        raise SystemExit(f"Table '{table}' not found or has no visible columns.")

    has_et = "event_type" in schema_cols
    bucket_secs = max(60, min(int(bucket_minutes) * 60, 86400))
    bkt = _bucket_expr(bucket_secs)
    grp = _group_expr(bucket_secs)

    rows_by_ts = {}

    def run(sql: str):
        return conn.execute(text(sql)).fetchall()

    def row_for_ts(ts_obj):
        key = _as_display_ts(ts_obj)
        if key not in rows_by_ts:
            rows_by_ts[key] = {
                "timestamp": key,
                "temperature": None,
                "airQuality": None,
                "occupancy": None,
                "energy": None,
                "circuit0": None,
                "circuit1": None,
                "weather": None,
                "condition": None,
            }
        return rows_by_ts[key]

    if "temp" in schema_cols:
        et_filter = "event_type = 'NORMAL_AQ' AND " if has_et else ""
        rows = run(
            f"""
            SELECT {bkt} AS ts, AVG(temp) AS v
            FROM {table}
            WHERE {et_filter}temp IS NOT NULL
            GROUP BY {grp} ORDER BY ts
            """
        )
        for ts_obj, val in rows:
            if ts_obj is None or val is None:
                continue
            row_for_ts(ts_obj)["temperature"] = round(float(val), 2)

    if "co2" in schema_cols:
        et_filter = "event_type = 'NORMAL_AQ' AND " if has_et else ""
        rows = run(
            f"""
            SELECT {bkt} AS ts, AVG(co2) AS v
            FROM {table}
            WHERE {et_filter}co2 IS NOT NULL
            GROUP BY {grp} ORDER BY ts
            """
        )
        for ts_obj, val in rows:
            if ts_obj is None or val is None:
                continue
            row_for_ts(ts_obj)["airQuality"] = round(float(val), 1)

    if "entries" in schema_cols and "exits" in schema_cols and "timestamp" in schema_cols:
        occ_filter = (
            "event_type IN ('NO_MOVEMENT','EXIT_DETECTED','ENTRY_DETECTED','MOVEMENT_DETECTED') AND "
            if has_et else ""
        )
        rows = run(
            f"""
            WITH running AS (
                SELECT timestamp,
                    GREATEST(0,
                        SUM(COALESCE(entries,0)) OVER (
                            PARTITION BY DATE_TRUNC('day', timestamp)
                            ORDER BY timestamp, id
                            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) -
                        SUM(COALESCE(exits,0)) OVER (
                            PARTITION BY DATE_TRUNC('day', timestamp)
                            ORDER BY timestamp, id
                            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
                    ) AS net_occ
                FROM {table}
                WHERE {occ_filter}(entries IS NOT NULL OR exits IS NOT NULL)
            )
            SELECT {_bucket_expr(bucket_secs, 'timestamp')} AS ts, MAX(net_occ) AS v
            FROM running
            GROUP BY {_group_expr(bucket_secs, 'timestamp')} ORDER BY ts
            """
        )
        for ts_obj, val in rows:
            if ts_obj is None or val is None:
                continue
            row_for_ts(ts_obj)["occupancy"] = int(val)

    if "total_act_power" in schema_cols:
        et_filter = "event_type = 'NORMAL_EM' AND " if has_et else ""
        has_circuit = "circuit_id" in schema_cols
        if has_circuit:
            rows = run(
                f"""
                SELECT
                    {bkt} AS ts,
                    AVG(total_act_power) / 1000.0 AS total,
                    AVG(CASE WHEN circuit_id = '0' THEN total_act_power END) / 1000.0 AS c0,
                    AVG(CASE WHEN circuit_id = '1' THEN total_act_power END) / 1000.0 AS c1
                FROM {table}
                WHERE {et_filter}total_act_power IS NOT NULL
                GROUP BY {grp} ORDER BY ts
                """
            )
            for ts_obj, total, c0, c1 in rows:
                if ts_obj is None or total is None:
                    continue
                row = row_for_ts(ts_obj)
                row["energy"] = round(float(total), 3)
                row["circuit0"] = round(float(c0), 3) if c0 is not None else 0.0
                row["circuit1"] = round(float(c1), 3) if c1 is not None else 0.0
        else:
            rows = run(
                f"""
                SELECT {bkt} AS ts, AVG(total_act_power) / 1000.0 AS total
                FROM {table}
                WHERE {et_filter}total_act_power IS NOT NULL
                GROUP BY {grp} ORDER BY ts
                """
            )
            for ts_obj, total in rows:
                if ts_obj is None or total is None:
                    continue
                row = row_for_ts(ts_obj)
                row["energy"] = round(float(total), 3)
                row["circuit0"] = round(float(total), 3)
                row["circuit1"] = 0.0

    if "outdoor_temp" in schema_cols:
        rows = run(
            f"""
            SELECT {bkt} AS ts, AVG(outdoor_temp) AS v
            FROM {table}
            WHERE outdoor_temp IS NOT NULL
            GROUP BY {grp} ORDER BY ts
            """
        )
        for ts_obj, val in rows:
            if ts_obj is None or val is None:
                continue
            row = row_for_ts(ts_obj)
            row["weather"] = round(float(val), 1)
            row["condition"] = "cloudy"

    fieldnames = [
        "timestamp",
        "temperature",
        "airQuality",
        "occupancy",
        "energy",
        "circuit0",
        "circuit1",
        "weather",
        "condition",
    ]
    sorted_rows = [rows_by_ts[k] for k in sorted(rows_by_ts.keys())]

    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(sorted_rows)

    print(f"CSV export complete: {out_path}")
    print(f"View: timeseries")
    print(f"Bucket minutes: {bucket_minutes}")
    print(f"Rows written: {len(sorted_rows)}")
    print(f"Columns: {', '.join(fieldnames)}")


def _write_rows_csv(
    conn,
    table: str,
    out_path: Path,
    requested_cols: Sequence[str],
    batch_size: int,
) -> None:
    schema_cols = discover_table_columns(conn, table)
    if not schema_cols:
        raise SystemExit(f"Table '{table}' not found or has no visible columns.")

    row_sql, all_cols = build_dashboard_rows_query(
        table,
        schema_cols,
        with_limit=True,
        with_offset=True,
    )

    selected_cols = resolve_output_columns(requested_cols, all_cols)
    if not selected_cols:
        raise SystemExit(
            "None of the requested output columns are available in query results."
        )

    total_rows = int(conn.execute(build_count_query(table)).scalar() or 0)

    written = 0
    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=selected_cols, extrasaction="ignore")
        writer.writeheader()

        for out_row in _iter_batch_rows(
            conn,
            row_sql,
            batch_size=batch_size,
            selected_cols=selected_cols,
            all_cols=all_cols,
        ):
            writer.writerow(out_row)
            written += 1

    print(f"CSV export complete: {out_path}")
    print("View: rows")
    print(f"Rows written: {written}")
    print(f"Table row count: {total_rows}")
    print(f"Columns: {', '.join(selected_cols)}")


def main() -> int:
    args = _build_parser().parse_args()

    if args.batch_size < 1:
        raise SystemExit("--batch-size must be >= 1")
    if args.bucket_minutes < 1:
        raise SystemExit("--bucket-minutes must be >= 1")

    db_url = args.db_url or os.environ.get("DATABASE_URL")
    if not db_url:
        raise SystemExit(
            "No database URL configured. Pass --db-url or set DATABASE_URL."
        )

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    engine = create_engine(db_url, pool_pre_ping=True)
    with engine.connect() as conn:
        if args.view == "timeseries":
            _write_timeseries_csv(
                conn,
                table=args.table,
                out_path=out_path,
                bucket_minutes=args.bucket_minutes,
            )
        else:
            requested_cols = _parse_columns_arg(args.columns)
            if not requested_cols:
                raise SystemExit("No output columns provided after parsing --columns.")
            _write_rows_csv(
                conn,
                table=args.table,
                out_path=out_path,
                requested_cols=requested_cols,
                batch_size=args.batch_size,
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
