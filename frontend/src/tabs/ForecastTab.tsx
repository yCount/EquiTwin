import React, { useState, useEffect, ReactNode } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Line, ReferenceLine, ScatterChart, Scatter, ZAxis
} from "recharts";
import "./ForecastTab.scss";
import Topbar from "./components/Topbar";
import RightSidebar, { SidebarSection } from "./components/RightSidebar";
import MainContent, { ContentArea, Section } from "./components/MainContent";

// --- Interfaces ---
interface TrainingState {
  isTraining: boolean;
  progress: number;
  currentEpoch: number;
  totalEpochs: number;
  currentLoss: number;
  timeRemaining: string;
}

interface ProcessModel {
  id: string;
  name: string;
  version: string;
  featureLabel: ReactNode;
  modelType: 'ANN' | 'GPR' | 'LinReg';
  inputs: string[];
  accuracy: number;
  accuracyTrend: number[]; 
  rmse: number;
  mae: number;
  status: 'active' | 'drift-detected' | 'optimized' | 'training';
  statusMsg?: string;
  lastTrained: string;
  datasetSize: string;
  trainingState?: TrainingState;
}

interface FeatureCorrelation {
  name: string;
  impact: number;
  correlation: 'positive' | 'negative';
}

const ForecastTab: React.FC = () => {
  // --- State ---
  const [processModels, setProcessModels] = useState<ProcessModel[]>([]);
  const [featureImportance, setFeatureImportance] = useState<FeatureCorrelation[]>([]);
  const [activeModelId, setActiveModelId] = useState<string>('temp-model');
  const [timeRange, setTimeRange] = useState<'7d' | '30d'>('7d');
  
  // Modal States
  const [showIngestModal, setShowIngestModal] = useState(false);
  const [ingestProgress, setIngestProgress] = useState(0);
  const [inspectingModel, setInspectingModel] = useState<ProcessModel | null>(null);

  // --- Mock Data Initialization ---
  useEffect(() => {
    setProcessModels([
      {
        id: 'temp-model',
        name: 'Indoor Temp Prediction',
        version: 'v2.4.1',
        featureLabel: (<>🌡️ Temp</>),
        modelType: 'ANN',
        inputs: ['Outdoor Temp', 'Solar Rad', 'HVAC State'],
        accuracy: 94.2,
        accuracyTrend: [92, 93, 93.5, 94.2, 94.1, 94.2],
        rmse: 0.38, mae: 0.27,
        status: 'active',
        statusMsg: 'Performing optimally',
        lastTrained: '2h ago',
        datasetSize: '14k samples'
      },
      {
        id: 'energy-model',
        name: 'Energy Load Forecast',
        version: 'v1.8.0',
        featureLabel: (<>⚡ Energy</>),
        modelType: 'GPR',
        inputs: ['Occupancy', 'Schedule', 'Temp Diff'],
        accuracy: 89.5,
        accuracyTrend: [88, 89, 88.5, 89.0, 89.2, 89.5],
        rmse: 12.4, mae: 8.7,
        status: 'optimized',
        statusMsg: 'New data available (+2k)',
        lastTrained: '4h ago',
        datasetSize: '12k samples'
      },
      {
        id: 'occ-model',
        name: 'Occupancy Flow',
        version: 'v3.0.0',
        featureLabel: (<>👥 Occ</>),
        modelType: 'LinReg',
        inputs: ['Time', 'DayType', 'Access Logs'],
        accuracy: 82.1,
        accuracyTrend: [81, 80, 81.5, 82.0, 82.1, 81.2],
        rmse: 4.2, mae: 3.1,
        status: 'drift-detected',
        statusMsg: 'Accuracy dropped -1.2%',
        lastTrained: '1d ago',
        datasetSize: '5k samples'
      }
    ]);

    setFeatureImportance([
      { name: 'Outdoor Temp', impact: 0.85, correlation: 'positive' },
      { name: 'Solar Irradiance', impact: 0.65, correlation: 'positive' },
      { name: 'Occupancy Count', impact: 0.45, correlation: 'positive' },
      { name: 'Wind Speed', impact: 0.25, correlation: 'negative' },
    ]);
  }, []);

  // --- Handlers ---

  const handleRetrain = (modelId: string) => {
    setProcessModels(prev => prev.map(m => {
      if (m.id === modelId) {
        return {
          ...m,
          status: 'training',
          trainingState: {
            isTraining: true,
            progress: 0,
            currentEpoch: 0,
            totalEpochs: 100,
            currentLoss: 0.5,
            timeRemaining: '45s'
          }
        };
      }
      return m;
    }));

    // Mock progress loop
    let progress = 0;
    const interval = setInterval(() => {
      progress += 5;
      setProcessModels(prev => prev.map(m => {
        if (m.id === modelId && m.status === 'training' && m.trainingState) {
          if (progress >= 100) {
            clearInterval(interval);
            return { 
                ...m, 
                status: 'active', 
                statusMsg: 'Retrained just now',
                accuracy: m.accuracy + 0.5,
                version: `v${parseFloat(m.version.slice(1)) + 0.1}`,
                trainingState: undefined 
            };
          }
          return {
            ...m,
            trainingState: {
              ...m.trainingState,
              progress: progress,
              currentEpoch: Math.floor(progress),
              currentLoss: Math.max(0.1, m.trainingState.currentLoss - 0.02)
            }
          };
        }
        return m;
      }));
    }, 200);
  };

  const startIngestion = () => {
    setIngestProgress(0);
    const interval = setInterval(() => {
        setIngestProgress(prev => {
            if (prev >= 100) {
                clearInterval(interval);
                setTimeout(() => setShowIngestModal(false), 500);
                return 100;
            }
            return prev + 10;
        });
    }, 200);
  };

  return (
    <div className="forecast-container">
      <Topbar title="Prediction Engine" subtitle="Model Training & Evaluation" />
      
      <MainContent
        sidebar={
          <RightSidebar width="340px">
            <SidebarSection title="Input Feature Impact" className="feature-section">
                <div className="correlation-chart">
                    {featureImportance.map((f, i) => (
                        <div key={i} className="corr-row">
                            <span className="f-name">{f.name}</span>
                            <div className="f-bar-track">
                                <div className={`f-bar ${f.correlation}`} style={{width: `${f.impact * 100}%`}} />
                            </div>
                            <span className="f-val">{(f.impact).toFixed(2)}</span>
                        </div>
                    ))}
                </div>
            </SidebarSection>
            
            <SidebarSection title="Training Log" noBorder>
              <div className="history-timeline">
                  <div className="timeline-item">
                    <div className="timeline-dot success" />
                    <div className="timeline-content">
                      <div className="header"><span className="trigger">Scheduled Auto-Tune</span><span className="date">03:00</span></div>
                      <div className="details"><span className="models-chip">3 Models</span><span className="duration">Success (12m)</span></div>
                    </div>
                  </div>
                  <div className="timeline-item">
                    <div className="timeline-dot warning" />
                    <div className="timeline-content">
                      <div className="header"><span className="trigger">Drift Alert</span><span className="date">Yesterday</span></div>
                      <div className="details"><span className="models-chip">Occupancy</span><span className="duration">RMSE degraded &gt; 5%</span></div>
                    </div>
                  </div>
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
                    <button className={timeRange === '7d' ? 'active' : ''} onClick={() => setTimeRange('7d')}>7 Days</button>
                    <button className={timeRange === '30d' ? 'active' : ''} onClick={() => setTimeRange('30d')}>30 Days</button>
                </div>
            </div>

            <div className="data-kpi-row">
                {/* ... (Existing KPI Cards) ... */}
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
                            className={`model-card ${activeModelId === model.id ? 'active' : ''} ${model.status === 'training' ? 'training-mode' : ''}`}
                            onClick={() => model.status !== 'training' && setActiveModelId(model.id)}
                        >
                            {/* NORMAL VIEW */}
                            {model.status !== 'training' && (
                                <>
                                    <div className="card-header">
                                        <div className="title-group">
                                            <div className="model-icon">{model.featureLabel}</div>
                                            <div className="title-text">
                                                <h3>{model.name}</h3>
                                                <div className="meta-row">
                                                    <span className="version">{model.version}</span>
                                                    <span className="sep">•</span>
                                                    <span className="last-run">{model.lastTrained}</span>
                                                </div>
                                            </div>
                                        </div>
                                        <span className={`status-badge ${model.status}`}>
                                            {model.status === 'drift-detected' ? '⚠️ Drift' : model.status === 'optimized' ? '✨ Ready' : 'Active'}
                                        </span>
                                    </div>
                                    
                                    <div className="card-body">
                                        <div className="insight-message">{model.statusMsg}</div>
                                        <div className="metric-row">
                                            <div className="main-metric">
                                                <span className="val">{model.accuracy}%</span>
                                                <span className="label">Accuracy</span>
                                            </div>
                                            <div className="sparkline-container">
                                                <ResponsiveContainer width="100%" height={32}>
                                                    <AreaChart data={model.accuracyTrend.map((v, i) => ({v, i}))}>
                                                        <defs><linearGradient id={`grad${model.id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#10b981" stopOpacity={0.3}/><stop offset="100%" stopColor="#10b981" stopOpacity={0}/></linearGradient></defs>
                                                        <Area type="monotone" dataKey="v" stroke="#10b981" strokeWidth={2} fill={`url(#grad${model.id})`} />
                                                    </AreaChart>
                                                </ResponsiveContainer>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="card-actions-footer">
                                        <button 
                                            className="btn btn-primary btn-sm"
                                            onClick={(e) => { e.stopPropagation(); handleRetrain(model.id); }}
                                        >
                                            Retrain
                                        </button>
                                        <button 
                                            className="btn btn-secondary btn-sm"
                                            onClick={(e) => { e.stopPropagation(); setInspectingModel(model); }}
                                        >
                                            Inspect
                                        </button>
                                    </div>
                                </>
                            )}

                            {/* TRAINING VIEW */}
                            {model.status === 'training' && model.trainingState && (
                                <div className="training-overlay-content">
                                    <div className="training-header">
                                        <div className="spinner"></div>
                                        <span>Training {model.version}...</span>
                                    </div>
                                    <div className="progress-section">
                                        <div className="progress-bar-track">
                                            <div className="progress-bar-fill" style={{width: `${model.trainingState.progress}%`}}></div>
                                        </div>
                                        <div className="progress-stats">
                                            <span>Epoch {model.trainingState.currentEpoch}/{model.trainingState.totalEpochs}</span>
                                            <span>{model.trainingState.timeRemaining}</span>
                                        </div>
                                    </div>
                                    <div className="live-metrics">
                                        <div className="lm-item">
                                            <span className="lbl">Loss</span>
                                            <span className="val">{model.trainingState.currentLoss.toFixed(4)}</span>
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
                        <AreaChart data={Array.from({length: 24}).map((_, i) => ({
                            hour: i,
                            actual: i < 18 ? Math.sin(i/4)*10 + 20 + Math.random() : null,
                            predicted: Math.sin(i/4)*10 + 20,
                            conf_high: Math.sin(i/4)*10 + 22,
                            conf_low: Math.sin(i/4)*10 + 18,
                        }))} margin={{top: 10, right: 0, left: 0, bottom: 0}}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                            <XAxis dataKey="hour" stroke="rgba(255,255,255,0.3)" style={{fontSize: 10}} tickLine={false} />
                            <Tooltip contentStyle={{backgroundColor: '#0b0d12', border: '1px solid #333'}} />
                            <ReferenceLine x={18} stroke="#ef4444" strokeDasharray="3 3" label={{value: "NOW", position: "insideTopLeft", fill: "#ef4444", fontSize: 10}} />
                            <Area type="monotone" dataKey="conf_high" stroke="none" fill="rgba(139, 92, 246, 0.1)" />
                            <Line type="monotone" dataKey="predicted" stroke="#8b5cf6" strokeWidth={2} dot={false} strokeDasharray="5 5" />
                            <Line type="monotone" dataKey="actual" stroke="#3b82f6" strokeWidth={3} dot={{r: 3}} />
                        </AreaChart>
                    </ResponsiveContainer>
                 </div>
            </Section>
        </ContentArea>
      </MainContent>

      {/* --- MODALS --- */}
      
      {/* 1. Ingest Data Modal */}
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
                              <button className="source-btn" onClick={startIngestion}>
                                  <span className="icon">📄</span>
                                  <div className="text">
                                      <span className="title">CSV Upload</span>
                                      <span className="desc">Manual file upload</span>
                                  </div>
                              </button>
                              <button className="source-btn" onClick={startIngestion}>
                                  <span className="icon">🗄️</span>
                                  <div className="text">
                                      <span className="title">SQL Database</span>
                                      <span className="desc">Connect via JDBC</span>
                                  </div>
                              </button>
                              <button className="source-btn" onClick={startIngestion}>
                                  <span className="icon">☁️</span>
                                  <div className="text">
                                      <span className="title">IoT Stream</span>
                                      <span className="desc">MQTT / Kafka</span>
                                  </div>
                              </button>
                          </div>
                      ) : (
                          <div className="ingest-progress">
                              <div className="spinner-large"></div>
                              <h4>Ingesting Data...</h4>
                              <div className="progress-bar-track">
                                  <div className="progress-bar-fill" style={{width: `${ingestProgress}%`}}></div>
                              </div>
                              <span className="status-text">{ingestProgress}% Complete</span>
                          </div>
                      )}
                  </div>
              </div>
          </div>
      )}

      {/* 2. Inspect Model Modal */}
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
                                  <div className="row"><span>R² Score</span><strong>0.94</strong></div>
                                  <div className="row"><span>Training Time</span><strong>45 mins</strong></div>
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
                                      <ScatterChart margin={{top: 10, right: 10, bottom: 10, left: 0}}>
                                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                                          <XAxis type="number" dataKey="x" name="Actual" unit="°C" stroke="#888" fontSize={10} />
                                          <YAxis type="number" dataKey="y" name="Predicted" unit="°C" stroke="#888" fontSize={10} />
                                          <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{backgroundColor: '#000', border: '1px solid #333'}} />
                                          <Scatter name="Validation" data={Array.from({length: 50}).map(() => {
                                              const val = 20 + Math.random() * 10;
                                              return { x: val, y: val + (Math.random() - 0.5) * 2 };
                                          })} fill="#8884d8" />
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
