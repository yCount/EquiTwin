from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Dict, List, Tuple

from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.linear_model import LinearRegression, Ridge, Lasso, ElasticNet
from sklearn.ensemble import RandomForestRegressor, HistGradientBoostingRegressor, VotingRegressor
from sklearn.neural_network import MLPRegressor
from sklearn.gaussian_process import GaussianProcessRegressor
from sklearn.gaussian_process.kernels import RBF, WhiteKernel, ConstantKernel

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
    kernel = ConstantKernel(1.0) * RBF(length_scale=1.0) + WhiteKernel(noise_level=1.0)
    return {
        "linear": LinearRegression(),
        "ridge": Ridge(alpha=1.0, random_state=random_state),
        "lasso": Lasso(alpha=1e-3, random_state=random_state, max_iter=5000),
        "elastic": ElasticNet(alpha=1e-3, l1_ratio=0.5, random_state=random_state, max_iter=5000),
        "rf": RandomForestRegressor(n_estimators=200, random_state=random_state, n_jobs=-1),
        "hgb": HistGradientBoostingRegressor(random_state=random_state),
        "ann": MLPRegressor(hidden_layer_sizes=(128,64), activation="relu", random_state=random_state, max_iter=300),
        "gp": GaussianProcessRegressor(kernel=kernel, alpha=1e-6, normalize_y=True, random_state=random_state),
    }

def make_voting_ensemble(models: List[Tuple[str, Any]]) -> Any:
    return VotingRegressor(estimators=models, n_jobs=-1)
