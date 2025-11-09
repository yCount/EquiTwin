from fastapi import FastAPI, WebSocket, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
from services.mpc import run_mpc
from services.forecast import forecast_energy
from services.kpis import compute_kpis

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],  # dev
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)

# ---- DTOs (align these with src/types/domain.ts) ----------------------------
class EnergyPoint(BaseModel):
    ts: str; powerKw: float; hvacKw: float; lightsKw: float
    zoneId: Optional[str] = None

class AirPoint(BaseModel):
    ts: str; co2: float; voc: float; pm25: float; pm10: float; temp: float; rh: float
    zoneId: Optional[str] = None

class OccPoint(BaseModel):
    ts: str; people: int; zoneId: Optional[str] = None

class WeatherPoint(BaseModel):
    ts: str; tOut: float; ghi: float; wind: float; rhOut: float

class MpcRequest(BaseModel):
    window_minutes: int = 60
    energy: List[EnergyPoint]
    air: List[AirPoint]
    occ: List[OccPoint]
    weather: List[WeatherPoint]
    constraints: dict = {}
    objective_weights: dict = {"comfort": 1.0, "energy": 1.0, "smooth": 0.1}

class MpcSuggestion(BaseModel):
    ts: str; zoneId: str; setpointC: float; airflow: float; expectedPowerKw: float

# ---- REST -------------------------------------------------------------------
@app.post("/mpc/optimize", response_model=List[MpcSuggestion])
def mpc_optimize(req: MpcRequest):
    return run_mpc(req)

@app.get("/forecast/energy")
def forecast_energy_endpoint(horizon_minutes: int = 120):
    return forecast_energy(horizon_minutes)

@app.get("/kpis")
def kpis():
    return compute_kpis()

# ---- WebSocket for live telemetry push --------------------------------------
@app.websocket("/telemetry/ws")
async def telemetry_ws(ws: WebSocket):
    await ws.accept()
    # In real life, subscribe to your broker; here we stream mock packets.
    import asyncio, datetime, random
    try:
      while True:
        msg = {
          "type": "energy",
          "payload": {
            "ts": datetime.datetime.utcnow().isoformat(),
            "powerKw": round(random.uniform(12, 18), 2),
            "hvacKw": round(random.uniform(5, 8), 2),
            "lightsKw": round(random.uniform(2, 4), 2),
            "zoneId": "Z-101"
          }
        }
        await ws.send_json(msg)
        await asyncio.sleep(2)
    except Exception:
      pass
