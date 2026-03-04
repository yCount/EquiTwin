
from __future__ import annotations
import argparse, json
from training.service import train_feature_best_models_two_level
from features.registry import ENERGY

def build_parser():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db-url", required=True)
    ap.add_argument("--table", required=True)
    ap.add_argument("--where", default=None)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--out-root", default="artifacts")
    ap.add_argument("--st-horizons", type=int, nargs="+", default=None)
    ap.add_argument("--lt-horizons", type=int, nargs="+", default=None)
    ap.add_argument("--models", nargs="+", default=None, help="Model names to evaluate")
    ap.add_argument("--gp-max-rows", type=int, default=800)
    ap.add_argument("--lt-agg", default="mean", choices=["mean","sum","last"])
    ap.add_argument("--lt-lags", type=int, nargs="+", default=[1,2,3])
    return ap

def main():
    args = build_parser().parse_args()
    summary = train_feature_best_models_two_level(
        feature=ENERGY,
        db_url=args.db_url,
        table=args.table,
        where_sql=args.where,
        limit_rows=args.limit,
        out_root=args.out_root,
        st_horizons=args.st_horizons,
        lt_horizons=args.lt_horizons,
        models=args.models,
        gp_max_rows=args.gp_max_rows,
        lt_agg=args.lt_agg,
        lt_lags=tuple(args.lt_lags),
    )
    print(json.dumps(summary, indent=2))

if __name__ == "__main__":
    main()
