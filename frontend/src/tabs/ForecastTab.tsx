import React, { useState, useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
  ReferenceLine,
} from "recharts";
import "./ForecastTab.scss";
import Topbar from "./components/Topbar";

// ... [Interfaces preserved] ...
interface PredictionData {
  timestamp: string;
  fullTimestamp: Date;
  actual?: number;
  predicted: number;
  confidence_lower: number;
  confidence_upper: number;
  type: 'historical' | 'forecast';
}

interface Model {
  id: string;
  name: string;
  type: string;
  accuracy: number;
  status: 'trained' | 'training' | 'idle';
  lastTrained: Date;
  trainingProgress?: number;
}

interface TrainingConfig {
  metric: string;
  epochs: number;
  batchSize: number;
  learningRate: number;
  autoRetrain: boolean;
  retrainInterval: number;
}

const ForecastTab = () => {
  const [selectedMetric, setSelectedMetric] = useState<string>("temperature");
  const [forecastHorizon, setForecastHorizon] = useState<number>(24);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [predictionData, setPredictionData] = useState<PredictionData[]>([]);
  const [isTraining, setIsTraining] = useState<boolean>(false);
  const [showTrainingModal, setShowTrainingModal] = useState<boolean>(false);
  const [trainingConfig, setTrainingConfig] = useState<TrainingConfig>({
    metric: "temperature",
    epochs: 100,
    batchSize: 32,
    learningRate: 0.001,
    autoRetrain: false,
    retrainInterval: 24,
  });

  const metrics = [
    { label: "Temp", value: "temperature", icon: "", unit: "°C" },
    { label: "Occupancy", value: "occupancy", icon: "", unit: "Ppl" },
    { label: "Energy", value: "energy", icon: "", unit: "kWh" },
    { label: "Air Qual", value: "airquality", icon: "", unit: "AQI" },
  ];

  const horizonOptions = [
    { label: "6H", value: 6 },
    { label: "12H", value: 12 },
    { label: "24H", value: 24 },
    { label: "48H", value: 48 },
    { label: "7D", value: 168 },
    { label: "1M", value: 1 },
    { label: "3M", value: 2 },
    { label: "1Y", value: 3 },
  ];

  useEffect(() => {
    const initialModels: Model[] = [
      { id: "lstm-001", name: "Linear Regression", type: "Regression", accuracy: 94.2, status: "trained", lastTrained: new Date(Date.now() - 86400000 * 2) },
      { id: "transformer-001", name: "Neural Network", type: "Attention-Based", accuracy: 95.6, status: "trained", lastTrained: new Date(Date.now() - 86400000 * 1) },
      { id: "gru-001", name: "Gaussian Processes", type: "Statistical", accuracy: 92.8, status: "trained", lastTrained: new Date(Date.now() - 86400000 * 5) },
      { id: "arima-001", name: "ARIMA Statistical", type: "Statistical", accuracy: 87.3, status: "trained", lastTrained: new Date(Date.now() - 86400000 * 7) },
    ];
    setModels(initialModels);
    setSelectedModel(initialModels[1].id);
  }, []);

  useEffect(() => {
    if (!selectedModel) return;
    const model = models.find((m) => m.id === selectedModel);
    if (!model) return;

    const data: PredictionData[] = [];
    const now = new Date();
    const msPerInterval = 900000;
    const historicalPoints = 48;
    const forecastPoints = (forecastHorizon * 60) / 15;

    for (let i = historicalPoints; i > 0; i--) {
      const timestamp = new Date(now.getTime() - i * msPerInterval);
      const baseValue = 22 + Math.sin((i / 10)) * 3;
      const actual = baseValue + (Math.random() - 0.5) * 2;
      data.push({
        timestamp: timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        fullTimestamp: timestamp,
        actual: actual,
        predicted: actual + (Math.random() - 0.5) * 0.5,
        confidence_lower: actual - 1,
        confidence_upper: actual + 1,
        type: 'historical',
      });
    }

    for (let i = 1; i <= forecastPoints; i++) {
      const timestamp = new Date(now.getTime() + i * msPerInterval);
      const baseValue = 22 + Math.sin((i / 10)) * 3;
      const uncertainty = 0.5 + (i / forecastPoints) * 1.5;
      const predicted = baseValue + (Math.random() - 0.5) * 0.5;
      data.push({
        timestamp: timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        fullTimestamp: timestamp,
        predicted: predicted,
        confidence_lower: predicted - uncertainty,
        confidence_upper: predicted + uncertainty,
        type: 'forecast',
      });
    }
    setPredictionData(data);
  }, [selectedModel, forecastHorizon, models]);

  const handleTrainModel = (modelId: string) => {
    setModels((prev) => prev.map((m) => m.id === modelId ? { ...m, status: "training", trainingProgress: 0 } : m));
    setIsTraining(true);
    let progress = 0;
    const interval = setInterval(() => {
      progress += Math.random() * 15;
      if (progress >= 100) {
        progress = 100;
        clearInterval(interval);
        setModels((prev) => prev.map((m) => m.id === modelId ? { ...m, status: "trained", trainingProgress: undefined, lastTrained: new Date(), accuracy: 90 + Math.random() * 8 } : m));
        setIsTraining(false);
      } else {
        setModels((prev) => prev.map((m) => m.id === modelId ? { ...m, trainingProgress: progress } : m));
      }
    }, 500);
  };

  const getAccuracyColor = (accuracy: number) => {
    if (accuracy >= 93) return "#10b981";
    if (accuracy >= 88) return "#f59e0b";
    return "#ef4444";
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const isHistorical = payload[0]?.payload?.type === 'historical';
      return (
        <div className="custom-tooltip">
          <p className="tooltip-label">{label}</p>
          {isHistorical && payload[0]?.payload?.actual !== undefined && (
            <div className="tooltip-row">
              <span style={{ color: "#3b82f6" }}>Actual:</span>
              <span className="val" style={{ color: "#fff" }}>{payload[0].payload.actual.toFixed(2)}</span>
            </div>
          )}
          {payload.map((entry: any, index: number) => {
             if (entry.dataKey === 'predicted') return (
              <div key={index} className="tooltip-row">
                <span style={{ color: "#8b5cf6" }}>Predicted:</span>
                <span className="val" style={{ color: "#fff" }}>{entry.value.toFixed(2)}</span>
              </div>
            );
            return null;
          })}
          {payload[0]?.payload?.confidence_lower && (
            <div className="tooltip-row">
               <span style={{ color: "rgba(255,255,255,0.5)" }}>Range:</span>
               <span className="val" style={{ color: "rgba(255,255,255,0.5)" }}>
                 {payload[0].payload.confidence_lower.toFixed(1)} - {payload[0].payload.confidence_upper.toFixed(1)}
               </span>
            </div>
          )}
          <span className={`badge ${isHistorical ? 'historical' : 'forecast'}`}>
            {isHistorical ? 'Historical Data' : 'AI Forecast'}
          </span>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="forecast-container">
      <Topbar 
        title="Predictive Analytics"
        subtitle="AI Model Training & Future Casting"
        rightContent={
          <>
            <button className="topbar-btn"><span></span> Export CSV</button>
            <button className="topbar-btn primary" onClick={()  => setShowTrainingModal(true)} disabled={isTraining}>
              <span></span> Train New Model
              <span></span> Set new Schedule for Training (LinAlg)
            </button>
          </>
        }
      />

      <div className="forecast-dashboard">
        
        <div className="visualization-stage">
          <div className="kpi-strip">
             <div className="kpi-box"><div className="icon-box" style={{color: '#8b5cf6'}}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8l16 0" strokeWidth="1.5" strokeOpacity="0.4" /><path d="M2 12h20" /><path d="M4 16l16 0" strokeWidth="1.5" strokeOpacity="0.4" /></svg></div><div className="kpi-content"><span className="label">Forecast Avg</span><span className="value">23.4°C</span></div></div>
             <div className="kpi-box"><div className="icon-box" style={{color: '#f59e0b'}}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M3 19L11 11" /><path d="M15 7L16 6" /><path d="M20 2L21 1" /></svg></div><div className="kpi-content"><span className="label">Uncertainty</span><span className="value">±1.2°C</span></div></div>
             <div className="kpi-box"><div className="icon-box" style={{color: '#10b981'}}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="9" /></svg></div><div className="kpi-content"><span className="label">Model Confidence</span><span className="value">High</span></div></div>
          </div>

          <div className="chart-card">
            <div className="chart-header">
              <div className="title-group">
                <h2>{metrics.find(m => m.value === selectedMetric)?.label} Projection</h2>
                <p>Model: {models.find(m => m.id === selectedModel)?.name} | Horizon: {forecastHorizon} Hours</p>
              </div>
              <div className="legend-group">
                <div className="legend-item"><div className="line" style={{background: '#3b82f6'}}></div><span>Historical</span></div>
                <div className="legend-item"><div className="line" style={{background: '#8b5cf6', borderStyle: 'dashed'}}></div><span>Forecast</span></div>
                <div className="legend-item"><div className="area" style={{background: '#8b5cf6'}}></div><span>Confidence</span></div>
              </div>
            </div>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={predictionData}>
                <defs>
                  <linearGradient id="confidence" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} /><stop offset="95%" stopColor="#8b5cf6" stopOpacity={0.05} /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="timestamp" stroke="rgba(255,255,255,0.3)" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={30} />
                <YAxis stroke="rgba(255,255,255,0.3)" tick={{ fontSize: 10 }} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="confidence_upper" stroke="none" fill="url(#confidence)" fillOpacity={1} stackId="confidence" />
                <Area type="monotone" dataKey="confidence_lower" stroke="none" fill="#1e222d" fillOpacity={1} stackId="confidence" />
                <Line type="monotone" dataKey="actual" stroke="#3b82f6" strokeWidth={2} dot={false} connectNulls />
                <Line type="monotone" dataKey="predicted" stroke="#8b5cf6" strokeWidth={2} strokeDasharray="5 5" dot={false} />
                <ReferenceLine x={predictionData[48]?.timestamp} stroke="#ef4444" strokeDasharray="3 3" label={{ value: "NOW", fill: "#ef4444", fontSize: 10, position: "top" }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="config-sidebar">
          <div className="sidebar-section">
            <div className="section-title"><span>Forecast Settings</span><span></span></div>
            <div style={{marginBottom: '16px'}}>
               <label style={{fontSize:'11px', color:'rgba(255,255,255,0.4)', display:'block', marginBottom:'8px'}}>TARGET METRIC</label>
               <div className="pill-grid">
                {metrics.map((metric) => (<button key={metric.value} className={`pill-btn ${selectedMetric === metric.value ? "active" : ""}`} onClick={() => setSelectedMetric(metric.value)}>{metric.icon} {metric.label}</button>))}
              </div>
            </div>
            <div>
               <label style={{fontSize:'11px', color:'rgba(255,255,255,0.4)', display:'block', marginBottom:'8px'}}>TIME HORIZON</label>
               <div className="pill-grid">
                {horizonOptions.map((option) => (<button key={option.value} className={`pill-btn ${forecastHorizon === option.value ? "active" : ""}`} onClick={() => setForecastHorizon(option.value)}>{option.label}</button>))}
              </div>
            </div>
          </div>

          <div className="sidebar-section" style={{flex: 1, borderBottom: 'none'}}>
            <div className="section-title"><span>Model Registry</span><span></span></div>
            <div className="model-list">
              {models.map((model) => (
                <div key={model.id} className={`model-item ${selectedModel === model.id ? "active" : ""}`} onClick={() => model.status !== "training" && setSelectedModel(model.id)}>
                  <div className="model-header"><span className="model-name">{model.name}</span><span className="accuracy" style={{color: getAccuracyColor(model.accuracy)}}>{model.accuracy.toFixed(1)}%</span></div>
                  <div className="model-meta"><span>{model.type}</span><span className={`badge ${model.status}`}>{model.status === 'training' ? `Training ${model.trainingProgress?.toFixed(0)}%` : model.status}</span></div>
                  {model.status === 'training' && (<div className="training-bar"><div className="fill" style={{width: `${model.trainingProgress}%`}} /></div>)}
                  {selectedModel === model.id && model.status !== 'training' && (<div className="actions-overlay"><button onClick={(e) => { e.stopPropagation(); handleTrainModel(model.id); }}>⚡ Retrain Model</button></div>)}
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>

      {showTrainingModal && (
        <div className="modal-overlay" onClick={() => setShowTrainingModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><h2>Configure Training Run</h2><button className="close-btn" onClick={() => setShowTrainingModal(false)}>×</button></div>
            <div className="modal-body">
              <div className="config-group"><label>Target Metric</label><select value={trainingConfig.metric} onChange={(e) => setTrainingConfig({ ...trainingConfig, metric: e.target.value })}>{metrics.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></div>
              <div className="config-group"><label>Epochs <span className="val">{trainingConfig.epochs}</span></label><input type="range" min="10" max="500" step="10" value={trainingConfig.epochs} onChange={(e) => setTrainingConfig({ ...trainingConfig, epochs: parseInt(e.target.value) })} /></div>
              <div className="config-group"><label>Batch Size <span className="val">{trainingConfig.batchSize}</span></label><input type="range" min="8" max="128" step="8" value={trainingConfig.batchSize} onChange={(e) => setTrainingConfig({ ...trainingConfig, batchSize: parseInt(e.target.value) })} /></div>
              <div className="config-group"><label className="checkbox-row"><input type="checkbox" checked={trainingConfig.autoRetrain} onChange={(e) => setTrainingConfig({ ...trainingConfig, autoRetrain: e.target.checked })} /><span>Enable Auto-Retraining (Drift Detection)</span></label></div>
            </div>
            <div className="modal-footer"><button className="cancel" onClick={() => setShowTrainingModal(false)}>Cancel</button><button className="confirm" onClick={() => { setShowTrainingModal(false); }}>Start Training Session</button></div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ForecastTab;
