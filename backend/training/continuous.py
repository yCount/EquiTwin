"""
Continuous (online) retraining of forecast models as new sensor data arrives.
"""
from __future__ import annotations

import logging
import os
import threading
import time
import warnings
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

_ALL_FEATURES: Tuple[str, ...] = ("energy", "temperature", "airquality", "occupancy")

# Mirror the presets from equitwin_integration/train_all.py (kept local to avoid
# import cycles and to let continuous training use its own conservative defaults).
_PRESETS: Dict[str, Dict[str, Any]] = {
    "fast": {
        "limit_rows":  600,
        "models":      ["ridge", "hgb", "rf"],
        "st_horizons": [1, 3, 6],
        "lt_horizons": [1, 3],
        "gp_max_rows": 200,
    },
    "normal": {
        "limit_rows":  5000,
        "models":      ["ridge", "hgb", "rf", "ann", "gp"],
        "st_horizons": [1, 2, 3, 4, 6, 8],
        "lt_horizons": [1, 2, 3, 4, 5, 6],
        "gp_max_rows": 400,
    },
    "full": {
        "limit_rows":  None,
        "models":      None,
        "st_horizons": None,
        "lt_horizons": None,
        "gp_max_rows": 800,
    },
}


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


class ContinuousTrainer:
    """
    Tracks rows added to the matches table and triggers background retraining.

    Call notify() after every new match row is written to the DB.

    Only one training run is allowed at a time — additional notify() calls
    during an active run reset the counter and wait for the next interval.

    After a successful retrain, ForecastService.reload_models() is called to
    hot-swap the predictor banks without losing ring-buffer history.
    """

    def __init__(
        self,
        db_url: str,
        artifacts_root: str,
        *,
        interval_rows: int = 500,
        min_rows: int = 200,
        features: Optional[Tuple[str, ...]] = None,
        mode: str = "fast",
        forecast_service: Optional[Any] = None,
        table: str = "matches",
    ) -> None:
        self._db_url = db_url
        self._artifacts_root = artifacts_root
        self._interval_rows = max(1, interval_rows)
        self._min_rows = max(0, min_rows)
        self._features: Tuple[str, ...] = features if features else _ALL_FEATURES
        self._mode = mode if mode in _PRESETS else "fast"
        self._forecast_service = forecast_service
        self._table = table

        self._counter = 0
        self._lock = threading.Lock()
        self._is_training = False
        self._last_train_ts: Optional[float] = None
        self._train_count = 0
        self._last_error: Optional[str] = None

    # public

    def notify(self) -> None:
        """
        Call after each successful match-row insert.

        Non-blocking and thread-safe.  Retraining runs in a daemon thread so
        this call always returns immediately.
        """
        self._counter += 1
        if self._counter < self._interval_rows:
            return
        self._counter = 0
        self._maybe_start_train()

    @property
    def is_training(self) -> bool:
        return self._is_training

    @property
    def train_count(self) -> int:
        return self._train_count

    def status(self) -> Dict[str, Any]:
        return {
            "enabled": True,
            "interval_rows": self._interval_rows,
            "min_rows": self._min_rows,
            "features": list(self._features),
            "mode": self._mode,
            "rows_since_last_train": self._counter,
            "is_training": self._is_training,
            "last_train_time": self._last_train_ts,
            "train_count": self._train_count,
            "last_error": self._last_error,
        }

    # private

    def _maybe_start_train(self) -> None:
        with self._lock:
            if self._is_training:
                logger.info(
                    "[ContinuousTrainer] Interval reached but previous run still active — skipping."
                )
                return
            self._is_training = True

        t = threading.Thread(
            target=self._run_train, daemon=True, name="equitwin-continuous-trainer"
        )
        t.start()

    def _run_train(self) -> None:
        logger.info(
            "[ContinuousTrainer] Background retrain starting (mode=%s, features=%s).",
            self._mode,
            self._features,
        )
        try:
            self._do_train()
            self._train_count += 1
            self._last_train_ts = time.time()
            self._last_error = None
            logger.info(
                "[ContinuousTrainer] Retrain #%d complete. Hot-reloading models.",
                self._train_count,
            )
            self._reload_forecast_service()
        except Exception as exc:
            self._last_error = str(exc)
            logger.error("[ContinuousTrainer] Retrain failed: %s", exc, exc_info=True)
        finally:
            with self._lock:
                self._is_training = False

    def _do_train(self) -> None:
        from features.registry import ENERGY, TEMPERATURE, AIRQUALITY_CO2, OCCUPANCY
        from training.service import train_feature_best_models_two_level

        feature_map = {
            "energy":      ENERGY,
            "temperature": TEMPERATURE,
            "airquality":  AIRQUALITY_CO2,
            "occupancy":   OCCUPANCY,
        }

        preset = _PRESETS[self._mode]

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            for fname in self._features:
                spec = feature_map.get(fname)
                if spec is None:
                    logger.warning(
                        "[ContinuousTrainer] Unknown feature '%s', skipping.", fname
                    )
                    continue
                logger.info("[ContinuousTrainer] Training feature: %s", fname)
                try:
                    train_feature_best_models_two_level(
                        spec,
                        self._db_url,
                        self._table,
                        limit_rows=preset["limit_rows"],
                        out_root=self._artifacts_root,
                        st_horizons=preset["st_horizons"],
                        lt_horizons=preset["lt_horizons"],
                        models=preset["models"],
                        gp_max_rows=preset["gp_max_rows"],
                    )
                except Exception as exc:
                    logger.error(
                        "[ContinuousTrainer] Feature '%s' training failed: %s",
                        fname,
                        exc,
                        exc_info=True,
                    )

    def _reload_forecast_service(self) -> None:
        if self._forecast_service is None:
            return
        try:
            self._forecast_service.reload_models()
            logger.info(
                "[ContinuousTrainer] ForecastService models reloaded successfully."
            )
        except Exception as exc:
            logger.error(
                "[ContinuousTrainer] Model reload failed: %s", exc, exc_info=True
            )


def build_continuous_trainer(
    db_url: str,
    artifacts_root: str,
    forecast_service: Optional[Any] = None,
    table: str = "matches",
) -> Optional[ContinuousTrainer]:
    """
    Factory — reads all configuration from environment variables.

    Returns None when CONTINUOUS_TRAINING_ENABLED is not truthy (default).
    """
    if not _env_flag("CONTINUOUS_TRAINING_ENABLED"):
        return None

    try:
        interval = int(os.environ.get("CONTINUOUS_TRAIN_INTERVAL_ROWS", "500"))
    except ValueError:
        interval = 500

    try:
        min_rows = int(os.environ.get("CONTINUOUS_TRAIN_MIN_ROWS", "200"))
    except ValueError:
        min_rows = 200

    raw_features = os.environ.get("CONTINUOUS_TRAIN_FEATURES", "").strip()
    if raw_features:
        features: Tuple[str, ...] = tuple(
            f.strip() for f in raw_features.split(",") if f.strip()
        )
    else:
        features = _ALL_FEATURES

    mode = os.environ.get("CONTINUOUS_TRAIN_MODE", "fast").strip().lower()
    if mode not in _PRESETS:
        mode = "fast"

    logger.info(
        "[ContinuousTrainer] Enabled — interval_rows=%d, min_rows=%d, "
        "features=%s, mode=%s",
        interval,
        min_rows,
        features,
        mode,
    )

    return ContinuousTrainer(
        db_url=db_url,
        artifacts_root=artifacts_root,
        interval_rows=interval,
        min_rows=min_rows,
        features=features,
        mode=mode,
        forecast_service=forecast_service,
        table=table,
    )
