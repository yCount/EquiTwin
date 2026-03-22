from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Dict, List, Sequence, Tuple

from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.linear_model import LinearRegression, Ridge, Lasso, ElasticNet
from sklearn.ensemble import (
    RandomForestRegressor,
    HistGradientBoostingRegressor,
    GradientBoostingRegressor,
    VotingRegressor,
)
from sklearn.multioutput import MultiOutputRegressor
from sklearn.neural_network import MLPRegressor
from sklearn.gaussian_process import GaussianProcessRegressor
from sklearn.gaussian_process.kernels import RBF, WhiteKernel, ConstantKernel

# Optional boosting libraries - unavailable if not installed
try:
    from lightgbm import LGBMRegressor as _LGBMRegressor
    _HAS_LGBM = True
except ImportError:
    _HAS_LGBM = False

try:
    from xgboost import XGBRegressor as _XGBRegressor
    _HAS_XGB = True
except ImportError:
    _HAS_XGB = False


@dataclass(frozen=True)
class PreprocessSpec:
    scale_numeric: bool = False

def make_preprocessor(cat_cols: List[str], num_cols: List[str], spec: PreprocessSpec) -> ColumnTransformer:
    # Use constant imputation to avoid failures on all-missing numeric columns in some slices.
    num_steps = [("imp", SimpleImputer(strategy="constant", fill_value=0.0))]
    if spec.scale_numeric:
        num_steps.append(("scaler", StandardScaler()))
    cat_pipe = Pipeline([
        ("imp", SimpleImputer(strategy="most_frequent")),
        ("ohe", OneHotEncoder(handle_unknown="ignore")),
    ])
    return ColumnTransformer(
        transformers=[
            ("num", Pipeline(num_steps), num_cols),
            ("cat", cat_pipe, cat_cols),
        ],
        remainder="drop",
        verbose_feature_names_out=False,
    )

def regression_candidates(random_state: int = 42) -> Dict[str, Any]:
    """
    Return all available point-forecast regression candidates.

    LightGBM ("lgbm") and XGBoost ("xgb") are included only when those
    packages are installed.  Both typically outperform sklearn's HGB on
    real-world tabular data with less tuning.
    """
    kernel = ConstantKernel(1.0) * RBF(length_scale=1.0) + WhiteKernel(noise_level=1.0)
    cands: Dict[str, Any] = {
        "linear": LinearRegression(),
        "ridge":  Ridge(alpha=1.0, random_state=random_state),
        "lasso":  Lasso(alpha=1e-3, random_state=random_state, max_iter=5000),
        "elastic": ElasticNet(alpha=1e-3, l1_ratio=0.5, random_state=random_state, max_iter=5000),
        "rf":     RandomForestRegressor(n_estimators=200, random_state=random_state, n_jobs=-1),
        "hgb":    HistGradientBoostingRegressor(random_state=random_state),
        "ann":    MLPRegressor(hidden_layer_sizes=(128, 64), activation="relu",
                               random_state=random_state, max_iter=300),
        "gp":     GaussianProcessRegressor(kernel=kernel, alpha=1e-6,
                                           normalize_y=True, random_state=random_state),
    }
    if _HAS_LGBM:
        cands["lgbm"] = _LGBMRegressor(
            n_estimators=300, learning_rate=0.05, num_leaves=63,
            random_state=random_state, n_jobs=-1, verbose=-1,
        )
    if _HAS_XGB:
        cands["xgb"] = _XGBRegressor(
            n_estimators=300, learning_rate=0.05, max_depth=6,
            random_state=random_state, n_jobs=-1, verbosity=0,
        )
    return cands


def quantile_candidates(
    quantiles: Sequence[float] = (0.1, 0.5, 0.9),
    random_state: int = 42,
) -> Dict[str, Any]:
    """
    Return quantile regression candidates for prediction-interval estimation.

    For each quantile q, returns a GradientBoostingRegressor with loss='quantile'.
    If LightGBM is installed, also returns faster LGBM quantile variants.

    The resulting prediction interval [q10, q90] lets MPC optimize against
    uncertainty rather than a single point forecast.

    Keys: "q10", "q50", "q90" (and "lgbm_q10" etc. if lgbm available)
    """
    cands: Dict[str, Any] = {}
    for q in quantiles:
        tag = f"q{int(q * 100)}"
        cands[tag] = GradientBoostingRegressor(
            loss="quantile", alpha=q,
            n_estimators=200, learning_rate=0.05,
            random_state=random_state,
        )
        if _HAS_LGBM:
            cands[f"lgbm_{tag}"] = _LGBMRegressor(
                objective="quantile", alpha=q,
                n_estimators=200, learning_rate=0.05, num_leaves=31,
                random_state=random_state, n_jobs=-1, verbose=-1,
            )
    return cands


def make_voting_ensemble(models: List[Tuple[str, Any]]) -> Any:
    return VotingRegressor(estimators=models, n_jobs=-1)


def make_multioutput_model(base_model: Any) -> MultiOutputRegressor:
    """
    Wrap any sklearn regressor in MultiOutputRegressor so it can be trained
    to predict all horizons jointly in a single fit() call.

    This cuts the number of fit() calls from n_horizons to 1, and allows the
    model to share representations across horizons.
    """
    return MultiOutputRegressor(base_model, n_jobs=-1)
