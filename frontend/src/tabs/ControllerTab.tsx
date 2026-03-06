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
interface FeatureArtifact {
  st: Record<string, FeatureHorizonMeta>;
  lt: Record<string, FeatureHorizonMeta>;
}
type ArtifactsMap = Record<string, FeatureArtifact>;

const FEATURE_DEFS = [
  { key: "energy",      label: "Energy",      unit: "kW"  },
  { key: "temperature", label: "Temperature", unit: "°C"  },
  { key: "occupancy",   label: "Occupancy",   unit: "ppl" },
  { key: "airquality",  label: "Air Quality", unit: "ppm" },
] as const;

interface SimConfig {
  setpoint:      number;
  nightSetpoint: number;
  nOccupants:    number;
  ticks:         number;
  initTemp:      number;
  speed:         number;
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
  co2:                number;
  humidity:           number;
  n_people:           number;
  hvac_w:             number;
  cumulative_kwh:     number;
  forecast_energy_st1: number | null;
  energy_budget_lt:   Record<string, number> | null;
  temp_ref_lt:        Record<string, number> | null;
  error:              string | null;
}

interface SimComplete {
  type:           "complete";
  final_temp:     number;
  final_co2:      number;
  final_humidity: number;
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

//  Component 

const ControllerTab: React.FC = () => {
  // Simulation config (editable before / between runs)
  const [simConfig, setSimConfig] = useState<SimConfig>({
    setpoint:      22.0,
    nightSetpoint: 15.0,
    nOccupants:    10,
    ticks:         96,
    initTemp:      14.0,
    speed:         0.05,
  });

  // Live simulation state
  const [simStatus,   setSimStatus]   = useState<SimStatus>("idle");
  const [latestTick,  setLatestTick]  = useState<SimTick | null>(null);
  const [chartData,   setChartData]   = useState<ChartPoint[]>([]);
  const [simComplete, setSimComplete] = useState<SimComplete | null>(null);
  const [hasMpc,      setHasMpc]      = useState(false);
  const [errorMsg,    setErrorMsg]    = useState<string | null>(null);

  // Model selector
  const [modelArtifacts, setModelArtifacts] = useState<ArtifactsMap>({});
  const [activeFeatures, setActiveFeatures] = useState<Set<string>>(
    new Set(FEATURE_DEFS.map(f => f.key))
  );

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
          activeFeatures: [...activeFeatures],
        },
      }));
    };

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data as string);

      if (msg.type === "started") {
        setHasMpc(msg.has_mpc as boolean);

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
            ...prev.slice(-119),
            {
              time:     label,
              indoor:   t.indoor_temp,
              outdoor:  t.outdoor_temp,
              setpoint: t.setpoint,
              hvac_kw:  +(t.hvac_w / 1000).toFixed(3),
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
  }, [simConfig, activeFeatures]);

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
  const warmupLeft  = latestTick?.warming_up ? Math.max(0, 70 - (latestTick.tick + 1)) : 0;
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
                  { label: "Work Setpoint", key: "setpoint",      min: 18, max: 26, step: 0.5, fmt: (v: number) => `${v.toFixed(1)} °C` },
                  { label: "Night Setpoint",key: "nightSetpoint", min: 10, max: 20, step: 0.5, fmt: (v: number) => `${v.toFixed(1)} °C` },
                  { label: "Occupants",     key: "nOccupants",    min: 1,  max: 100, step: 1,  fmt: (v: number) => `${v}` },
                  { label: "Duration",      key: "ticks",         min: 24, max: 192, step: 24, fmt: (v: number) => `${v * 15 / 60} h` },
                  { label: "Init. Temp",    key: "initTemp",      min: 8,  max: 24,  step: 1,  fmt: (v: number) => `${v} °C` },
                  { label: "Speed",         key: "speed",         min: 0,  max: 1.0, step: 0.05,fmt: (v: number) => v === 0 ? "Max" : `${v}s` },
                ] as Array<{ label: string; key: keyof SimConfig; min: number; max: number; step: number; fmt: (v: number) => string }>
              ).map(({ label, key, min, max, step, fmt }) => (
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
                </div>
              ))}
            </SidebarSection>

            {/*  Optimization Objectives  */}
            <SidebarSection title="Optimization Objectives">
              <div className="weight-control">
                <div className="wc-labels">
                  <span>Comfort Priority</span>
                  <span>Energy Savings</span>
                </div>
                <input
                  type="range" min={0} max={1} step={0.1}
                  value={comfortWeight}
                  onChange={e => setComfortWeight(parseFloat(e.target.value))}
                  className="balance-slider"
                />
                <div className="wc-values">
                  <span className="c-val">{(comfortWeight * 100).toFixed(0)}%</span>
                  <span className="e-val">{((1 - comfortWeight) * 100).toFixed(0)}%</span>
                </div>
              </div>
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
                  const rawModel = stH1?.model ?? null;
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

                  return (
                    <div
                      key={key}
                      className={`model-feature-card ${isActive ? "on" : "off"} ${!hasModel ? "no-model" : ""} ${isLast ? "last" : ""}`}
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
              <div className="kpi-label">CO₂ Level</div>
              <div className="kpi-val">
                {latestTick ? Math.round(latestTick.co2) : "--"}
                <span className="unit">ppm</span>
              </div>
              {latestTick && (
                <div className={`kpi-trend ${latestTick.co2 > 2000 ? "down" : latestTick.co2 > 1000 ? "flat" : "up"}`}>
                  {latestTick.co2 > 2000 ? "High" : latestTick.co2 > 1000 ? "Moderate" : "Good"}
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
                <span><span className="line temp" /> Indoor Temp</span>
                <span><span className="line outdoor" /> Outdoor</span>
                <span><span className="line set" /> Setpoint</span>
                <span><span className="area energy" /> HVAC kW</span>
              </div>
            </div>
            <div className="cw-body">
              {chartData.length === 0 ? (
                <div className="chart-empty">
                  <span>Run the simulation to see the control trajectory</span>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="hvacFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%"   stopColor="#f59e0b" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis
                      dataKey="time"
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
                        if (name === "indoor")   return [`${n.toFixed(1)} °C`, "Indoor Temp"];
                        if (name === "outdoor")  return [`${n.toFixed(1)} °C`, "Outdoor Temp"];
                        if (name === "setpoint") return [`${n.toFixed(1)} °C`, "Setpoint"];
                        if (name === "hvac_kw")  return [`${n.toFixed(2)} kW`, "HVAC Power"];
                        return [val as string, name];
                      }}
                    />
                    <Area   yAxisId="power" type="monotone" dataKey="hvac_kw"  fill="url(#hvacFill)" stroke="#f59e0b" strokeWidth={1} dot={false} />
                    <Line   yAxisId="temp"  type="monotone" dataKey="outdoor"  stroke="#94a3b8" strokeWidth={1} dot={false} strokeDasharray="4 4" />
                    <Line   yAxisId="temp"  type="monotone" dataKey="setpoint" stroke="#10b981" strokeWidth={1.5} dot={false} strokeDasharray="5 5" />
                    <Line   yAxisId="temp"  type="monotone" dataKey="indoor"   stroke="#3b82f6" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          </Section>

          {/*  Scenarios / Summary  */}
          {simStatus === "complete" && simComplete ? (
            <div className="sim-summary-grid">
              <div className="summary-card">
                <div className="sc-header">Final State</div>
                <div className="sc-stat"><span>Indoor Temp</span><strong>{simComplete.final_temp.toFixed(1)} °C</strong></div>
                <div className="sc-stat"><span>CO₂</span><strong>{simComplete.final_co2} ppm</strong></div>
                <div className="sc-stat"><span>Humidity</span><strong>{simComplete.final_humidity.toFixed(1)} %RH</strong></div>
              </div>
              <div className="summary-card">
                <div className="sc-header">Energy</div>
                <div className="sc-stat"><span>Total</span><strong>{simComplete.total_kwh.toFixed(2)} kWh</strong></div>
                <div className="sc-stat">
                  <span>Avg Power</span>
                  <strong>{(simComplete.total_kwh / (simComplete.total_ticks * 0.25)).toFixed(2)} kW</strong>
                </div>
              </div>
              <div className="summary-card">
                <div className="sc-header">MPC Performance</div>
                <div className="sc-stat">
                  <span>Active Ticks</span>
                  <strong>{simComplete.mpc_ticks} / {simComplete.total_ticks}</strong>
                </div>
                <div className="sc-stat">
                  <span>Coverage</span>
                  <strong className={simComplete.mpc_ticks > 0 ? "good" : "warn"}>
                    {Math.round(simComplete.mpc_ticks / simComplete.total_ticks * 100)}%
                  </strong>
                </div>
                <button className="btn btn-secondary btn-sm full-width mt-sm" onClick={startSimulation}>
                  Run Again
                </button>
              </div>
            </div>
          ) : (
            <div className="scenario-grid">
              <div className="scenario-card active">
                <div className="sc-header">Current Config</div>
                <div className="sc-stat"><span>Work Setpoint</span><strong>{simConfig.setpoint.toFixed(1)} °C</strong></div>
                <div className="sc-stat"><span>Occupants</span><strong>{simConfig.nOccupants}</strong></div>
                <div className="sc-stat"><span>Duration</span><strong>{simConfig.ticks * 15 / 60} h</strong></div>
              </div>
              <div className="scenario-card alt">
                <div className="sc-header">Energy Saver</div>
                <div className="sc-stat"><span>Setpoint</span><strong className="warn">{(simConfig.setpoint - 1).toFixed(1)} °C</strong></div>
                <div className="sc-stat"><span>Est. Savings</span><strong className="good">~15%</strong></div>
                <button
                  className="btn btn-secondary btn-sm full-width mt-sm"
                  onClick={() => setSimConfig(c => ({ ...c, setpoint: +(c.setpoint - 1).toFixed(1) }))}
                  disabled={isRunning}
                >
                  Apply
                </button>
              </div>
              <div className="scenario-card alt">
                <div className="sc-header">Max Comfort</div>
                <div className="sc-stat"><span>Setpoint</span><strong className="good">{(simConfig.setpoint + 1).toFixed(1)} °C</strong></div>
                <div className="sc-stat"><span>Est. Cost</span><strong className="warn">+12%</strong></div>
                <button
                  className="btn btn-secondary btn-sm full-width mt-sm"
                  onClick={() => setSimConfig(c => ({ ...c, setpoint: +(c.setpoint + 1).toFixed(1) }))}
                  disabled={isRunning}
                >
                  Apply
                </button>
              </div>
            </div>
          )}

        </ContentArea>
      </MainContent>
    </div>
  );
};

export default ControllerTab;
