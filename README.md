# EquiTwin

EquiTwin is an AI-driven digital twin platform for building monitoring, forecasting, and hierarchical model predictive control.

- `backend/` — FastAPI service (ingestion, forecasting, MPC, training APIs)
- `frontend/` — React app with iTwin-based 3D UI

---

## Prerequisites

- Python 3.10+ with [Anaconda](https://www.anaconda.com/) (recommended: `DDMPC` conda env)
- Node.js 18+ and npm
- PostgreSQL (required for database-backed features and model training)

## 1. Database

Set the database URL as an environment variable before starting the backend.

**PowerShell:**
```powershell
$env:DATABASE_URL = "postgresql+psycopg2://<USER>:<PASSWORD>@<HOST>:<PORT>/<DBNAME>"
```

**bash/zsh:**
```bash
export DATABASE_URL="postgresql+psycopg2://<USER>:<PASSWORD>@<HOST>:<PORT>/<DBNAME>"
```

## 2. Backend

```bash
cd backend
pip install -r requirements.txt
```

Optional environment variables:

```powershell
$env:ARTIFACTS_ROOT         = "artifacts"
$env:INGESTION_GROUP_ID     = "1"
$env:WEATHER_LAT            = "55.8617"
$env:WEATHER_LON            = "-4.2583"
$env:CONTINUOUS_TRAINING_ENABLED = "1"   # enable live retraining
```

Start the backend:

```bash
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```

- API docs: http://localhost:8000/docs

## 3. Train Forecast Models

Models must be trained before MPC and forecasting endpoints become available.
Run from the `backend/` directory with `DATABASE_URL` set.

**Fast mode** (recommended for first run, ~60–90 s):
```bash
python -m equitwin_integration.train_all --db-url $env:DATABASE_URL --table matches --mode fast
```

**Normal mode** (full model zoo, use after sufficient real data is collected):
```bash
python -m equitwin_integration.train_all --db-url $env:DATABASE_URL --table matches
```

Trained artefacts are saved to `artifacts/{feature}/best/{level}_h{N}/model.joblib`.

## 4. Synthetic Data (optional)

Use when real sensor data is sparse or unavailable.

**4.1: Export real data to CSV:**
```bash
python -m integration.export_dashboard_csv --out exports/dashboard_exact.csv
```

**4.2: Generate a synthetic extension:**
```bash
python -m integration.generate_synthetic_training_data \
    --weeks 40 --start-date 2024-07-01 \
    --merge-real exports/dashboard_exact.csv \
    --out exports/dashboard.csv
```

Or synthesise from the exported CSV directly:
```bash
python -m integration.synthesize_dashboard_timeseries \
    --in exports/dashboard_exact.csv \
    --out exports/dashboard_exact_synthetic.csv \
    --seed 42
```

**4.3: Train with synthetic augmentation:**
```powershell
$env:SYNTHETIC_AUGMENT = "1"
$env:SYNTHETIC_TIMESERIES_CSV = "exports/dashboard_exact_synthetic.csv"
python -m equitwin_integration.train_all --db-url $env:DATABASE_URL --table matches --mode fast
```

**To disable synthetic augmentation:**
```powershell
$env:SYNTHETIC_AUGMENT = "0"
```

## 5. Frontend

```bash
cd frontend
npm install
```

Create `frontend/.env`:

```env
IMJS_AUTH_CLIENT_CLIENT_ID=""
IMJS_AUTH_CLIENT_REDIRECT_URI="http://localhost:3000/signin-callback"
IMJS_AUTH_CLIENT_LOGOUT_URI=""
IMJS_AUTH_CLIENT_SCOPES="itwin-platform"
IMJS_ITWIN_ID=""
IMJS_IMODEL_ID=""
```

Start the frontend:

```bash
npm run start
```

- App: http://localhost:3000

## 6. Full Stack (quick reference)

```powershell
# Terminal 1 - backend
$env:DATABASE_URL = "postgresql+psycopg2://<USER>:<PASSWORD>@<HOST>:<PORT>/<DBNAME>"
cd backend
uvicorn app:app --host 0.0.0.0 --port 8000 --reload

# Terminal 2 - frontend
cd frontend
npm run start
```

## 7. Simulation (withot the UI - on terminal only)

Run a standalone closed-loop building simulation (no database required):

```bash
python simulate_house.py --setpoint 22 --night-setpoint 12 --occupants 50
```

## Notes

- MPC and forecast endpoints return `503` until models are trained and artefacts are present in `artifacts/`
- Database warm-up on startup requires at least 64 rows (~16 h of 15-min data) in the `matches` table
- Backend allows CORS for `http://localhost:3000` by default
- All optional features (continuous training, weather, synthetic augmentation) are controlled by environment variables — no code changes required
