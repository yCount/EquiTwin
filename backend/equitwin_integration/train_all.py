"""
One-command training for all four EquiTwin features (energy, temperature,
airquality, occupancy) at both ST (15m) and LT (4h) levels.

Speed
-----------
Training time is driven by three things:

  1. Row count  (--limit)         default 600  — keeps it under ~2 min total
  2. Model zoo  (--models)        default "fast" set: ridge, hgb, rf
                                  full set adds: linear, elastic, ann, gp, voting
  3. Horizons   (--st-horizons / --lt-horizons)
                                  default ST=[1,3,6], LT=[1,3]

Preset modes (--mode flag):
  fast   ~1-3 min    limit=600,  models=ridge+hgb+rf,         horizons ST=[1,3,6] LT=[1,3]
  normal ~10-20 min  limit=5000, models=ridge+hgb+rf+ann+gp,  horizons ST=[1,2,3,4,6,8] LT=[1,2,3,4,5,6]
  full   hours       limit=None, all 9 models,                 all horizons

Usage
-----------
    # Fast (default)
    python -m equitwin_integration.train_all \\
        --db-url "postgresql+psycopg2://..." --table matches

    # Explicit limit
    python -m equitwin_integration.train_all \\
        --db-url "postgresql+psycopg2://..." --table matches --limit 600

    # Normal quality
    python -m equitwin_integration.train_all \\
        --db-url "postgresql+psycopg2://..." --table matches --mode normal

    # Full overnight run
    python -m equitwin_integration.train_all \\
        --db-url "postgresql+psycopg2://..." --table matches --mode full

After training, artifacts are saved as:
    artifacts/<feature>/best/st_h<N>/model.joblib
    artifacts/<feature>/best/lt_h<N>/model.joblib
"""
from __future__ import annotations

import argparse
import json
from typing import Any, Dict, List, Optional, Sequence

from features.registry import ENERGY, TEMPERATURE, AIRQUALITY_CO2, OCCUPANCY
from training.service import train_feature_best_models_two_level
from equitwin_forecasting.timebase import default_horizons

ALL_FEATURES = {
    "energy": ENERGY,
    "temperature": TEMPERATURE,
    "airquality": AIRQUALITY_CO2,
    "occupancy": OCCUPANCY,
}

# Speed presets
PRESETS: Dict[str, Dict[str, Any]] = {
    "fast": {
        "limit_rows":   600,
        "models":       ["ridge", "hgb", "rf"],
        "st_horizons":  [1, 3, 6],
        "lt_horizons":  [1, 3],
        "gp_max_rows":  200,
    },
    "normal": {
        "limit_rows":   5000,
        "models":       ["ridge", "hgb", "rf", "ann", "gp"],
        "st_horizons":  [1, 2, 3, 4, 6, 8],
        "lt_horizons":  [1, 2, 3, 4, 5, 6],
        "gp_max_rows":  400,
    },
    "full": {
        "limit_rows":   None,   # load everything
        "models":       None,   # all 9 candidates
        "st_horizons":  None,   # use default_horizons()
        "lt_horizons":  None,
        "gp_max_rows":  800,
    },
}


def train_all_features(
    db_url: str,
    table: str,
    *,
    features: Optional[List[str]] = None,
    where_sql: Optional[str] = None,
    limit_rows: Optional[int] = 600,
    out_root: str = "artifacts",
    models: Optional[Sequence[str]] = ("ridge", "hgb", "rf"),
    st_horizons: Optional[Sequence[int]] = (1, 3, 6),
    lt_horizons: Optional[Sequence[int]] = (1, 3),
    gp_max_rows: int = 200,
    lt_agg: str = "mean",
    lt_lags: Sequence[int] = (1, 2, 3),
) -> Dict[str, Any]:
    """
    Train ST + LT model banks for every requested feature.

    Parameters
    ----------
    db_url        : SQLAlchemy DB URL for the raw sensor data.
    table         : Table name (e.g. "matches").
    features      : Subset of ["energy","temperature","airquality","occupancy"].
                    None = train all four.
    where_sql     : Optional SQL WHERE clause to filter rows.
    limit_rows    : Max rows to load per feature. Default 600 keeps training
                    under ~2 minutes. Set None to load all data.
    out_root      : Root directory to save artifacts.
    models        : Model types to evaluate.
                    Fast set (default): ["ridge", "hgb", "rf"]
                    Full set: ["linear","ridge","elastic","hgb","rf","ann","gp","voting"]
    st_horizons   : Short-term horizons (15-min steps). Default [1, 3, 6].
    lt_horizons   : Long-term horizons (4-hour steps). Default [1, 3].
    gp_max_rows   : Row cap for GP fitting (GP is O(n³)). Default 200.
    lt_agg        : 4h block aggregation: "mean" | "sum" | "last".
    lt_lags       : Long-term lag indices (in 4h blocks).

    Returns
    -------
    dict mapping feature name -> {st: summary, lt: summary}
    """
    hz = default_horizons()
    st_h = list(st_horizons) if st_horizons is not None else hz.st_horizons
    lt_h = list(lt_horizons) if lt_horizons is not None else hz.lt_horizons

    to_train = features or list(ALL_FEATURES.keys())
    results: Dict[str, Any] = {}

    mdl_list = list(models) if models else "all"
    print(f"\n{'='*60}")
    print(f"  EquiTwin Training Run")
    print(f"{'='*60}")
    print(f"  Features   : {to_train}")
    print(f"  Row limit  : {limit_rows if limit_rows else 'ALL (slow!)'}")
    print(f"  Models     : {mdl_list}")
    print(f"  ST horizons: {st_h}  (×15 min)")
    print(f"  LT horizons: {lt_h}  (×4 h)")
    print(f"  Artifacts  : {out_root}/")
    print(f"{'='*60}\n")

    for fname in to_train:
        if fname not in ALL_FEATURES:
            raise ValueError(f"Unknown feature '{fname}'. Choose from: {list(ALL_FEATURES)}")

        print(f"\n--- {fname.upper()} ---")

        summary = train_feature_best_models_two_level(
            feature=ALL_FEATURES[fname],
            db_url=db_url,
            table=table,
            where_sql=where_sql,
            limit_rows=limit_rows,
            out_root=out_root,
            st_horizons=st_h,
            lt_horizons=lt_h,
            models=list(models) if models else None,
            gp_max_rows=gp_max_rows,
            lt_agg=lt_agg,
            lt_lags=lt_lags,
        )
        results[fname] = summary
        print(f"{fname} done.")

    return results

# CLI

def _build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description=(
            "Train all EquiTwin forecast models (ST + LT).\n\n"
            "Modes:  fast (~2 min, 600 rows, 3 models)  <- default\n"
            "        normal (~15 min, 5k rows, 5 models)\n"
            "        full   (hours, all data, all models)\n\n"
            "Or override any individual setting below."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--db-url", required=True, help="SQLAlchemy DB URL")
    ap.add_argument("--table", required=True, help="Source table name")
    ap.add_argument("--mode", default="fast", choices=["fast", "normal", "full"],
                    help="Speed preset (default: fast)")
    ap.add_argument("--features", nargs="+", default=None,
                    choices=list(ALL_FEATURES), help="Features to train (default: all)")
    ap.add_argument("--where", default=None, help="SQL WHERE clause")
    ap.add_argument("--limit", type=int, default=None,
                    help="Override row limit (overrides --mode)")
    ap.add_argument("--out-root", default="artifacts", help="Artifacts root dir")
    ap.add_argument("--models", nargs="+", default=None,
                    help="Override model list (overrides --mode)")
    ap.add_argument("--st-horizons", type=int, nargs="+", default=None,
                    help="Override ST horizons (overrides --mode)")
    ap.add_argument("--lt-horizons", type=int, nargs="+", default=None,
                    help="Override LT horizons (overrides --mode)")
    ap.add_argument("--gp-max-rows", type=int, default=None,
                    help="Override GP row cap (overrides --mode)")
    ap.add_argument("--lt-agg", default="mean", choices=["mean", "sum", "last"])
    ap.add_argument("--lt-lags", type=int, nargs="+", default=[1, 2, 3])
    return ap


def main() -> None:
    args = _build_parser().parse_args()

    preset = PRESETS[args.mode].copy()
    limit     = args.limit       if args.limit       is not None else preset["limit_rows"]
    models    = args.models      if args.models       is not None else preset["models"]
    st_h      = args.st_horizons if args.st_horizons  is not None else preset["st_horizons"]
    lt_h      = args.lt_horizons if args.lt_horizons  is not None else preset["lt_horizons"]
    gp_rows   = args.gp_max_rows if args.gp_max_rows  is not None else preset["gp_max_rows"]

    results = train_all_features(
        db_url=args.db_url,
        table=args.table,
        features=args.features,
        where_sql=args.where,
        limit_rows=limit,
        out_root=args.out_root,
        models=models,
        st_horizons=st_h,
        lt_horizons=lt_h,
        gp_max_rows=gp_rows,
        lt_agg=args.lt_agg,
        lt_lags=tuple(args.lt_lags),
    )
    print("\n\nTraining complete. Summary:")
    print(json.dumps(results, indent=2, default=str))


if __name__ == "__main__":
    main()
