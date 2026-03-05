import React, { useState, useEffect, useRef, useCallback, ReactNode } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Line, ReferenceLine, ScatterChart, Scatter,
} from "recharts";
import "./ForecastTab.scss";
import Topbar from "./components/Topbar";
import RightSidebar, { SidebarSection } from "./components/RightSidebar";
import MainContent, { ContentArea, Section } from "./components/MainContent";

// --- Interfaces ---

interface TrainingState {
  isTraining: boolean;
}

interface ProcessModel {
  id: string;
  featureKey: string; // maps to artifacts API key
  name: string;
  version: string;
  featureLabel: ReactNode;
  modelType: string;
  inputs: string[];
  accuracy: number;
  accuracyTrend: number[];
  rmse: number;
  mae: number;
  status: "active" | "drift-detected" | "optimized" | "training";
  statusMsg?: string;
  lastTrained: string;
  datasetSize: string;
  trainingState?: TrainingState;
}

interface FeatureCorrelation {
  name: string;
  impact: number;
  correlation: "positive" | "negative";
}

interface ArtifactMeta {
  model: string | null;
  mae: number | null;
  rmse: number | null;
  r2: number | null;
  n_rows: number | null;
}

// --- Initial mock models (fallback when no artifacts exist) ---

const INITIAL_MODELS: ProcessModel[] = [
  {
    id: "temp-model",
    featureKey: "temperature",
    name: "Indoor Temp Prediction",
    version: "v2.4.1",
    featureLabel: <>🌡️ Temp</>,
    modelType: "ANN",
    inputs: ["Outdoor Temp", "Solar Rad", "HVAC State"],
    accuracy: 94.2,
    accuracyTrend: [92, 93, 93.5, 94.2, 94.1, 94.2],
    rmse: 0.38,
    mae: 0.27,
    status: "active",
    statusMsg: "Performing optimally",
    lastTrained: "2h ago",
    datasetSize: "14k samples",
  },
  {
    id: "energy-model",
    featureKey: "energy",
    name: "Energy Load Forecast",
    version: "v1.8.0",
    featureLabel: <>⚡ Energy</>,
    modelType: "GPR",
    inputs: ["Occupancy", "Schedule", "Temp Diff"],
    accuracy: 89.5,
    accuracyTrend: [88, 89, 88.5, 89.0, 89.2, 89.5],
    rmse: 12.4,
    mae: 8.7,
    status: "optimized",
    statusMsg: "New data available (+2k)",
    lastTrained: "4h ago",
    datasetSize: "12k samples",
  },
  {
    id: "occ-model",
    featureKey: "occupancy",
    name: "Occupancy Flow",
    version: "v3.0.0",
    featureLabel: <>👥 Occ</>,
    modelType: "LinReg",
    inputs: ["Time", "DayType", "Access Logs"],
    accuracy: 82.1,
    accuracyTrend: [81, 80, 81.5, 82.0, 82.1, 81.2],
    rmse: 4.2,
    mae: 3.1,
    status: "drift-detected",
    statusMsg: "Accuracy dropped -1.2%",
    lastTrained: "1d ago",
    datasetSize: "5k samples",
  },
  {
    id: "airq-model",
    featureKey: "airquality",
    name: "Air Quality Index",
    version: "v1.0.0",
    featureLabel: <>💨 AirQ</>,
    modelType: "HGB",
    inputs: ["CO2", "VOC", "PM2.5", "Occupancy"],
    accuracy: 87.3,
    accuracyTrend: [85, 86, 87, 87.3, 87.3, 87.3],
    rmse: 6.1,
    mae: 4.5,
    status: "active",
    statusMsg: "Running normally",
    lastTrained: "6h ago",
    datasetSize: "10k samples",
  },
];

// --- Component ---

const ForecastTab: React.FC = () => {
  const [processModels, setProcessModels] = useState<ProcessModel[]>(INITIAL_MODELS);
  const [featureImportance, setFeatureImportance] = useState<FeatureCorrelation[]>([]);
  const [activeModelId, setActiveModelId] = useState<string>("temp-model");
  const [timeRange, setTimeRange] = useState<"7d" | "30d">("7d");
  const [showIngestModal, setShowIngestModal] = useState(false);
  const [ingestProgress, setIngestProgress] = useState(0);
  const [inspectingModel, setInspectingModel] = useState<ProcessModel | null>(null);
  const [trainingLog, setTrainingLog] = useState<string[]>([]);
  const [globalTraining, setGlobalTraining] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  // --- Feature importance mock ---
  useEffect(() => {
    setFeatureImportance([
      { name: "Outdoor Temp", impact: 0.85, correlation: "positive" },
      { name: "Solar Irradiance", impact: 0.65, correlation: "positive" },
      { name: "Occupancy Count", impact: 0.45, correlation: "positive" },
      { name: "Wind Speed", impact: 0.25, correlation: "negative" },
    ]);
  }, []);

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [trainingLog]);

  // --- Fetch and apply real artifact metrics ---
  const applyArtifacts = useCallback(async () => {
    try {
      const res = await fetch("http://localhost:8000/api/artifacts/status");
      if (!res.ok) return;
      const data: Record<string, { st: Record<string, ArtifactMeta>; lt: Record<string, ArtifactMeta> }> = await res.json();

      setProcessModels(prev =>
        prev.map(m => {
          const fa = data[m.featureKey];
          if (!fa) return m;
          // Use ST h1 as representative
          const meta: ArtifactMeta | undefined = fa.st["1"] ?? Object.values(fa.st)[0];
          if (!meta) return m;

          const r2 = meta.r2 ?? 0;
          const accuracy = Math.min(100, Math.max(0, r2 * 100));
          return {
            ...m,
            accuracy: parseFloat(accuracy.toFixed(1)),
            rmse: parseFloat((meta.rmse ?? m.rmse).toFixed(3)),
            mae: parseFloat((meta.mae ?? m.mae).toFixed(3)),
            modelType: (meta.model ?? m.modelType).toUpperCase(),
            status: "active" as const,
            statusMsg: `${Object.keys(fa.st).length} ST + ${Object.keys(fa.lt).length} LT horizons trained`,
            datasetSize: meta.n_rows ? `${(meta.n_rows / 1000).toFixed(0)}k samples` : m.datasetSize,
            lastTrained: "recently",
          };
        })
      );
    } catch {
      // silently ignore — backend may not be running
    }
  }, []);

  useEffect(() => { applyArtifacts(); }, [applyArtifacts]);

  // --- Real retrain via WebSocket ---
  const handleRetrain = useCallback((modelId: string) => {
    const model = INITIAL_MODELS.find(m => m.id === modelId);
    if (!model) return;

    // Mark card as training
    setProcessModels(prev =>
      prev.map(m =>
        m.id === modelId
          ? { ...m, status: "training", trainingState: { isTraining: true } }
          : m
      )
    );
    setTrainingLog(prev => [...prev, `--- Starting retrain: ${model.featureKey} ---`]);

    const ws = new WebSocket("ws://localhost:8000/training/ws");
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "start",
        mode: "fast",
        features: [model.featureKey],
        table: "matches",
      }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "log" && msg.line) {
        setTrainingLog(prev => [...prev.slice(-100), msg.line]);
      }

      if (msg.type === "complete" || msg.type === "stopped" || msg.type === "error") {
        const success = msg.type === "complete" && msg.success;

        setProcessModels(prev =>
          prev.map(m =>
            m.id === modelId
              ? {
                  ...m,
                  status: "active",
                  statusMsg: success ? "Retrained successfully" : "Training failed — check log",
                  trainingState: undefined,
                }
              : m
          )
        );

        const logLine =
          msg.type === "complete"
            ? success
              ? `[✓] ${model.featureKey} training complete.`
              : `[✗] Training exited (code ${msg.returncode}).`
            : msg.type === "stopped"
            ? `[—] Training stopped.`
            : `[!] Error: ${msg.message || "unknown"}`;

        setTrainingLog(prev => [...prev, logLine]);

        if (success) applyArtifacts();
      }
    };

    ws.onerror = () => {
      setProcessModels(prev =>
        prev.map(m =>
          m.id === modelId ? { ...m, status: "active", trainingState: undefined } : m
        )
      );
      setTrainingLog(prev => [...prev, `[!] WebSocket error — is the backend running?`]);
    };

    ws.onclose = () => { /* nothing extra needed */ };
  }, [applyArtifacts]);

  const stopRetrain = useCallback((modelId: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop" }));
    }
    setProcessModels(prev =>
      prev.map(m =>
        m.id === modelId ? { ...m, status: "active", trainingState: undefined } : m
      )
    );
  }, []);

  // --- Train All ---
  const handleTrainAll = useCallback(() => {
    if (globalTraining) return;

    // Mark every card as training
    setProcessModels(prev =>
      prev.map(m => ({ ...m, status: "training", trainingState: { isTraining: true } }))
    );
    setGlobalTraining(true);
    setTrainingLog(prev => [...prev, "--- Train All started (fast mode) ---"]);

    const ws = new WebSocket("ws://localhost:8000/training/ws");
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "start",
        mode: "fast",
        features: INITIAL_MODELS.map(m => m.featureKey),
        table: "matches",
      }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "log" && msg.line) {
        setTrainingLog(prev => [...prev.slice(-100), msg.line]);
      }

      // Mark a feature card as done when its feature completes
      if (msg.type === "log" && msg.feature_done) {
        const doneCard = INITIAL_MODELS.find(m => m.featureKey === msg.feature_done);
        if (doneCard) {
          setProcessModels(prev =>
            prev.map(m =>
              m.id === doneCard.id
                ? { ...m, status: "active", statusMsg: "Retrained successfully", trainingState: undefined }
                : m
            )
          );
        }
      }

      if (msg.type === "complete" || msg.type === "stopped" || msg.type === "error") {
        setGlobalTraining(false);

        // Return any still-training cards to active
        setProcessModels(prev =>
          prev.map(m =>
            m.status === "training"
              ? { ...m, status: "active", statusMsg: msg.type === "complete" && msg.success ? "Retrained successfully" : "Training ended", trainingState: undefined }
              : m
          )
        );

        const logLine =
          msg.type === "complete"
            ? msg.success ? "[✓] All features trained." : `[✗] Training exited (code ${msg.returncode}).`
            : msg.type === "stopped" ? "[—] Training stopped."
            : `[!] Error: ${msg.message || "unknown"}`;

        setTrainingLog(prev => [...prev, logLine]);
        if (msg.type === "complete" && msg.success) applyArtifacts();
      }
    };

    ws.onerror = () => {
      setGlobalTraining(false);
      setProcessModels(prev =>
        prev.map(m => m.status === "training" ? { ...m, status: "active", trainingState: undefined } : m)
      );
      setTrainingLog(prev => [...prev, "[!] WebSocket error — is the backend running?"]);
    };

    ws.onclose = () => { /* nothing extra needed */ };
  }, [globalTraining, applyArtifacts]);

  const stopAll = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop" }));
    }
  }, []);

  // --- Ingest mock ---
  const startIngestion = () => {
    setIngestProgress(0);
    const interval = setInterval(() => {
      setIngestProgress(prev => {
        if (prev >= 100) { clearInterval(interval); setTimeout(() => setShowIngestModal(false), 500); return 100; }
        return prev + 10;
      });
    }, 200);
  };

  return (
    <div className="forecast-container">
      <Topbar
        variant="forecast"
        title="Forecast"
        subtitle="Model Training & Evaluation"
        rightContent={
          <div className="topbar-action-group">
            {globalTraining && (
              <button className="btn btn-danger btn-sm" onClick={stopAll}>
                Stop
              </button>
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
            <SidebarSection title="Input Feature Impact" className="feature-section">
              <div className="correlation-chart">
                {featureImportance.map((f, i) => (
                  <div key={i} className="corr-row">
                    <span className="f-name">{f.name}</span>
                    <div className="f-bar-track">
                      <div className={`f-bar ${f.correlation}`} style={{ width: `${f.impact * 100}%` }} />
                    </div>
                    <span className="f-val">{f.impact.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </SidebarSection>

            <SidebarSection title="Training Log" noBorder>
              <div className="training-log-console">
                {trainingLog.length === 0 ? (
                  <div className="log-placeholder">No training session yet.</div>
                ) : (
                  trainingLog.map((line, i) => (
                    <div
                      key={i}
                      className={`log-entry${line.startsWith("[✓]") ? " log-ok" : line.startsWith("[✗]") || line.startsWith("[!]") ? " log-err" : ""}`}
                    >
                      {line}
                    </div>
                  ))
                )}
                <div ref={logEndRef} />
              </div>
            </SidebarSection>
          </RightSidebar>
        }
        sidebarWidth="340px"
      >
        <ContentArea padding="compact" gap="16px">

          {/* 1. Dataset Health */}
          <div className="kpi-section-header">
            <h3>Dataset Health</h3>
            <div className="time-selector">
              <button className={timeRange === "7d" ? "active" : ""} onClick={() => setTimeRange("7d")}>7 Days</button>
              <button className={timeRange === "30d" ? "active" : ""} onClick={() => setTimeRange("30d")}>30 Days</button>
            </div>
          </div>

          <div className="data-kpi-row">
            <div className="kpi-card detailed">
              <div className="kpi-top">
                <div className="kpi-label">Total Samples</div>
                <div className="kpi-icon default">📊</div>
              </div>
              <div className="kpi-val">142,857 <span className="trend up">+1.2k</span></div>
              <div className="kpi-sub">
                <span className="dot train"></span> Train (70%)
                <span className="dot test"></span> Test (30%)
              </div>
            </div>

            <div className="kpi-card detailed">
              <div className="kpi-top">
                <div className="kpi-label">Data Quality</div>
                <div className="kpi-icon success">🛡️</div>
              </div>
              <div className="kpi-val">98.4<span className="unit">%</span></div>
              <div className="kpi-sub">
                <span className="ok">140k Valid</span> • <span className="warn">2k Missing</span>
              </div>
            </div>

            <div className="kpi-card action-center">
              <div className="kpi-label">Operations</div>
              <div className="action-buttons">
                <button className="btn btn-secondary full-width" onClick={() => setShowIngestModal(true)}>
                  <span className="icon">📥</span> Ingest New Data
                </button>
              </div>
            </div>
          </div>

          {/* 2. Model Registry */}
          <Section title="Active Models" className="models-section">
            <div className="models-grid">
              {processModels.map(model => (
                <div
                  key={model.id}
                  className={`model-card ${activeModelId === model.id ? "active" : ""} ${model.status === "training" ? "training-mode" : ""}`}
                  onClick={() => model.status !== "training" && setActiveModelId(model.id)}
                >
                  {/* NORMAL VIEW */}
                  {model.status !== "training" && (
                    <>
                      <div className="card-header">
                        <div className="title-group">
                          <div className="model-icon">{model.featureLabel}</div>
                          <div className="title-text">
                            <h3>{model.name}</h3>
                            <div className="meta-row">
                              <span className="version">{model.modelType}</span>
                              <span className="sep">•</span>
                              <span className="last-run">{model.lastTrained}</span>
                            </div>
                          </div>
                        </div>
                        <span className={`status-badge ${model.status}`}>
                          {model.status === "drift-detected" ? "⚠️ Drift" : model.status === "optimized" ? "✨ Ready" : "Active"}
                        </span>
                      </div>

                      <div className="card-body">
                        <div className="insight-message">{model.statusMsg}</div>
                        <div className="metric-row">
                          <div className="main-metric">
                            <span className="val">{model.accuracy.toFixed(1)}%</span>
                            <span className="label">R² Score</span>
                          </div>
                          <div className="side-metrics">
                            <div className="sm-item"><span className="sm-val">{model.mae}</span><span className="sm-lbl">MAE</span></div>
                            <div className="sm-item"><span className="sm-val">{model.rmse}</span><span className="sm-lbl">RMSE</span></div>
                          </div>
                        </div>
                      </div>

                      <div className="card-actions-footer">
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={e => { e.stopPropagation(); handleRetrain(model.id); }}
                        >
                          Retrain
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={e => { e.stopPropagation(); setInspectingModel(model); }}
                        >
                          Inspect
                        </button>
                      </div>
                    </>
                  )}

                  {/* TRAINING VIEW */}
                  {model.status === "training" && model.trainingState && (
                    <div className="training-overlay-content">
                      <div className="training-header">
                        <div className="spinner"></div>
                        <span>Training {model.name}...</span>
                      </div>
                      <div className="progress-section">
                        <div className="progress-bar-track">
                          <div className="progress-bar-fill indeterminate" />
                        </div>
                        <div className="progress-stats">
                          <span className="stop-link" onClick={e => { e.stopPropagation(); stopRetrain(model.id); }}>Stop</span>
                        </div>
                      </div>
                      <div className="live-metrics">
                        <div className="lm-item">
                          <span className="lbl">Feature</span>
                          <span className="val">{(model.featureKey ?? "").toUpperCase()}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Section>

          {/* 3. Verification Chart */}
          <Section className="forecast-chart-section">
            <div className="section-header-custom">
              <div className="header-title">
                <h3>Prediction Verification (24h)</h3>
                <span className="subtitle">Model output vs Actual sensor data</span>
              </div>
              <div className="chart-legend">
                <span className="item"><span className="dot actual"></span> Actual</span>
                <span className="item"><span className="dot predicted"></span> Predicted</span>
              </div>
            </div>
            <div className="chart-container">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={Array.from({ length: 24 }).map((_, i) => ({
                    hour: i,
                    actual: i < 18 ? Math.sin(i / 4) * 10 + 20 + Math.random() : null,
                    predicted: Math.sin(i / 4) * 10 + 20,
                    conf_high: Math.sin(i / 4) * 10 + 22,
                    conf_low: Math.sin(i / 4) * 10 + 18,
                  }))}
                  margin={{ top: 10, right: 0, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                  <XAxis dataKey="hour" stroke="rgba(255,255,255,0.3)" style={{ fontSize: 10 }} tickLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: "#0b0d12", border: "1px solid #333" }} />
                  <ReferenceLine x={18} stroke="#ef4444" strokeDasharray="3 3" label={{ value: "NOW", position: "insideTopLeft", fill: "#ef4444", fontSize: 10 }} />
                  <Area type="monotone" dataKey="conf_high" stroke="none" fill="rgba(139,92,246,0.1)" />
                  <Line type="monotone" dataKey="predicted" stroke="#8b5cf6" strokeWidth={2} dot={false} strokeDasharray="5 5" />
                  <Line type="monotone" dataKey="actual" stroke="#3b82f6" strokeWidth={3} dot={{ r: 3 } as any} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Section>

        </ContentArea>
      </MainContent>

      {/* --- MODALS --- */}

      {/* Ingest Data Modal */}
      {showIngestModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>Ingest Data Source</h3>
              <button className="close-btn" onClick={() => setShowIngestModal(false)}>×</button>
            </div>
            <div className="modal-body">
              {ingestProgress === 0 ? (
                <div className="ingest-options">
                  <button className="source-btn" onClick={startIngestion}><span className="icon">📄</span><div className="text"><span className="title">CSV Upload</span><span className="desc">Manual file upload</span></div></button>
                  <button className="source-btn" onClick={startIngestion}><span className="icon">🗄️</span><div className="text"><span className="title">SQL Database</span><span className="desc">Connect via JDBC</span></div></button>
                  <button className="source-btn" onClick={startIngestion}><span className="icon">☁️</span><div className="text"><span className="title">IoT Stream</span><span className="desc">MQTT / Kafka</span></div></button>
                </div>
              ) : (
                <div className="ingest-progress">
                  <div className="spinner-large"></div>
                  <h4>Ingesting Data...</h4>
                  <div className="progress-bar-track"><div className="progress-bar-fill" style={{ width: `${ingestProgress}%` }}></div></div>
                  <span className="status-text">{ingestProgress}% Complete</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Inspect Model Modal */}
      {inspectingModel && (
        <div className="modal-overlay">
          <div className="modal-content large">
            <div className="modal-header">
              <h3>Inspecting: {inspectingModel.name}</h3>
              <button className="close-btn" onClick={() => setInspectingModel(null)}>×</button>
            </div>
            <div className="modal-body inspect-body">
              <div className="inspect-grid">
                <div className="inspect-col">
                  <h4>Performance Metrics</h4>
                  <div className="metric-table">
                    <div className="row"><span>RMSE</span><strong>{inspectingModel.rmse}</strong></div>
                    <div className="row"><span>MAE</span><strong>{inspectingModel.mae}</strong></div>
                    <div className="row"><span>R² Score</span><strong>{(inspectingModel.accuracy / 100).toFixed(3)}</strong></div>
                    <div className="row"><span>Model Type</span><strong>{inspectingModel.modelType}</strong></div>
                  </div>
                  <h4 className="mt-lg">Input Features</h4>
                  <div className="tag-cloud">
                    {inspectingModel.inputs.map(i => <span key={i} className="tag">{i}</span>)}
                  </div>
                </div>
                <div className="inspect-col main-chart">
                  <h4>Predicted vs Actual (Test Set)</h4>
                  <div className="scatter-chart-wrapper">
                    <ResponsiveContainer width="100%" height={250}>
                      <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                        <XAxis type="number" dataKey="x" name="Actual" unit="°C" stroke="#888" fontSize={10} />
                        <YAxis type="number" dataKey="y" name="Predicted" unit="°C" stroke="#888" fontSize={10} />
                        <Tooltip cursor={{ strokeDasharray: "3 3" }} contentStyle={{ backgroundColor: "#000", border: "1px solid #333" }} />
                        <Scatter
                          name="Validation"
                          data={Array.from({ length: 50 }).map(() => {
                            const val = 20 + Math.random() * 10;
                            return { x: val, y: val + (Math.random() - 0.5) * 2 };
                          })}
                          fill="#8884d8"
                        />
                      </ScatterChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setInspectingModel(null)}>Close</button>
              <button className="btn btn-primary" onClick={() => { setInspectingModel(null); handleRetrain(inspectingModel.id); }}>Retrain This Model</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ForecastTab;
