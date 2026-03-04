from __future__ import annotations
from dataclasses import dataclass
from typing import Optional
import pandas as pd
from sqlalchemy import create_engine

@dataclass(frozen=True)
class DataSpec:
    db_url: str
    table: str
    ts_col: str = "timestamp"
    where_sql: Optional[str] = None
    limit_rows: Optional[int] = None
    order: str = "ASC"

def load_table(spec: DataSpec) -> pd.DataFrame:
    engine = create_engine(spec.db_url)
    sql = f"SELECT * FROM {spec.table}"
    if spec.where_sql:
        sql += f" WHERE {spec.where_sql}"
    sql += f' ORDER BY "{spec.ts_col}" {spec.order}'
    if spec.limit_rows:
        sql += f" LIMIT {spec.limit_rows}"
    return pd.read_sql(sql, engine)
