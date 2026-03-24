import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  ComposedChart, Line, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import "./ControllerTab.scss";
import Topbar from "./components/Topbar";
import RightSidebar, { SidebarSection } from "./components/RightSidebar";
import MainContent, { ContentArea, Section } from "./components/MainContent";

//  Types

interface FeatureHorizonMeta { model: string | null; mase: number | null; r2: number | null; }
interface AllModelRow { model: string; horizon: number; mase: number | null; rmse: number | null; r2: number | null; }
interface FeatureArtifact {
  st: Record<string, FeatureHorizonMeta>;
  lt: Record<string, FeatureHorizonMeta>;
  all_models_st: AllModelRow[];
  candidates_saved: string[];
}
type ArtifactsMap = Record<string, FeatureArtifact>;

const FEATURE_DEFS = [
  { key: "energy",      label: "Energy",      unit: "kW"  },
  { key: "temperature", label: "Temperature", unit: "°C"  },
  { key: "occupancy",   label: "Occupancy",   unit: "ppl" },
] as const;

interface SimConfig {
  setpoint:      number;
  nightSetpoint: number;
  nOccupants:    number;
  ticks:         number;
  initTemp:      number;
  speed:         number;
  // QP cost weight dials (backend applies multiplier; see app.py)
  wComfort:  number;  // 10–500  — actual = wComfort         (temperature tracking)
  wEnergy:   number;  // 0–100   — actual = wEnergy   × 5e-3 (energy cost)
  wSmooth:   number;  // 0–100   — actual = wSmooth   × 1e-5 (anti-oscillation)
  qTerminal: number;  // 1–15    — terminal horizon weight multiplier
}

interface SimTick {
  type:               "tick";
  tick:               number;
  total_ticks:        number;
  sim_time:           string;
  mode:               string;   // "NGHT" | "PRE" | "WORK" | "POST"
  mpc_active:         boolean;
  warming_up:         boolean;
  indoor_temp:        number;
  outdoor_temp:       number;
  setpoint:           number;
  n_people:           number;
  hvac_w:             number;
  cumulative_kwh:     number;
  forecast_energy_st1: number | null;
  energy_budget_lt:   Record<string, number> | null;
  temp_ref_lt:        Record<string, number> | null;
  error:              string | null;
  // QP solver diagnostics
  qp_solver?:         string;           // "SLSQP" | "proportional_fallback" | "none"
  qp_error?:          string;           // set when QP falls back due to exception
  qp_converged?:      boolean | null;
  qp_iter?:           number | null;
  // Applied weights echoed back from backend (confirms tuning is live)
  applied_w_comfort?:  number;
  applied_w_energy?:   number;
  applied_w_smooth?:   number;
  applied_q_terminal?: number;
  t_star_now?:        number | null;   // per-step T* at current tick (occupancy-aware)
  q_t_now?:           number | null;   // comfort weight scale Q_T at current tick [0.25–1.8]
  e_budget_wh?:       number | null;   // horizon energy budget [Wh]
  u_max_w?:           number | null;   // outer-plan HVAC power cap [W]
  u_sequence_w?:      number[];        // optimised heating power plan [W]
  v_sequence?:        number[];        // optimised ventilation rate plan [%]
  t_pred_st?:         number[];        // ML+QP predicted T trajectory [°C]
  t_star_st?:         number[];        // T* setpoint trajectory [°C]
  // Active targets (always present from backend)
  // Outer plan LT refs
  t_star_lt?:         Record<string, number> | null;
  occupancy_ref_lt?:  Record<string, number> | null;
}

interface SimComplete {
  type:           "complete";
  final_temp:     number;
  total_kwh:      number;
  mpc_ticks:      number;
  total_ticks:    number;
}

interface ChartPoint {
  time:     string;
  indoor:   number;
  outdoor:  number;
  setpoint: number;
  hvac_kw:  number;
  t_star?:  number;   // occupancy-aware dynamic setpoint [°C]
  n_people?:     number;  // occupant count
}

interface ControlTrajectoryPoint {
  label: string;
  indoor_actual?: number | null;
  indoor_pred?: number | null;
  outdoor?: number | null;
  setpoint?: number | null;
  t_star?: number | null;
  hvac_kw_actual?: number | null;
  hvac_kw_plan?: number | null;
}

interface SignalWindowPoint {
  time: string;
  indoor?: number | null;
  outdoor?: number | null;
  setpoint?: number | null;
  hvac_kw?: number | null;
  t_star?: number | null;
  n_people?: number | null;
}

type SimStatus = "idle" | "running" | "complete" | "stopped" | "error";

//  Constants 

const WS_URL = "ws://localhost:8000/simulation/ws";

const MODE_COLORS: Record<string, string> = {
  NGHT: "#64748b",
  PRE:  "#f59e0b",
  WORK: "#10b981",
  POST: "#8b5cf6",
};

const MODE_LABELS: Record<string, string> = {
  NGHT: "Night",
  PRE:  "Pre-shift",
  WORK: "Workshift",
  POST: "Post-shift",
};

const LIVE_HISTORY_WINDOW = 120;
const LIVE_CHART_ANIMATION_MS = 180;

//  Component 

const ControllerTab: React.FC = () => {
  // Simulation config (editable before / between runs)
  const [simConfig, setSimConfig] = useState<SimConfig>({
    setpoint:       22.0,
    nightSetpoint:  15.0,
    nOccupants:     10,
    ticks:          96,
    initTemp:       14.0,
    speed:          0.05,
    // QP cost weight dials (defaults match module-level constants in hierarchical.py)
    wComfort:  120,   // W_comfort = 120   → effective ~42 (empty) – 168 (full)
    wEnergy:   15,    // W_energy  = 7.5e-2
    wSmooth:   20,    // W_smooth  = 20×1e-5 = 2e-4 (raised from 5 to dampen oscillation)
    qTerminal: 1.5,   // Q_terminal = 1.5 (reduced from 3.0 to soften end-horizon aggression)
  });

  // Live simulation state
  const [simStatus,   setSimStatus]   = useState<SimStatus>("idle");
  const [latestTick,  setLatestTick]  = useState<SimTick | null>(null);
  const [chartData,   setChartData]   = useState<ChartPoint[]>([]);
  const [simComplete, setSimComplete] = useState<SimComplete | null>(null);
  const [hasMpc,      setHasMpc]      = useState(false);
  const [warmRows,    setWarmRows]    = useState(20);   // min ticks before MPC activates
  const [errorMsg,    setErrorMsg]    = useState<string | null>(null);

  // Model selector
  const [modelArtifacts, setModelArtifacts] = useState<ArtifactsMap>({});
  const [activeFeatures, setActiveFeatures] = useState<Set<string>>(
    new Set(FEATURE_DEFS.map(f => f.key))
  );
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("http://localhost:8000/api/artifacts/status")
      .then(r => r.ok ? r.json() : null)
      .then((data: ArtifactsMap | null) => {
        if (!data) return;
        setModelArtifacts(data);
        const loaded = new Set(
          FEATURE_DEFS.map(f => f.key).filter(k => {
            const fa = data[k];
            return fa && Object.keys(fa.st).length > 0;
          })
        );
        if (loaded.size > 0) setActiveFeatures(loaded);
      })
      .catch(() => {});
  }, []);

  const toggleFeature = useCallback((key: string) => {
    setActiveFeatures(prev => {
      const next = new Set(prev);
      if (next.has(key)) { if (next.size > 1) next.delete(key); }
      else next.add(key);
      return next;
    });
  }, []);

  // Sidebar-only MPC objective weight (local, informational)
  const [comfortWeight, setComfortWeight] = useState(0.6);

  // Refs
  const wsRef        = useRef<WebSocket | null>(null);
  const isRunningRef = useRef(false);
  const lastDrawRef  = useRef(0);   // throttle chart state updates

  // --- Start
  const startSimulation = useCallback(() => {
    wsRef.current?.close();

    setSimStatus("running");
    setLatestTick(null);
    setChartData([]);
    setSimComplete(null);
    setErrorMsg(null);
    isRunningRef.current = true;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type:   "start",
        config: {
          setpoint:       simConfig.setpoint,
          nightSetpoint:  simConfig.nightSetpoint,
          nOccupants:     simConfig.nOccupants,
          ticks:          simConfig.ticks,
          initTemp:       simConfig.initTemp,
          speed:          simConfig.speed,
          startHour:      0.0,
          wComfort:       simConfig.wComfort,
          wEnergy:        simConfig.wEnergy,
          wSmooth:        simConfig.wSmooth,
          qTerminal:      simConfig.qTerminal,
          activeFeatures: [...activeFeatures],
          modelOverrides: Object.keys(modelOverrides).length > 0 ? modelOverrides : undefined,
        },
      }));
    };

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data as string);

      if (msg.type === "started") {
        setHasMpc(msg.has_mpc as boolean);
        if (msg.warm_rows != null) setWarmRows(msg.warm_rows as number);

      } else if (msg.type === "tick") {
        const t = msg as SimTick;
        setLatestTick(t);

        // Throttle chart re-renders: update at most every ~50 ms
        const now = performance.now();
        if (now - lastDrawRef.current > 50) {
          lastDrawRef.current = now;
          const dt = new Date(t.sim_time);
          const label = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          setChartData(prev => [
            ...prev.slice(-(LIVE_HISTORY_WINDOW - 1)),
            {
              time:     label,
              indoor:   t.indoor_temp,
              outdoor:  t.outdoor_temp,
              setpoint: t.setpoint,
              hvac_kw:  +(t.hvac_w / 1000).toFixed(3),
              t_star:   t.t_star_now ?? t.setpoint,
              n_people: t.n_people,
            },
          ]);
        }

      } else if (msg.type === "complete") {
        isRunningRef.current = false;
        setSimComplete(msg as SimComplete);
        setSimStatus("complete");
      } else if (msg.type === "stopped") {
        isRunningRef.current = false;
        setSimStatus("stopped");
      } else if (msg.type === "error") {
        isRunningRef.current = false;
        setErrorMsg((msg as any).message as string);
        setSimStatus("error");
      }
    };

    ws.onerror = () => {
      isRunningRef.current = false;
      setErrorMsg("WebSocket connection failed — is the backend running on port 8000?");
      setSimStatus("error");
    };

    ws.onclose = () => {
      if (isRunningRef.current) {
        isRunningRef.current = false;
        setSimStatus("stopped");
      }
    };
  }, [simConfig, activeFeatures, modelOverrides]);

  // --- Stop
  const stopSimulation = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop" }));
    }
    isRunningRef.current = false;
    setSimStatus("stopped");
  }, []);

  // Cleanup on unmount
  useEffect(() => () => { wsRef.current?.close(); }, []);

  // --- Derived values
  const isRunning   = simStatus === "running";
  const progress    = latestTick ? (latestTick.tick + 1) / latestTick.total_ticks : 0;
  const warmupLeft  = latestTick?.warming_up ? Math.max(0, warmRows - (latestTick.tick + 1)) : 0;
  const modeColor   = latestTick ? (MODE_COLORS[latestTick.mode] ?? "#64748b") : "#64748b";

  const topStatus =
    isRunning         ? "active"   :
    simStatus === "complete" ? "complete" :
    simStatus === "error"    ? "error"    : "paused";

  const topLabel =
    isRunning         ? "Simulation Running"  :
    simStatus === "complete" ? "Complete"          :
    simStatus === "error"    ? "Error"             :
    simStatus === "stopped"  ? "Stopped"           : "Idle";
  const comfortTrajectory =
    latestTick?.t_pred_st && latestTick?.t_star_st
      ? [
          {
            step: 0,
            label: "now",
            predicted: latestTick.indoor_temp,
            target: latestTick.t_star_now ?? latestTick.t_star_st?.[0] ?? latestTick.setpoint,
          },
          ...latestTick.t_pred_st.map((temp, i) => ({
            step: i + 1,
            label: `+${(i + 1) * 15}m`,
            predicted: temp,
            target: latestTick.t_star_st?.[i] ?? null,
          })),
        ]
      : [];

  const controlHistory = latestTick && chartData.length > 0 ? chartData.slice(0, -1) : chartData;
  const controlHistoryPadding = Math.max(0, LIVE_HISTORY_WINDOW - controlHistory.length - (latestTick ? 1 : 0));
  const signalWindowPadding = Math.max(0, LIVE_HISTORY_WINDOW - chartData.length);
  const signalChartData: SignalWindowPoint[] =
    chartData.length === 0
      ? []
      : [
          ...Array.from({ length: signalWindowPadding }, () => ({
            time: "",
            n_people: null,
            hvac_kw: null,
          })),
          ...chartData,
        ];

  const controlTrajectoryData: ControlTrajectoryPoint[] =
    controlHistory.length === 0 && !latestTick
      ? []
      : [
          ...Array.from({ length: controlHistoryPadding }, () => ({
            label: "",
            indoor_actual: null,
            indoor_pred: null,
            outdoor: null,
            setpoint: null,
            t_star: null,
            hvac_kw_actual: null,
            hvac_kw_plan: null,
          })),
          ...controlHistory.map((point) => ({
            label: point.time,
            indoor_actual: point.indoor,
            indoor_pred: null,
            outdoor: point.outdoor,
            setpoint: point.setpoint,
            t_star: point.t_star ?? point.setpoint,
            hvac_kw_actual: point.hvac_kw,
            hvac_kw_plan: null,
          })),
          ...(latestTick
            ? [{
                label: "now",
                indoor_actual: latestTick.indoor_temp,
                indoor_pred: latestTick.indoor_temp,
                outdoor: latestTick.outdoor_temp,
                setpoint: latestTick.setpoint,
                t_star: latestTick.t_star_now ?? latestTick.setpoint,
                hvac_kw_actual: +(latestTick.hvac_w / 1000).toFixed(3),
                hvac_kw_plan: latestTick.u_sequence_w?.[0] != null
                  ? +(latestTick.u_sequence_w[0] / 1000).toFixed(3)
                  : +(latestTick.hvac_w / 1000).toFixed(3),
              }]
            : []),
          ...(latestTick?.t_pred_st?.map((temp, i) => ({
            label: `+${(i + 1) * 15}m`,
            indoor_actual: null,
            indoor_pred: temp,
            outdoor: null,
            setpoint: latestTick.setpoint,
            t_star: latestTick.t_star_st?.[i] ?? latestTick.t_star_now ?? latestTick.setpoint,
            hvac_kw_actual: null,
            hvac_kw_plan: latestTick.u_sequence_w?.[i] != null
              ? +(latestTick.u_sequence_w[i] / 1000).toFixed(3)
              : null,
          })) ?? []),
        ];

  // ---
  return (
    <div className="controller-container">
      <Topbar
        variant="controller"
        title="Controller"
        subtitle="Digital-Twin Building Simulation"
        rightContent={
          <div className="topbar-actions-group">
            <div className={`system-status-pill ${topStatus}`}>
              <span className="dot" /> {topLabel}
            </div>
            {!isRunning ? (
              <button className="btn btn-sm btn-primary" onClick={startSimulation}>
                Run Simulation
              </button>
            ) : (
              <button className="btn btn-sm btn-danger" onClick={stopSimulation}>
                Stop
              </button>
            )}
          </div>
        }
      />

      <MainContent
        sidebar={
          <RightSidebar width="360px">

            {/* Simulation Setup */}
            <SidebarSection title="Simulation Setup">
              {(
                [
                  { label: "Work Setpoint",    key: "setpoint",       min: 18,  max: 26,   step: 0.5,  fmt: (v: number) => `${v.toFixed(1)} °C`,
                    hint: "18–26 °C — ASHRAE 55 comfort range" },
                  { label: "Night Setpoint",   key: "nightSetpoint",  min: 10,  max: 20,   step: 0.5,  fmt: (v: number) => `${v.toFixed(1)} °C`,
                    hint: "Frost-protection minimum during unoccupied hours" },
                  { label: "Occupants",        key: "nOccupants",     min: 1,   max: 100,  step: 1,    fmt: (v: number) => `${v}`,
                    hint: undefined },
                  { label: "Duration",         key: "ticks",          min: 24,  max: 192,  step: 24,   fmt: (v: number) => `${v * 15 / 60} h`,
                    hint: undefined },
                  { label: "Init. Temp",       key: "initTemp",       min: 8,   max: 24,   step: 1,    fmt: (v: number) => `${v} °C`,
                    hint: undefined },
                  { label: "Speed",            key: "speed",          min: 0,   max: 1.0,  step: 0.05, fmt: (v: number) => v === 0 ? "Max" : `${v}s`,
                    hint: undefined },
                ] as Array<{ label: string; key: keyof SimConfig; min: number; max: number; step: number; fmt: (v: number) => string; hint: string | undefined }>
              ).map(({ label, key, min, max, step, fmt, hint }) => (
                <div key={key} className="advanced-input-group">
                  <label>{label}</label>
                  <div className="input-row">
                    <input
                      type="range" min={min} max={max} step={step}
                      value={simConfig[key] as number}
                      onChange={e => setSimConfig(c => ({ ...c, [key]: parseFloat(e.target.value) }))}
                      disabled={isRunning}
                    />
                    <span className="val">{fmt(simConfig[key] as number)}</span>
                  </div>
                  {hint && <div className="input-hint">{hint}</div>}
                </div>
              ))}
            </SidebarSection>

            {/* MPC Cost Weight Tuning */}
            <SidebarSection title="MPC Tuning">
              {(
                [
                  {
                    label: "Smoothness",
                    key:   "wSmooth" as keyof SimConfig,
                    min: 0, max: 100, step: 1,
                    fmt: (v: number) => `${v} (${(v * 1e-5).toExponential(0)})`,
                    hint: "↑ Reduces oscillation/pendulum — penalises step changes in HVAC & vent",
                  },
                  {
                    label: "Terminal Weight",
                    key:   "qTerminal" as keyof SimConfig,
                    min: 1, max: 15, step: 0.5,
                    fmt: (v: number) => `${v.toFixed(1)}×`,
                    hint: "↓ Reduces end-of-horizon aggression — lower = smoother receding horizon",
                  },
                  {
                    label: "Comfort Weight",
                    key:   "wComfort" as keyof SimConfig,
                    min: 10, max: 500, step: 10,
                    fmt: (v: number) => `${v}`,
                    hint: "Temperature tracking aggressiveness — higher = chases setpoint harder",
                  },
                  {
                    label: "Energy Cost",
                    key:   "wEnergy" as keyof SimConfig,
                    min: 0, max: 100, step: 1,
                    fmt: (v: number) => `${v} (${(v * 5e-3).toFixed(3)})`,
                    hint: "Linear electricity cost — higher = less willing to sit at max HVAC during occupied hours",
                  },
                ] as Array<{ label: string; key: keyof SimConfig; min: number; max: number; step: number; fmt: (v: number) => string; hint: string }>
              ).map(({ label, key, min, max, step, fmt, hint }) => (
                <div key={key} className="advanced-input-group">
                  <label>{label}</label>
                  <div className="input-row">
                    <input
                      type="range" min={min} max={max} step={step}
                      value={simConfig[key] as number}
                      onChange={e => setSimConfig(c => ({ ...c, [key]: parseFloat(e.target.value) }))}
                      disabled={isRunning}
                    />
                    <span className="val">{fmt(simConfig[key] as number)}</span>
                  </div>
                  <div className="input-hint">{hint}</div>
                </div>
              ))}
            </SidebarSection>

            {/*  Controller Status  */}
            <SidebarSection title="Controller Status">
              <div className="mpc-status-box">
                {!latestTick ? (
                  <div className="status-idle">
                    Configure and press <strong>Run Simulation</strong> to start.
                  </div>
                ) : (
                  <>
                    <div className="status-row">
                      <span className="label">Building Mode</span>
                      <span className="mode-badge" style={{ background: modeColor }}>
                        {latestTick.mode}
                        <span className="mode-sub">{MODE_LABELS[latestTick.mode]}</span>
                      </span>
                    </div>
                    <div className="status-row">
                      <span className="label">MPC Status</span>
                      <span className={`status-chip ${latestTick.mpc_active ? "active" : latestTick.warming_up ? "warming" : "standby"}`}>
                        {latestTick.mpc_active  ? "● Active"
                          : warmupLeft > 0      ? `⏳ ${warmupLeft} ticks left`
                          : "○ Standby"}
                      </span>
                    </div>
                    <div className="status-row">
                      <span className="label">MPC Engine</span>
                      <span className={`status-chip ${hasMpc ? "active" : "standby"}`}>
                        {hasMpc ? "Models Loaded" : "No Artifacts"}
                      </span>
                    </div>
                    {latestTick.energy_budget_lt && (
                      <div className="status-row">
                        <span className="label">E Budget (LT1)</span>
                        <span className="mono-val">
                          {Object.values(latestTick.energy_budget_lt)[0].toFixed(0)} W
                        </span>
                      </div>
                    )}
                    {latestTick.temp_ref_lt && (
                      <div className="status-row">
                        <span className="label">T Ref (LT1)</span>
                        <span className="mono-val">
                          {Object.values(latestTick.temp_ref_lt)[0].toFixed(1)} °C
                        </span>
                      </div>
                    )}
                    {latestTick.forecast_energy_st1 !== null && (
                      <div className="status-row">
                        <span className="label">Fcst E (ST1)</span>
                        <span className="mono-val">{latestTick.forecast_energy_st1} W</span>
                      </div>
                    )}
                    {/* QP solver line */}
                    {latestTick.mpc_active && latestTick.qp_converged != null && (
                      <>
                        <div className="status-divider" />
                        <div className="status-row">
                          <span className="label">QP Solver</span>
                          <span className={`status-chip ${latestTick.qp_converged ? "active" : "warming"}`}>
                            {latestTick.qp_converged ? `✓ ok · ${latestTick.qp_iter}it` : `⚠ nc · ${latestTick.qp_iter}it`}
                          </span>
                        </div>
                        {latestTick.t_star_now != null && (
                          <div className="status-row">
                            <span className="label">T* (MPC)</span>
                            <span className="mono-val" style={{ color: "#a78bfa" }}>{latestTick.t_star_now.toFixed(1)} °C</span>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            </SidebarSection>

            {/*  Active Models  */}
            <SidebarSection title="Active Models">
              <div className="model-select-grid">
                {FEATURE_DEFS.map(({ key, label, unit }) => {
                  const fa  = modelArtifacts[key];
                  const stH1 = fa?.st?.["1"];
                  const bestModelKey = stH1?.model ?? null;
                  const rawModel = bestModelKey;
                  const modelName = rawModel
                    ? (rawModel.split(".").pop()?.replace(/Regressor|Classifier|Forecaster/g, "") ?? rawModel)
                    : null;
                  const mase     = stH1?.mase ?? null;
                  const isActive = activeFeatures.has(key);
                  const hasModel = !!fa && Object.keys(fa.st).length > 0;
                  const maseClass =
                    mase == null ? "none" :
                    mase < 0.9  ? "good" :
                    mase < 1.2  ? "warn" : "bad";
                  const isLast = activeFeatures.size === 1 && isActive;

                  // Build unique model options from all_models_st (h1 rows)
                  const candidateRows = (fa?.all_models_st ?? []).filter(r => r.horizon === 1);
                  const seenModels = new Set<string>();
                  const options: AllModelRow[] = [];
                  for (const r of candidateRows) {
                    if (!seenModels.has(r.model)) { seenModels.add(r.model); options.push(r); }
                  }
                  // Sort: best first, rest by mase asc
                  options.sort((a, b) => {
                    if (a.model === bestModelKey) return -1;
                    if (b.model === bestModelKey) return 1;
                    return (a.mase ?? 99) - (b.mase ?? 99);
                  });

                  const savedSet = new Set(fa?.candidates_saved ?? []);
                  const selectedKey = modelOverrides[key] ?? bestModelKey ?? "";

                  return (
                    <div
                      key={key}
                      className={`model-feature-card ${isActive ? "on" : "off"} ${!hasModel ? "no-model" : ""} ${isLast ? "last" : ""}`}
                    >
                      <div
                        className="mfc-toggle-area"
                        onClick={() => !isLast && hasModel && toggleFeature(key)}
                        title={
                          !hasModel ? "No model artifacts loaded" :
                          isLast    ? "At least one feature must stay active" :
                          isActive  ? `Disable ${label} in MPC` :
                                      `Enable ${label} in MPC`
                        }
                      >
                        <div className="mfc-top">
                          <span className="mfc-label">{label}</span>
                          <span className="mfc-unit">{unit}</span>
                        </div>
                        <div className="mfc-bottom">
                          <span className="mfc-model">{modelName ?? "—"}</span>
                          {mase !== null ? (
                            <span className={`mase-chip ${maseClass}`}>{mase.toFixed(2)}</span>
                          ) : (
                            <span className="mase-chip none">—</span>
                          )}
                        </div>
                        <div className={`mfc-toggle-dot ${isActive ? "on" : "off"}`} />
                      </div>
                      {hasModel && options.length > 0 && (
                        <select
                          className="mfc-select"
                          value={selectedKey}
                          disabled={isRunning}
                          onClick={e => e.stopPropagation()}
                          onChange={e => {
                            const val = e.target.value;
                            setModelOverrides(prev => {
                              const next = { ...prev };
                              if (val === bestModelKey) delete next[key];
                              else next[key] = val;
                              return next;
                            });
                          }}
                        >
                          {options.map(opt => {
                            const isBest = opt.model === bestModelKey;
                            const isSaved = isBest || savedSet.has(opt.model);
                            const maseStr = opt.mase != null ? ` ${opt.mase.toFixed(2)}` : "";
                            return (
                              <option key={opt.model} value={opt.model} disabled={!isSaved}>
                                {opt.model}{isBest ? " (best)" : maseStr}{!isSaved ? " [re-train]" : ""}
                              </option>
                            );
                          })}
                        </select>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="model-select-hint">
                Toggle features included in the MPC forecast loop.
              </p>
            </SidebarSection>

          </RightSidebar>
        }
        sidebarWidth="360px"
      >
        <ContentArea padding="compact" gap="16px">

          {/*  KPI Hero Row  */}
          <div className="kpi-hero-row">
            <div className="kpi-hero-card">
              <div className="kpi-label">Indoor Temp</div>
              <div className="kpi-val">
                {latestTick ? latestTick.indoor_temp.toFixed(1) : "--"}
                <span className="unit">°C</span>
              </div>
              <div className="kpi-sub">
                {latestTick ? `Setpoint ${latestTick.setpoint.toFixed(1)} °C` : "Setpoint --"}
              </div>
            </div>

            <div className="kpi-hero-card">
              <div className="kpi-label">Occupancy</div>
              <div className="kpi-val">
                {latestTick ? latestTick.n_people : "--"}
                <span className="unit">ppl</span>
              </div>
              {latestTick && (
                <div className="kpi-trend flat">
                  Occupancy driven
                </div>
              )}
            </div>

            <div className="kpi-hero-card">
              <div className="kpi-label">HVAC Power</div>
              <div className="kpi-val">
                {latestTick ? (latestTick.hvac_w / 1000).toFixed(2) : "--"}
                <span className="unit">kW</span>
              </div>
              <div className="kpi-sub">
                {latestTick ? `${latestTick.n_people} occupants` : "Occupancy --"}
              </div>
            </div>

            <div className="kpi-hero-card highlight">
              <div className="kpi-label">Total Energy</div>
              <div className="kpi-val">
                {latestTick ? latestTick.cumulative_kwh.toFixed(2) : "--"}
                <span className="unit">kWh</span>
              </div>
              <div className="kpi-sub">
                {latestTick
                  ? `Tick ${latestTick.tick + 1} / ${latestTick.total_ticks}`
                  : "Tick -- / --"}
              </div>
            </div>
          </div>

          {/*  Simulation progress / status banner  */}
          <div className="sim-status-row">
            {simStatus === "idle" && (
              <div className="sim-msg idle">
                Configure parameters in the sidebar, then press <strong>Run Simulation</strong>.
              </div>
            )}
            {isRunning && latestTick && (
              <>
                <div className="sim-progress-wrap">
                  <div className="sim-progress-bar" style={{ width: `${progress * 100}%` }} />
                </div>
                <div className="sim-progress-labels">
                  <span className="mono">{Math.round(progress * 100)}%</span>
                  <span>
                    {latestTick.mpc_active
                      ? <span className="mpc-on">MPC Active</span>
                      : warmupLeft > 0
                      ? <span className="mpc-warming">Warming up — {warmupLeft} ticks left</span>
                      : hasMpc
                      ? <span className="mpc-standby">MPC Standby</span>
                      : <span className="mpc-standby">Thermostat (no artifacts)</span>}
                  </span>
                  <span className="sim-time-label mono">
                    {new Date(latestTick.sim_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {" "}
                    <span className="mode-inline" style={{ color: modeColor }}>
                      {latestTick.mode}{latestTick.mpc_active ? "+" : ""}
                    </span>
                  </span>
                </div>
              </>
            )}
            {simStatus === "error" && (
              <div className="sim-msg error">{errorMsg}</div>
            )}
            {simStatus === "complete" && simComplete && (
              <div className="sim-msg complete">
                ✓ Simulation complete — {simComplete.total_kwh.toFixed(2)} kWh,&nbsp;
                {simComplete.mpc_ticks}/{simComplete.total_ticks} ticks with MPC active
              </div>
            )}
            {simStatus === "stopped" && (
              <div className="sim-msg stopped">Simulation stopped.</div>
            )}
          </div>

          {/*  Main Chart  */}
          <Section className="chart-wrapper-section">
            <div className="cw-header">
              <h3>Control Trajectory</h3>
              <div className="cw-legend">
                <span><span className="line indoor" /> Indoor</span>
                <span><span className="line outdoor" /> Outdoor</span>
                <span><span className="line set" /> Mode Setpoint</span>
                <span><span className="line tstar" /> T* (MPC)</span>
                <span><span className="area energy" /> HVAC kW</span>
              </div>
            </div>
            <div className="cw-body">
              {controlTrajectoryData.length === 0 ? (
                <div className="chart-empty">
                  <span>Run the simulation to see the control trajectory</span>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={controlTrajectoryData} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="hvacFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%"   stopColor="#f59e0b" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis
                      dataKey="label"
                      stroke="rgba(255,255,255,0.3)"
                      style={{ fontSize: 10 }}
                      tickLine={false}
                      minTickGap={30}
                    />
                    <YAxis
                      yAxisId="temp"
                      stroke="rgba(255,255,255,0.3)"
                      style={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      domain={["auto", "auto"]}
                      unit=" °C"
                    />
                    <YAxis
                      yAxisId="power"
                      orientation="right"
                      stroke="rgba(255,255,255,0.3)"
                      style={{ fontSize: 10 }}
                      tickLine={false}
                      axisLine={false}
                      unit=" kW"
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: "#0b0d12", border: "1px solid #333", fontSize: 11 }}
                      formatter={(val: unknown, name: string) => {
                        const n = Number(val);
                        if (name === "indoor_actual") return [`${n.toFixed(1)} °C`, "Indoor Temp"];
                        if (name === "indoor_pred")   return [`${n.toFixed(1)} °C`, "Indoor Forecast"];
                        if (name === "outdoor")  return [`${n.toFixed(1)} °C`, "Outdoor Temp"];
                        if (name === "setpoint") return [`${n.toFixed(1)} °C`, "Mode Setpoint"];
                        if (name === "t_star")   return [`${n.toFixed(1)} °C`, "T* (MPC dynamic)"];
                        if (name === "hvac_kw_actual") return [`${n.toFixed(2)} kW`, "HVAC Power"];
                        if (name === "hvac_kw_plan")   return [`${n.toFixed(2)} kW`, "HVAC Plan"];
                        return [val as string, name];
                      }}
                    />
                    <Area   yAxisId="power" type="linear" dataKey="hvac_kw_actual" fill="url(#hvacFill)" stroke="#f59e0b" strokeWidth={1} dot={false} connectNulls isAnimationActive animationDuration={LIVE_CHART_ANIMATION_MS} animationEasing="linear" />
                    <Line   yAxisId="power" type="linear" dataKey="hvac_kw_plan"   stroke="#fbbf24" strokeWidth={1.5} dot={false} strokeDasharray="4 3" connectNulls isAnimationActive animationDuration={LIVE_CHART_ANIMATION_MS} animationEasing="linear" />
                    <Line   yAxisId="temp"  type="linear" dataKey="outdoor"        stroke="#94a3b8" strokeWidth={1} dot={false} strokeDasharray="4 4" connectNulls isAnimationActive animationDuration={LIVE_CHART_ANIMATION_MS} animationEasing="linear" />
                    <Line   yAxisId="temp"  type="linear" dataKey="setpoint"       stroke="#10b981" strokeWidth={1.5} dot={false} strokeDasharray="5 5" connectNulls isAnimationActive animationDuration={LIVE_CHART_ANIMATION_MS} animationEasing="linear" />
                    <Line   yAxisId="temp"  type="linear" dataKey="t_star"         stroke="#a78bfa" strokeWidth={1.5} dot={false} strokeDasharray="3 3" connectNulls isAnimationActive animationDuration={LIVE_CHART_ANIMATION_MS} animationEasing="linear" />
                    <Line   yAxisId="temp"  type="linear" dataKey="indoor_actual"  stroke="#3b82f6" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} connectNulls isAnimationActive animationDuration={LIVE_CHART_ANIMATION_MS} animationEasing="linear" />
                    <Line   yAxisId="temp"  type="linear" dataKey="indoor_pred"    stroke="#60a5fa" strokeWidth={2} dot={false} strokeDasharray="6 4" connectNulls isAnimationActive animationDuration={LIVE_CHART_ANIMATION_MS} animationEasing="linear" />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          </Section>

          {/*  Signals + QP Diagnostics Row  */}
          <div className="signals-qp-row">

            {/*  Occupancy + Energy Chart  */}
            <Section className="signals-chart-section">
              <div className="cw-header">
                <h3>Occupancy + Energy</h3>
                <div className="cw-legend">
                  <span><span className="line occupancy" /> Occupants</span>
                  <span><span className="area energy" /> HVAC kW</span>
                </div>
              </div>
              <div className="signals-chart-body">
                {chartData.length === 0 ? (
                  <div className="chart-empty"><span>Run simulation to see signals</span></div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={signalChartData} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                      <XAxis dataKey="time" stroke="rgba(255,255,255,0.25)" style={{ fontSize: 9 }} tickLine={false} minTickGap={30} />
                      <YAxis yAxisId="occ" stroke="rgba(255,255,255,0.25)" style={{ fontSize: 9 }} tickLine={false} axisLine={false} unit=" ppl" domain={[0, "auto"]} />
                      <YAxis yAxisId="power" orientation="right" stroke="rgba(255,255,255,0.25)" style={{ fontSize: 9 }} tickLine={false} axisLine={false} unit=" kW" />
                      <Tooltip
                        contentStyle={{ backgroundColor: "#0b0d12", border: "1px solid #333", fontSize: 11 }}
                        formatter={(val: unknown, name: string) => {
                          const n = Number(val);
                          if (name === "n_people") return [`${n}`, "Occupants"];
                          if (name === "hvac_kw") return [`${n.toFixed(2)} kW`, "HVAC Power"];
                          return [val as string, name];
                        }}
                      />
                      <Line yAxisId="occ" type="linear" dataKey="n_people" stroke="#34d399" strokeWidth={2} dot={false} connectNulls isAnimationActive animationDuration={LIVE_CHART_ANIMATION_MS} animationEasing="linear" />
                      <Area yAxisId="power" type="linear" dataKey="hvac_kw" fill="rgba(245, 158, 11, 0.15)" stroke="#f59e0b" strokeWidth={1.5} dot={false} connectNulls isAnimationActive animationDuration={LIVE_CHART_ANIMATION_MS} animationEasing="linear" />
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              </div>
            </Section>

            {/*  QP Diagnostics Panel  */}
            <Section className="qp-diag-section">
              <div className="cw-header">
                <h3>QP Diagnostics</h3>
                {latestTick?.qp_solver === "proportional_fallback" && (
                  <span className="status-chip warming">fallback</span>
                )}
                {latestTick?.qp_converged != null && (
                  <span className={`status-chip ${latestTick.qp_converged ? "active" : "warming"}`}>
                    {latestTick.qp_converged ? "✓ Converged" : "⚠ Not converged"}
                  </span>
                )}
              </div>
              <div className="qp-diag-body">
                {!latestTick || !latestTick.mpc_active || latestTick.qp_converged == null ? (
                  <div className="qp-idle-msg">
                    {!latestTick
                      ? "Waiting for simulation…"
                      : !hasMpc
                      ? "No MPC artifacts loaded — train models to see QP diagnostics"
                      : latestTick.warming_up
                      ? `Warming up: ${latestTick.tick + 1} / ${warmRows} ticks (${Math.round((latestTick.tick + 1) / warmRows * 100)}%)`
                      : !latestTick.mpc_active
                      ? latestTick.error
                        ? `MPC error: ${latestTick.error}`
                        : "MPC standby"
                      : latestTick.qp_error
                      ? `QP fallback — ${latestTick.qp_error}`
                      : latestTick.qp_solver === "proportional_fallback"
                      ? "QP not active (proportional fallback)"
                      : "QP not active"}
                  </div>
                ) : (
                  <>
                    {/* Solver info */}
                    <div className="qp-meta-row">
                      <span className="qp-meta-label">Solver</span>
                      <span className="qp-meta-val mono">SLSQP · {latestTick.qp_iter ?? 0} iter</span>
                    </div>
                    {!latestTick.qp_converged && (
                      <div className="qp-meta-row">
                        <span className="qp-meta-label">Note</span>
                        <span className="qp-meta-val" style={{ color: "#fbbf24" }}>
                          Best-effort result applied — constraint tolerance not fully met
                        </span>
                      </div>
                    )}
                    {/* Active weights echoed from backend — confirms tuning is live */}
                    {latestTick.applied_w_comfort != null && (
                      <div className="qp-meta-row">
                        <span className="qp-meta-label">Active weights</span>
                        <span className="qp-meta-val mono" style={{ fontSize: "0.7rem", color: "#94a3b8" }}>
                          C={latestTick.applied_w_comfort?.toFixed(0)}
                          {" · "}E={latestTick.applied_w_energy?.toExponential(1)}
                          {" · "}S={latestTick.applied_w_smooth?.toExponential(1)}
                          {" · "}Qt={latestTick.applied_q_terminal?.toFixed(1)}
                        </span>
                      </div>
                    )}

                    {/* T* — occupancy-driven dynamic setpoint */}
                    <div className="qp-signal-block">
                      <div className="qp-signal-header">
                        <span className="qp-sig-name">T* Setpoint</span>
                        <span className="qp-sig-val" style={{ color: "#a78bfa" }}>
                          {latestTick.t_star_now != null ? `${latestTick.t_star_now.toFixed(1)} °C` : "--"}
                        </span>
                      </div>
                      <div className="qp-sig-desc">
                        Occupancy-aware: economy → ramp → comfort (90 min pre-heat before arrival)
                      </div>
                      <div className="qp-bar-track">
                        <div className="qp-bar-fill" style={{
                          width: `${Math.max(0, Math.min(100, ((latestTick.t_star_now ?? 17) - 15) / (23 - 15) * 100))}%`,
                          background: "#a78bfa"
                        }} />
                      </div>
                      <div className="qp-bar-labels"><span>15°C</span><span>23°C</span></div>
                    </div>

                    {/* Comfort weight Q_T */}
                    <div className="qp-signal-block">
                      <div className="qp-signal-header">
                        <span className="qp-sig-name">Comfort Weight (W_comfort · Q_T)</span>
                        <span className="qp-sig-val" style={{ color: "#34d399" }}>
                          {latestTick.q_t_now != null
                            ? `${((latestTick.applied_w_comfort ?? 200) * latestTick.q_t_now).toFixed(0)}`
                            : "--"}
                        </span>
                      </div>
                      <div className="qp-sig-desc">Q_T scales 0.25× (empty) → 1.8× (full) with occupancy forecast</div>
                      <div className="qp-bar-track">
                        <div className="qp-bar-fill" style={{
                          width: `${Math.max(0, Math.min(100, ((latestTick.q_t_now ?? 0.25) - 0.25) / (1.8 - 0.25) * 100))}%`,
                          background: "#34d399"
                        }} />
                      </div>
                      <div className="qp-bar-labels">
                        <span>{((latestTick.applied_w_comfort ?? 200) * 0.25).toFixed(0)} (empty)</span>
                        <span>{((latestTick.applied_w_comfort ?? 200) * 1.8).toFixed(0)} (full)</span>
                      </div>
                    </div>

                    {/* Energy budget */}
                    {latestTick.e_budget_wh != null && (
                      <div className="qp-meta-row" style={{ marginTop: 8 }}>
                        <span className="qp-meta-label">Horizon Budget</span>
                        <span className="qp-meta-val mono">{latestTick.e_budget_wh.toFixed(0)} Wh</span>
                      </div>
                    )}
                    {latestTick.u_max_w != null && (
                      <div className="qp-meta-row">
                        <span className="qp-meta-label">HVAC Cap</span>
                        <span className="qp-meta-val mono">{Math.round(latestTick.u_max_w)} W</span>
                      </div>
                    )}

                    {/* Comfort trajectory preview */}
                    {comfortTrajectory.length > 0 && (
                      <div className="qp-signal-block" style={{ marginTop: 8 }}>
                        <div className="qp-signal-header">
                          <span className="qp-sig-name">Comfort Trajectory</span>
                          <span className="qp-sig-val" style={{ color: "#a78bfa" }}>
                            {comfortTrajectory[0]?.predicted != null && comfortTrajectory[0]?.target != null
                              ? `${comfortTrajectory[0].predicted.toFixed(1)} / ${comfortTrajectory[0].target.toFixed(1)} °C`
                              : "--"}
                          </span>
                        </div>
                        <div className="qp-sig-desc">
                          Predicted indoor temperature against the occupancy-aware comfort target.
                        </div>
                        <div className="qp-mini-chart">
                          <ResponsiveContainer width="100%" height="100%">
                            <ComposedChart data={comfortTrajectory} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                              <XAxis
                                dataKey="label"
                                stroke="rgba(255,255,255,0.25)"
                                style={{ fontSize: 8 }}
                                tickLine={false}
                                axisLine={false}
                              />
                              <YAxis
                                stroke="rgba(255,255,255,0.25)"
                                style={{ fontSize: 8 }}
                                tickLine={false}
                                axisLine={false}
                                domain={["dataMin - 0.5", "dataMax + 0.5"]}
                                unit="°C"
                              />
                              <Tooltip
                                contentStyle={{ backgroundColor: "#0b0d12", border: "1px solid #333", fontSize: 11 }}
                                formatter={(val: unknown, name: string) => {
                                  const n = Number(val);
                                  if (name === "predicted") return [`${n.toFixed(1)} °C`, "Predicted"];
                                  if (name === "target") return [`${n.toFixed(1)} °C`, "Target"];
                                  return [val as string, name];
                                }}
                              />
                              <Line
                                type="monotone"
                                dataKey="target"
                                stroke="#a78bfa"
                                strokeWidth={1.5}
                                dot={false}
                                strokeDasharray="3 3"
                                connectNulls
                              />
                              <Line
                                type="monotone"
                                dataKey="predicted"
                                stroke="#60a5fa"
                                strokeWidth={2}
                                dot={false}
                                activeDot={{ r: 4 }}
                                connectNulls
                              />
                            </ComposedChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )}

                    {/* QP plan preview: heating sparkline */}
                    {latestTick.u_sequence_w && latestTick.u_sequence_w.length > 0 && (
                      <div className="qp-signal-block" style={{ marginTop: 8 }}>
                        <div className="qp-signal-header">
                          <span className="qp-sig-name">Planned Heating</span>
                        </div>
                        <div className="qp-sparkline">
                          {latestTick.u_sequence_w.map((u, i) => (
                            <div key={i} className="qp-spark-bar-wrap">
                              <div
                                className="qp-spark-bar"
                                style={{
                                  height: `${Math.max(4, (u / 2500) * 100)}%`,
                                  background: i === 0 ? "#f59e0b" : "#3b82f6",
                                  opacity: Math.max(0.22, 1 - i * 0.05),
                                }}
                                title={`Step +${i + 1}: ${Math.round(u)} W`}
                              />
                              <div className="qp-spark-label">{i === 0 ? "now" : `+${i * 15}m`}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* QP plan preview: ventilation sparkline */}
                    {latestTick.v_sequence && latestTick.v_sequence.length > 0 && (
                      <div className="qp-signal-block" style={{ marginTop: 8 }}>
                        <div className="qp-signal-header">
                          <span className="qp-sig-name">Planned Ventilation</span>
                        </div>
                        <div className="qp-sparkline">
                          {latestTick.v_sequence.map((v, i) => (
                            <div key={i} className="qp-spark-bar-wrap">
                              <div
                                className="qp-spark-bar"
                                style={{
                                  height: `${Math.max(4, (v / 40) * 100)}%`,
                                  background: i === 0 ? "#10b981" : "#60a5fa",
                                  opacity: Math.max(0.22, 1 - i * 0.05),
                                }}
                                title={`Step +${i + 1}: ${v.toFixed(1)}%`}
                              />
                              <div className="qp-spark-label">{i === 0 ? "now" : `+${i * 15}m`}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </Section>

          </div>
        </ContentArea>
      </MainContent>
    </div>
  );
};

export default ControllerTab;
