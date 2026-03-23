import React, { useState, useEffect, useRef, useCallback, ReactNode } from "react";
import {
  AreaChart, Area, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine, ScatterChart, Scatter,
} from "recharts";
import "./ForecastTab.scss";
import Topbar from "./components/Topbar";
import RightSidebar, { SidebarSection } from "./components/RightSidebar";
import MainContent, { ContentArea, Section } from "./components/MainContent";
import {
  TemperatureIcon,
  EnergyIcon,
  OccupancyIcon,
  AirQualityIcon,
} from "./components/Icons";

// ─── Types ────────────────────────────────────────────────────────────────────

interface HorizonMeta {
  model:    string | null;
  mae:      number | null;
  rmse:     number | null;
  r2:       number | null;
  mase:     number | null;
  n_rows:   number | null;
  quantile?: { coverage: number | null; sharpness: number | null };
}

interface ModelRow {
  model:    string;
  horizon:  number | null;
  mae:      number | null;
  rmse:     number | null;
  r2:       number | null;
  mase:     number | null;
  n_folds:  number | null;
  level:    string;
}

interface MultiOutputSummary {
  base_model:       string;
  per_horizon_mae:  Record<string, { mae: number }>;
}

interface FeatureArtifact {
  st:             Record<string, HorizonMeta>;
  lt:             Record<string, HorizonMeta>;
  all_models_st:  ModelRow[];
  all_models_lt:  ModelRow[];
  multioutput:    { st?: MultiOutputSummary; lt?: MultiOutputSummary };
  n_rows:         number | null;
}

type ArtifactsPayload = Record<string, FeatureArtifact>;

interface ProcessModel {
  id:            string;
  featureKey:    string;
  name:          string;
  featureLabel:  ReactNode;
  status:        "active" | "drift-detected" | "optimized" | "training";
  statusMsg:     string;
  // filled from artifacts
  bestModelType: string;
  r2:            number;
  mae:           number;
  rmse:          number;
  mase:          number | null;
  nRows:         number | null;
  stHorizons:    number;
  ltHorizons:    number;
  hasQuantile:   boolean;
  coverage:      number | null;
  trainingState?: { isTraining: boolean };
}

interface TrainingProgress {
  featuresTotal:   string[];
  featuresDone:    string[];
  currentFeature:  string | null;
  currentLevel:    "st" | "lt" | null;
  currentModel:    string | null;
  currentHorizon:  number | null;
  currentStep:     "model" | "quantile" | "multioutput" | null;
  recentModels:    Array<{ model: string; horizon: number; level: string }>;
}

const defaultProgress = (): TrainingProgress => ({
  featuresTotal: [], featuresDone: [],
  currentFeature: null, currentLevel: null,
  currentModel: null, currentHorizon: null,
  currentStep: null, recentModels: [],
});

// ─── Static config ────────────────────────────────────────────────────────────

const FEATURE_CONFIG: Omit<ProcessModel, "status"|"statusMsg"|"bestModelType"|"r2"|"mae"|"rmse"|"mase"|"nRows"|"stHorizons"|"ltHorizons"|"hasQuantile"|"coverage">[] = [
  { id: "temp-model",   featureKey: "temperature", name: "Indoor Temperature", featureLabel: <TemperatureIcon className="feature-icon" />   },
  { id: "energy-model", featureKey: "energy",      name: "Energy Load",        featureLabel: <EnergyIcon className="feature-icon" />          },
  { id: "occ-model",    featureKey: "occupancy",   name: "Occupancy Flow",     featureLabel: <OccupancyIcon className="feature-icon" />     },
  { id: "airq-model",   featureKey: "airquality",  name: "Air Quality (CO2)",  featureLabel: <AirQualityIcon className="feature-icon" />  },
];

function makeDefaultModel(cfg: typeof FEATURE_CONFIG[0]): ProcessModel {
  return {
    ...cfg,
    status: "active",
    statusMsg: "No artifacts yet",
    bestModelType: "—",
    r2: 0, mae: 0, rmse: 0, mase: null,
    nRows: null, stHorizons: 0, ltHorizons: 0,
    hasQuantile: false, coverage: null,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (v: number | null, d = 3) =>
  v == null ? "—" : v.toFixed(d);

const maseBadgeClass = (mase: number | null) => {
  if (mase == null) return "mase-unknown";
  if (mase < 0.9)  return "mase-good";
  if (mase < 1.2)  return "mase-ok";
  return "mase-bad";
};

const maseLabel = (mase: number | null) => {
  if (mase == null) return "—";
  if (mase < 0.9)  return `${mase.toFixed(2)} ▼`;
  if (mase < 1.2)  return `${mase.toFixed(2)} ~`;
  return `${mase.toFixed(2)} ▲`;
};

// Build horizon-RMSE line-chart data from artifact horizons
function buildHorizonProfile(
  horizons: Record<string, HorizonMeta>,
  level: "st" | "lt",
): { h: number; rmse: number | null; mae: number | null; mase: number | null }[] {
  return Object.entries(horizons)
    .map(([h, meta]) => ({
      h: parseInt(h, 10),
      rmse: meta.rmse,
      mae:  meta.mae,
      mase: meta.mase,
    }))
    .sort((a, b) => a.h - b.h);
}

// ─── Component ────────────────────────────────────────────────────────────────

const ForecastTab: React.FC = () => {
  const [processModels, setProcessModels]     = useState<ProcessModel[]>(
    FEATURE_CONFIG.map(makeDefaultModel)
  );
  const [artifacts, setArtifacts]             = useState<ArtifactsPayload>({});
  const [activeModelId, setActiveModelId]     = useState<string>("temp-model");
  const [trainingLog, setTrainingLog]         = useState<string[]>([]);
  const [globalTraining, setGlobalTraining]   = useState(false);
  const [inspectingKey, setInspectingKey]     = useState<string | null>(null);
  const [inspectLevel, setInspectLevel]       = useState<"st"|"lt">("st");
  const [inspectTab, setInspectTab]           = useState<"profile"|"table">("profile");
  const [showIngestModal, setShowIngestModal] = useState(false);
  const [ingestProgress, setIngestProgress]   = useState(0);
  const [trainingProgress, setTrainingProgress] = useState<TrainingProgress>(defaultProgress());
  const [trainingMode, setTrainingMode]         = useState<"fast"|"normal"|"full">("normal");

  const wsRef     = useRef<WebSocket | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [trainingLog]);

  // ── Fetch artifact data ──────────────────────────────────────────────────────
  const applyArtifacts = useCallback(async () => {
    try {
      const res = await fetch("http://localhost:8000/api/artifacts/status");
      if (!res.ok) return;
      const data: ArtifactsPayload = await res.json();
      setArtifacts(data);

      setProcessModels(prev => prev.map(m => {
        const fa = data[m.featureKey];
        if (!fa) return m;

        const stKeys = Object.keys(fa.st);
        const ltKeys = Object.keys(fa.lt);

        // Representative metric: ST h1 (or first available)
        const repKey  = stKeys.includes("1") ? "1" : stKeys[0];
        const repMeta = repKey ? fa.st[repKey] : null;

        const r2Pct = repMeta?.r2 != null ? Math.max(0, repMeta.r2 * 100) : m.r2;

        // Best MASE across ST horizons (lowest = best)
        const allMases = stKeys.map(k => fa.st[k].mase).filter((v): v is number => v != null);
        const bestMase = allMases.length ? Math.min(...allMases) : null;

        // Quantile coverage from h1 if available
        const coverage = repMeta?.quantile?.coverage ?? null;
        const hasQ     = stKeys.some(k => fa.st[k].quantile != null);

        // Drift detection: MASE > 1.2 on any horizon is a signal
        const hasDrift = allMases.some(v => v > 1.2);

        return {
          ...m,
          bestModelType: (repMeta?.model ?? m.bestModelType).toUpperCase(),
          r2:          parseFloat(r2Pct.toFixed(1)),
          mae:         repMeta?.mae  ?? m.mae,
          rmse:        repMeta?.rmse ?? m.rmse,
          mase:        bestMase,
          nRows:       fa.n_rows,
          stHorizons:  stKeys.length,
          ltHorizons:  ltKeys.length,
          hasQuantile: hasQ,
          coverage,
          status:      hasDrift ? "drift-detected" : "active",
          statusMsg:   hasDrift
            ? `MASE > 1.2 on some horizons — check model`
            : `${stKeys.length} ST + ${ltKeys.length} LT horizons`,
          lastTrained: "recently",
        } as ProcessModel;
      }));
    } catch { /* backend not running */ }
  }, []);

  useEffect(() => { applyArtifacts(); }, [applyArtifacts]);

  // ── WebSocket training ───────────────────────────────────────────────────────
  const handleRetrain = useCallback((modelId: string) => {
    const cfg = FEATURE_CONFIG.find(m => m.id === modelId);
    if (!cfg) return;
    setProcessModels(prev =>
      prev.map(m => m.id === modelId
        ? { ...m, status: "training", trainingState: { isTraining: true } } : m)
    );
    setTrainingLog(prev => [...prev, `--- Retraining: ${cfg.featureKey} ---`]);

    const ws = new WebSocket("ws://localhost:8000/training/ws");
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({
      type: "start", mode: trainingMode, features: [cfg.featureKey], table: "matches",
    }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "started") {
        setTrainingProgress({ ...defaultProgress(), featuresTotal: msg.features || [cfg.featureKey] });
      }
      if (msg.type === "log") {
        if (msg.line) setTrainingLog(prev => [...prev.slice(-150), msg.line]);
        setTrainingProgress(p => {
          let n = { ...p };
          if (msg.feature_start) n = { ...n, currentFeature: msg.feature_start, currentLevel: null, currentModel: null, currentHorizon: null, currentStep: null, recentModels: [] };
          if (msg.feature_done)  n = { ...n, featuresDone: [...p.featuresDone, msg.feature_done] };
          if (msg.current_level) n = { ...n, currentLevel: msg.current_level as "st"|"lt", currentStep: "model", currentModel: null, currentHorizon: null, recentModels: [] };
          if (msg.current_model) {
            const prev = p.currentModel ? [{ model: p.currentModel, horizon: p.currentHorizon ?? 0, level: p.currentLevel || "st" }] : [];
            n = { ...n, currentModel: msg.current_model, currentHorizon: msg.current_horizon, currentStep: "model", recentModels: [...prev, ...p.recentModels].slice(0, 5) };
          }
          if (msg.current_step === "quantile")    n = { ...n, currentStep: "quantile", currentModel: null };
          if (msg.current_step === "multioutput") n = { ...n, currentStep: "multioutput", currentModel: null };
          return n;
        });
      }
      if (["complete","stopped","error"].includes(msg.type)) {
        const ok = msg.type === "complete" && msg.success;
        setProcessModels(prev =>
          prev.map(m => m.id === modelId
            ? { ...m, status: "active", trainingState: undefined,
                statusMsg: ok ? "Retrained successfully" : "Training failed" } : m)
        );
        setTrainingLog(prev => [...prev,
          msg.type === "complete"
            ? (ok ? `[OK] ${cfg.featureKey} complete.` : `[FAIL] code ${msg.returncode}`)
            : msg.type === "stopped" ? `[--] Stopped.` : `[ERR] ${msg.message || "unknown"}`
        ]);
        setTrainingProgress(defaultProgress());
        if (ok) applyArtifacts();
      }
    };
    ws.onerror = () => {
      setProcessModels(prev =>
        prev.map(m => m.id === modelId ? { ...m, status: "active", trainingState: undefined } : m)
      );
      setTrainingLog(prev => [...prev, "[ERR] WebSocket error — is backend running?"]);
      setTrainingProgress(defaultProgress());
    };
  }, [applyArtifacts, trainingMode]);

  const stopRetrain = useCallback((modelId: string) => {
    wsRef.current?.readyState === WebSocket.OPEN &&
      wsRef.current.send(JSON.stringify({ type: "stop" }));
    setProcessModels(prev =>
      prev.map(m => m.id === modelId ? { ...m, status: "active", trainingState: undefined } : m)
    );
    setTrainingProgress(defaultProgress());
  }, []);

  const handleTrainAll = useCallback(() => {
    if (globalTraining) return;
    setGlobalTraining(true);
    setProcessModels(prev =>
      prev.map(m => ({ ...m, status: "training", trainingState: { isTraining: true } }))
    );
    setTrainingLog(prev => [...prev, "--- Train All (fast mode) ---"]);

    const ws = new WebSocket("ws://localhost:8000/training/ws");
    wsRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({
      type: "start", mode: trainingMode,
      features: FEATURE_CONFIG.map(m => m.featureKey), table: "matches",
    }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "started") {
        setTrainingProgress({ ...defaultProgress(), featuresTotal: msg.features || FEATURE_CONFIG.map(m => m.featureKey) });
      }
      if (msg.type === "log") {
        if (msg.line) setTrainingLog(prev => [...prev.slice(-150), msg.line]);
        setTrainingProgress(p => {
          let n = { ...p };
          if (msg.feature_start) n = { ...n, currentFeature: msg.feature_start, currentLevel: null, currentModel: null, currentHorizon: null, currentStep: null, recentModels: [] };
          if (msg.feature_done) {
            n = { ...n, featuresDone: [...p.featuresDone, msg.feature_done] };
            const done = FEATURE_CONFIG.find(m => m.featureKey === msg.feature_done);
            if (done) setProcessModels(prev =>
              prev.map(m => m.id === done.id
                ? { ...m, status: "active", statusMsg: "Retrained successfully", trainingState: undefined }
                : m)
            );
          }
          if (msg.current_level) n = { ...n, currentLevel: msg.current_level as "st"|"lt", currentStep: "model", currentModel: null, currentHorizon: null, recentModels: [] };
          if (msg.current_model) {
            const prev = p.currentModel ? [{ model: p.currentModel, horizon: p.currentHorizon ?? 0, level: p.currentLevel || "st" }] : [];
            n = { ...n, currentModel: msg.current_model, currentHorizon: msg.current_horizon, currentStep: "model", recentModels: [...prev, ...p.recentModels].slice(0, 5) };
          }
          if (msg.current_step === "quantile")    n = { ...n, currentStep: "quantile", currentModel: null };
          if (msg.current_step === "multioutput") n = { ...n, currentStep: "multioutput", currentModel: null };
          return n;
        });
      }
      if (["complete","stopped","error"].includes(msg.type)) {
        setGlobalTraining(false);
        setProcessModels(prev =>
          prev.map(m => m.status === "training"
            ? { ...m, status: "active", trainingState: undefined,
                statusMsg: msg.type === "complete" && msg.success ? "Retrained" : "Training ended" }
            : m)
        );
        const ok = msg.type === "complete" && msg.success;
        setTrainingLog(prev => [...prev,
          ok ? "[OK] All features trained." :
          msg.type === "stopped" ? "[--] Stopped." : `[ERR] ${msg.message || "unknown"}`
        ]);
        setTrainingProgress(defaultProgress());
        if (ok) applyArtifacts();
      }
    };
    ws.onerror = () => {
      setGlobalTraining(false);
      setProcessModels(prev =>
        prev.map(m => m.status === "training" ? { ...m, status: "active", trainingState: undefined } : m)
      );
      setTrainingLog(prev => [...prev, "[ERR] WebSocket error — is backend running?"]);
      setTrainingProgress(defaultProgress());
    };
  }, [globalTraining, applyArtifacts, trainingMode]);

  const stopAll = useCallback(() => {
    wsRef.current?.readyState === WebSocket.OPEN &&
      wsRef.current.send(JSON.stringify({ type: "stop" }));
    setTrainingProgress(defaultProgress());
  }, []);

  // ── Derived ──────────────────────────────────────────────────────────────────
  const activeModel  = processModels.find(m => m.id === activeModelId)!;
  const inspectFeat  = inspectingKey ? artifacts[inspectingKey] : null;
  const inspectModel = processModels.find(m => m.featureKey === inspectingKey);

  // Horizon profile for the main chart — active model, both levels stacked
  const stProfile = activeModel && artifacts[activeModel.featureKey]
    ? buildHorizonProfile(artifacts[activeModel.featureKey].st, "st")
    : [];
  const ltProfile = activeModel && artifacts[activeModel.featureKey]
    ? buildHorizonProfile(artifacts[activeModel.featureKey].lt, "lt")
    : [];

  // Sidebar: all-model comparison for active feature at h1 ST
  const activeArtifact = artifacts[activeModel?.featureKey ?? ""];
  const sidebarRows = activeArtifact?.all_models_st
    .filter(r => r.horizon === 1)
    .sort((a, b) => (a.rmse ?? 999) - (b.rmse ?? 999))
    ?? [];

  // Ingest mock
  const startIngestion = () => {
    setIngestProgress(0);
    const t = setInterval(() => setIngestProgress(p => {
      if (p >= 100) { clearInterval(t); setTimeout(() => setShowIngestModal(false), 500); return 100; }
      return p + 10;
    }), 200);
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="forecast-container">
      <Topbar
        variant="forecast"
        title="Forecast"
        subtitle="Model Training & Evaluation"
        rightContent={
          <div className="topbar-action-group">
            {/* Mode selector */}
            <div className="mode-selector">
              {(["fast","normal","full"] as const).map(m => (
                <button
                  key={m}
                  className={`mode-btn mode-${m} ${trainingMode === m ? "active" : ""}`}
                  disabled={globalTraining || processModels.some(p => p.status === "training")}
                  onClick={() => setTrainingMode(m)}
                  title={
                    m === "fast"   ? "600 rows · ridge/hgb/rf · ST h1,3,6 + LT h1,3  (~2 min)" :
                    m === "normal" ? "5 000 rows · +ann/gp · ST h1-8 + LT h1-6  (~15 min)" :
                                     "All data · all 9 models · all horizons  (hours)"
                  }
                >{m}</button>
              ))}
            </div>
            <div className="mode-hint">
              {trainingMode === "fast"   && "600 rows · 3 models"}
              {trainingMode === "normal" && "5 000 rows · 5 models"}
              {trainingMode === "full"   && "all data · 9 models"}
            </div>
            {globalTraining && (
              <>
                <div className="train-all-progress">
                  <span className="tap-label">
                    {trainingProgress.featuresDone.length}/{trainingProgress.featuresTotal.length || FEATURE_CONFIG.length}
                  </span>
                  <div className="tap-bar">
                    <div className="tap-fill" style={{
                      width: `${trainingProgress.featuresTotal.length > 0
                        ? (trainingProgress.featuresDone.length / trainingProgress.featuresTotal.length) * 100
                        : 0}%`
                    }} />
                  </div>
                  {trainingProgress.currentFeature && (
                    <span className="tap-current">{trainingProgress.currentFeature.toUpperCase()}</span>
                  )}
                </div>
                <button className="btn btn-danger btn-sm" onClick={stopAll}>Stop</button>
              </>
            )}
            <button
              className="btn btn-primary btn-sm"
              disabled={globalTraining || processModels.some(m => m.status === "training")}
              onClick={handleTrainAll}
            >
              {globalTraining ? "Training..." : "Train All"}
            </button>
          </div>
        }
      />

      <MainContent
        sidebar={
          <RightSidebar width="340px">
            {/* Active Model Breakdown */}
            <SidebarSection title={`Model Rankings — ${activeModel?.name ?? ""} h1 ST`} className="feature-section">
              {sidebarRows.length === 0 ? (
                <div className="sidebar-empty">No artifacts. Run training first.</div>
              ) : (
                <div className="ranking-list">
                  {sidebarRows.slice(0, 6).map((row, i) => (
                    <div key={i} className={`rank-row ${i === 0 ? "rank-best" : ""}`}>
                      <span className="rank-pos">{i + 1}</span>
                      <span className="rank-model">{row.model.toUpperCase()}</span>
                      <div className="rank-metrics">
                        <span className="rank-metric">
                          <span className="rm-lbl">RMSE</span>
                          <span className="rm-val">{fmt(row.rmse, 2)}</span>
                        </span>
                        <span className="rank-metric">
                          <span className="rm-lbl">MASE</span>
                          <span className={`rm-val ${maseBadgeClass(row.mase)}`}>
                            {row.mase != null ? row.mase.toFixed(2) : "—"}
                          </span>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SidebarSection>

            <SidebarSection title="Training Log" noBorder>
              <div className="training-log-console">
                {trainingLog.length === 0 ? (
                  <div className="log-placeholder">No training session yet.</div>
                ) : trainingLog.map((line, i) => (
                  <div
                    key={i}
                    className={`log-entry${
                      line.startsWith("[OK]") ? " log-ok" :
                      line.startsWith("[FAIL]") || line.startsWith("[ERR]") ? " log-err" :
                      line.startsWith("[--]") ? " log-stop" : ""
                    }`}
                  >{line}</div>
                ))}
                <div ref={logEndRef} />
              </div>
            </SidebarSection>
          </RightSidebar>
        }
        sidebarWidth="340px"
      >
        <ContentArea padding="compact" gap="16px">

          {/* ── Dataset Health ── */}
          <div className="kpi-section-header">
            <h3>Dataset Health</h3>
          </div>
          <div className="data-kpi-row">
            <div className="kpi-card detailed">
              <div className="kpi-top">
                <div className="kpi-label">Total Samples</div>
              </div>
              <div className="kpi-val">
                {processModels.find(m => m.nRows)?.nRows?.toLocaleString() ?? "—"}
              </div>
              <div className="kpi-sub">
                <span className="dot train" /> Train (80%)
                <span className="dot test" /> Test (20%)
              </div>
            </div>
            <div className="kpi-card detailed">
              <div className="kpi-top">
                <div className="kpi-label">Models Trained</div>
              </div>
              <div className="kpi-val">
                {processModels.filter(m => m.stHorizons > 0).length}
                <span className="unit"> / {processModels.length}</span>
              </div>
              <div className="kpi-sub">
                <span className="ok">
                  {processModels.reduce((s, m) => s + m.stHorizons, 0)} ST
                </span>
                {" • "}
                <span className="ok">
                  {processModels.reduce((s, m) => s + m.ltHorizons, 0)} LT horizons
                </span>
              </div>
            </div>
            <div className="kpi-card action-center">
              <div className="kpi-label">Operations</div>
              <div className="action-buttons">
                <button className="btn btn-secondary full-width" onClick={() => setShowIngestModal(true)}>
                  <span className="icon">&#128229;</span> Ingest New Data
                </button>
              </div>
            </div>
          </div>

          {/* ── Model Cards ── */}
          <Section title="Active Models" className="models-section">
            <div className="models-grid">
              {processModels.map(model => (
                <div
                  key={model.id}
                  className={`model-card ${activeModelId === model.id ? "active" : ""} ${model.status === "training" ? "training-mode" : ""}`}
                  onClick={() => model.status !== "training" && setActiveModelId(model.id)}
                >
                  {model.status !== "training" ? (
                    <>
                      <div className="card-header">
                        <div className="title-group">
                          <div className={`model-icon model-icon--${model.featureKey}`}>{model.featureLabel}</div>
                          <div className="title-text">
                            <h3>{model.name}</h3>
                            <div className="meta-row">
                              <span className="version">{model.bestModelType}</span>
                              <span className="sep">•</span>
                              <span className="last-run">
                                {model.stHorizons > 0
                                  ? `${model.stHorizons}ST + ${model.ltHorizons}LT`
                                  : "untrained"}
                              </span>
                            </div>
                          </div>
                        </div>
                        <span className={`status-badge ${model.status}`}>
                          {model.status === "drift-detected" ? "&#9888;&#65039; Drift" :
                           model.status === "optimized"      ? "&#10024; Ready" : "Active"}
                        </span>
                      </div>

                      <div className="card-body">
                        <div className="insight-message">{model.statusMsg}</div>

                        <div className="metric-row">
                          <div className="main-metric">
                            <span className="val">{model.r2.toFixed(1)}%</span>
                            <span className="label">R² Score</span>
                          </div>
                          <div className="side-metrics">
                            <div className="sm-item">
                              <span className="sm-val">{fmt(model.mae, 2)}</span>
                              <span className="sm-lbl">MAE</span>
                            </div>
                            <div className="sm-item">
                              <span className="sm-val">{fmt(model.rmse, 2)}</span>
                              <span className="sm-lbl">RMSE</span>
                            </div>
                          </div>
                        </div>

                        {/* MASE + quantile row */}
                        <div className="chip-row">
                          <div className={`mase-chip ${maseBadgeClass(model.mase)}`}>
                            <span className="chip-lbl">MASE</span>
                            <span className="chip-val">{maseLabel(model.mase)}</span>
                          </div>
                          {model.hasQuantile && model.coverage != null && (
                            <div className="coverage-chip">
                              <span className="chip-lbl">PI Cov</span>
                              <span className="chip-val">{(model.coverage * 100).toFixed(0)}%</span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="card-actions-footer">
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={e => { e.stopPropagation(); handleRetrain(model.id); }}
                        >Retrain</button>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={e => { e.stopPropagation(); setInspectingKey(model.featureKey); setInspectLevel("st"); setInspectTab("profile"); }}
                        >Inspect</button>
                      </div>
                    </>
                  ) : (() => {
                    const prog = trainingProgress;
                    const isActive = prog.currentFeature === model.featureKey
                      || (!prog.currentFeature && prog.featuresTotal.includes(model.featureKey) && prog.featuresTotal[0] === model.featureKey);
                    return (
                      <div className="training-overlay-content">
                        <div className="training-header">
                          <div className="spinner" />
                          <span className="train-feat-name">{model.name}</span>
                          {isActive && prog.currentLevel && (
                            <span className={`level-badge level-${prog.currentLevel}`}>
                              {prog.currentLevel === "st" ? "ST 15min" : "LT 4h"}
                            </span>
                          )}
                          {!isActive && <span className="queued-badge">Queued</span>}
                          <span className={`mode-badge mode-${trainingMode}`}>{trainingMode}</span>
                        </div>

                        {isActive ? (
                          <>
                            {/* Step indicator */}
                            {prog.currentStep && (
                              <div className="step-indicator">
                                <span className={`step-badge step-${prog.currentStep}`}>
                                  {prog.currentStep === "model"       ? "Model Evaluation"
                                   : prog.currentStep === "quantile"  ? "Quantile Intervals"
                                   :                                    "Multi-Output"}
                                </span>
                              </div>
                            )}

                            {/* Current model being evaluated */}
                            {prog.currentModel ? (
                              <div className="current-model-block">
                                <div className="cm-row">
                                  <span className="cm-model">{prog.currentModel.toUpperCase()}</span>
                                  {prog.currentHorizon != null && (
                                    <>
                                      <span className="cm-arrow">›</span>
                                      <span className="cm-horizon">h{prog.currentHorizon}</span>
                                      <span className="cm-hint">
                                        {prog.currentLevel === "lt"
                                          ? `${prog.currentHorizon * 4}h ahead`
                                          : `${prog.currentHorizon * 15}min ahead`}
                                      </span>
                                    </>
                                  )}
                                </div>
                              </div>
                            ) : prog.currentStep === "quantile" ? (
                              <div className="current-model-block step-alt">
                                <div className="cm-row">
                                  <span className="cm-model-dim">Q10 / Q50 / Q90</span>
                                  <span className="cm-hint">prediction intervals</span>
                                </div>
                              </div>
                            ) : prog.currentStep === "multioutput" ? (
                              <div className="current-model-block step-alt">
                                <div className="cm-row">
                                  <span className="cm-model-dim">HGB (Multi-Output)</span>
                                  <span className="cm-hint">all horizons jointly</span>
                                </div>
                              </div>
                            ) : null}

                            {/* Progress bar */}
                            <div className="progress-bar-track">
                              <div className="progress-bar-fill indeterminate" />
                            </div>

                            {/* Recent models evaluated */}
                            {prog.recentModels.length > 0 && (
                              <div className="recent-models-row">
                                <span className="recent-label">Done:</span>
                                {prog.recentModels.slice(0, 5).map((r, i) => (
                                  <span key={i} className={`recent-chip level-${r.level}`}>
                                    {r.model}·h{r.horizon}
                                  </span>
                                ))}
                              </div>
                            )}

                            <div className="training-footer">
                              <span className="stop-link"
                                onClick={e => { e.stopPropagation(); stopRetrain(model.id); }}>
                                Stop
                              </span>
                            </div>
                          </>
                        ) : (
                          <div className="queued-msg">Waiting for current run to finish...</div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              ))}
            </div>
          </Section>

          {/* ── Horizon RMSE Profile ── */}
          <Section className="forecast-chart-section">
            <div className="section-header-custom">
              <div className="header-title">
                <h3>Horizon Error Profile — {activeModel?.name ?? "—"}</h3>
                <span className="subtitle">
                  RMSE vs forecast horizon for best model per step
                </span>
              </div>
              <div className="chart-legend">
                <span className="item"><span className="dot st-dot" /> ST (15 min steps)</span>
                <span className="item"><span className="dot lt-dot" /> LT (4 h steps)</span>
              </div>
            </div>

            {stProfile.length === 0 && ltProfile.length === 0 ? (
              <div className="chart-empty">
                Train a model to see the horizon error profile.
              </div>
            ) : (
              <div className="chart-container">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis
                      dataKey="h"
                      type="number"
                      stroke="rgba(255,255,255,0.3)"
                      style={{ fontSize: 10 }}
                      tickLine={false}
                      label={{ value: "horizon step", position: "insideBottomRight", offset: -5, fill: "rgba(255,255,255,0.3)", fontSize: 10 }}
                    />
                    <YAxis stroke="rgba(255,255,255,0.3)" style={{ fontSize: 10 }} tickLine={false} width={50} />
                    <Tooltip
                      contentStyle={{ backgroundColor: "#0b0d12", border: "1px solid #333", fontSize: 11 }}
                      formatter={(v: any, name: string) => [typeof v === "number" ? v.toFixed(3) : v, name]}
                    />
                    <Legend wrapperStyle={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }} />
                    {stProfile.length > 0 && (
                      <Line
                        data={stProfile}
                        type="monotone"
                        dataKey="rmse"
                        name="ST RMSE"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        dot={{ r: 4, fill: "#3b82f6" }}
                        activeDot={{ r: 5 }}
                      />
                    )}
                    {ltProfile.length > 0 && (
                      <Line
                        data={ltProfile}
                        type="monotone"
                        dataKey="rmse"
                        name="LT RMSE"
                        stroke="#8b5cf6"
                        strokeWidth={2}
                        strokeDasharray="6 3"
                        dot={{ r: 4, fill: "#8b5cf6" }}
                        activeDot={{ r: 5 }}
                      />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </Section>

        </ContentArea>
      </MainContent>

      {/* ── Ingest Modal ── */}
      {showIngestModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>Ingest Data Source</h3>
              <button className="close-btn" onClick={() => setShowIngestModal(false)}>&#215;</button>
            </div>
            <div className="modal-body">
              {ingestProgress === 0 ? (
                <div className="ingest-options">
                  <button className="source-btn" onClick={startIngestion}>
                    <span className="icon">&#128196;</span>
                    <div className="text"><span className="title">CSV Upload</span><span className="desc">Manual file upload</span></div>
                  </button>
                  <button className="source-btn" onClick={startIngestion}>
                    <span className="icon">&#128452;</span>
                    <div className="text"><span className="title">SQL Database</span><span className="desc">Connect via JDBC</span></div>
                  </button>
                  <button className="source-btn" onClick={startIngestion}>
                    <span className="icon">&#9729;&#65039;</span>
                    <div className="text"><span className="title">IoT Stream</span><span className="desc">MQTT / Kafka</span></div>
                  </button>
                </div>
              ) : (
                <div className="ingest-progress">
                  <div className="spinner-large" />
                  <h4>Ingesting Data...</h4>
                  <div className="progress-bar-track">
                    <div className="progress-bar-fill" style={{ width: `${ingestProgress}%` }} />
                  </div>
                  <span className="status-text">{ingestProgress}% Complete</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Inspect Modal ── */}
      {inspectingKey && inspectFeat && inspectModel && (
        <div className="modal-overlay" onClick={() => setInspectingKey(null)}>
          <div className="modal-content inspect-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-header-left">
                <h3>{inspectModel.name}</h3>
                <span className="modal-subtitle">
                  {inspectModel.bestModelType} &nbsp;•&nbsp;
                  {inspectModel.nRows?.toLocaleString() ?? "—"} training rows
                </span>
              </div>
              <button className="close-btn" onClick={() => setInspectingKey(null)}>&#215;</button>
            </div>

            {/* Level + Tab switcher */}
            <div className="inspect-controls">
              <div className="tab-group">
                <button className={inspectLevel === "st" ? "active" : ""} onClick={() => setInspectLevel("st")}>
                  Short-Term (15 min)
                </button>
                <button className={inspectLevel === "lt" ? "active" : ""} onClick={() => setInspectLevel("lt")}>
                  Long-Term (4 h)
                </button>
              </div>
              <div className="tab-group">
                <button className={inspectTab === "profile" ? "active" : ""} onClick={() => setInspectTab("profile")}>
                  Horizon Profile
                </button>
                <button className={inspectTab === "table" ? "active" : ""} onClick={() => setInspectTab("table")}>
                  All Models
                </button>
              </div>
            </div>

            <div className="modal-body inspect-body">

              {/* ── Horizon Profile tab ── */}
              {inspectTab === "profile" && (() => {
                const horizons = inspectLevel === "st" ? inspectFeat.st : inspectFeat.lt;
                const profile = buildHorizonProfile(horizons, inspectLevel);
                const mo = inspectFeat.multioutput[inspectLevel];
                const stepLabel = inspectLevel === "st" ? "×15 min" : "×4 h";

                return (
                  <div className="profile-layout">
                    {/* Metric table per horizon */}
                    <div className="horizon-table-wrap">
                      <table className="horizon-table">
                        <thead>
                          <tr>
                            <th>H</th>
                            <th>Model</th>
                            <th>RMSE</th>
                            <th>MAE</th>
                            <th>R²</th>
                            <th>MASE</th>
                            <th>PI Cov</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(horizons)
                            .sort(([a],[b]) => parseInt(a)-parseInt(b))
                            .map(([h, meta]) => (
                              <tr key={h}>
                                <td className="h-cell">h{h} <span className="step-label">{stepLabel}</span></td>
                                <td><span className="model-tag">{meta.model?.toUpperCase() ?? "—"}</span></td>
                                <td className="num-cell">{fmt(meta.rmse, 3)}</td>
                                <td className="num-cell">{fmt(meta.mae,  3)}</td>
                                <td className="num-cell">{fmt(meta.r2,   3)}</td>
                                <td>
                                  <span className={`mase-chip inline ${maseBadgeClass(meta.mase)}`}>
                                    {meta.mase != null ? meta.mase.toFixed(2) : "—"}
                                  </span>
                                </td>
                                <td className="num-cell">
                                  {meta.quantile?.coverage != null
                                    ? `${(meta.quantile.coverage * 100).toFixed(0)}%`
                                    : "—"}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>

                    {/* RMSE line chart */}
                    <div className="profile-chart-wrap">
                      <div className="profile-chart-title">RMSE by horizon</div>
                      {profile.length > 0 ? (
                        <ResponsiveContainer width="100%" height={180}>
                          <LineChart data={profile} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                            <XAxis dataKey="h" stroke="rgba(255,255,255,0.3)" style={{ fontSize: 10 }} tickLine={false} />
                            <YAxis stroke="rgba(255,255,255,0.3)" style={{ fontSize: 10 }} tickLine={false} width={45} />
                            <Tooltip
                              contentStyle={{ backgroundColor: "#0b0d12", border: "1px solid #333", fontSize: 11 }}
                              formatter={(v: any) => [typeof v === "number" ? v.toFixed(3) : v]}
                            />
                            <Line type="monotone" dataKey="rmse" name="RMSE" stroke="#3b82f6" strokeWidth={2} dot={{ r: 4, fill: "#3b82f6" }} />
                            <Line type="monotone" dataKey="mase" name="MASE" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="4 2" dot={{ r: 3, fill: "#f59e0b" }} />
                            <ReferenceLine y={1} stroke="#ef4444" strokeDasharray="3 3"
                              label={{ value: "MASE=1", position: "insideTopRight", fill: "#ef4444", fontSize: 9 }}
                            />
                          </LineChart>
                        </ResponsiveContainer>
                      ) : (
                        <div className="chart-empty-sm">No {inspectLevel.toUpperCase()} horizons trained.</div>
                      )}

                      {/* Multi-output vs best-per-horizon comparison */}
                      {mo && Object.keys(mo.per_horizon_mae).length > 0 && (
                        <div className="mo-section">
                          <div className="mo-title">
                            Multi-Output ({mo.base_model?.toUpperCase()}) vs Per-Horizon Best
                          </div>
                          <div className="mo-table">
                            {Object.entries(mo.per_horizon_mae)
                              .sort(([a],[b]) => parseInt(a)-parseInt(b))
                              .map(([h, moData]) => {
                                const bestMae = horizons[h]?.mae ?? null;
                                const moMae = moData?.mae ?? null;
                                const diff = (bestMae != null && moMae != null)
                                  ? moMae - bestMae : null;
                                return (
                                  <div key={h} className="mo-row">
                                    <span className="mo-h">h{h}</span>
                                    <span className="mo-val">MO: {fmt(moMae, 2)}</span>
                                    <span className="mo-val">Best: {fmt(bestMae, 2)}</span>
                                    <span className={`mo-diff ${diff != null && diff < 0 ? "mo-better" : "mo-worse"}`}>
                                      {diff != null ? (diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)) : "—"}
                                    </span>
                                  </div>
                                );
                              })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* ── All Models tab ── */}
              {inspectTab === "table" && (() => {
                const rows = (inspectLevel === "st"
                  ? inspectFeat.all_models_st
                  : inspectFeat.all_models_lt
                ).sort((a, b) => (a.horizon ?? 0) - (b.horizon ?? 0) || (a.rmse ?? 999) - (b.rmse ?? 999));

                // Group by horizon for section headers
                const byHorizon = rows.reduce<Record<number, ModelRow[]>>((acc, r) => {
                  const h = r.horizon ?? 0;
                  (acc[h] ??= []).push(r);
                  return acc;
                }, {});

                return rows.length === 0 ? (
                  <div className="chart-empty">No metrics CSV found. Run a full training pass to populate this.</div>
                ) : (
                  <div className="all-models-table-wrap">
                    {Object.entries(byHorizon)
                      .sort(([a],[b]) => parseInt(a)-parseInt(b))
                      .map(([h, hrows]) => (
                        <div key={h} className="horizon-group">
                          <div className="horizon-group-title">
                            Horizon {h}
                            <span className="step-label">
                              {inspectLevel === "st" ? ` (${parseInt(h) * 15} min ahead)` : ` (${parseInt(h) * 4} h ahead)`}
                            </span>
                          </div>
                          <table className="all-models-table">
                            <thead>
                              <tr>
                                <th>Model</th>
                                <th>RMSE</th>
                                <th>MAE</th>
                                <th>R²</th>
                                <th>MASE</th>
                                <th>Folds</th>
                              </tr>
                            </thead>
                            <tbody>
                              {hrows.map((row, i) => {
                                const isBest = i === 0;
                                return (
                                  <tr key={i} className={isBest ? "best-row" : ""}>
                                    <td>
                                      <span className="model-tag">{row.model.toUpperCase()}</span>
                                      {isBest && <span className="best-badge">best</span>}
                                    </td>
                                    <td className="num-cell">{fmt(row.rmse, 3)}</td>
                                    <td className="num-cell">{fmt(row.mae,  3)}</td>
                                    <td className="num-cell">{fmt(row.r2,   3)}</td>
                                    <td>
                                      <span className={`mase-chip inline ${maseBadgeClass(row.mase)}`}>
                                        {row.mase != null ? row.mase.toFixed(2) : "—"}
                                      </span>
                                    </td>
                                    <td className="num-cell">{row.n_folds ?? "—"}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ))}
                  </div>
                );
              })()}
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setInspectingKey(null)}>Close</button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setInspectingKey(null);
                  const m = processModels.find(m => m.featureKey === inspectingKey);
                  if (m) handleRetrain(m.id);
                }}
              >Retrain This Model</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ForecastTab;
