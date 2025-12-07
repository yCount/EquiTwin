import React, { useState, useEffect, ReactNode } from "react";
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
  Bar,
  BarChart,
} from "recharts";
import "./ForecastTab.scss";
import Topbar from "./components/Topbar";

// ============================================================================
// INTERFACES
// ============================================================================

interface ProcessModel {
  id: string;
  name: string;
  feature: 'temperature' | 'airquality' | 'energy';
  featureLabel: ReactNode;
  modelType: 'ANN' | 'GPR' | 'LinReg';
  accuracy: number;
  rmse: number;
  mae: number;
  r2: number;
  status: 'trained' | 'training' | 'pending' | 'error';
  lastTrained: Date | null;
  trainingProgress?: number;
  samples: number;
  selected: boolean;
}

interface Forecaster {
  id: string;
  name: string;
  type: 'occupancy' | 'weather';
  mode: 'schedule' | 'ml' | 'api' | 'hybrid';
  accuracy: number;
  status: 'ready' | 'training' | 'disconnected';
  lastUpdated: Date;
}

interface DataCollectionStatus {
  totalSamples: number;
  targetSamples: number;
  startDate: Date;
  variables: {
    name: string;
    samples: number;
    status: 'good' | 'warning' | 'error';
  }[];
  samplingInterval: number;
}

interface TrainingConfig {
  autoRetrain: boolean;
  frequency: 'daily' | 'weekly' | 'monthly';
  time: string;
  triggers: {
    accuracyDrop: boolean;
    accuracyThreshold: number;
    newData: boolean;
    newDataThreshold: number;
    driftDetection: boolean;
  };
}

interface TrainingHistoryItem {
  date: Date;
  trigger: string;
  duration: number;
  result: 'success' | 'failed';
  modelsUpdated: string[];
}

interface PredictionData {
  timestamp: string;
  fullTimestamp: Date;
  actual?: number;
  predicted: number;
  confidence_lower: number;
  confidence_upper: number;
  type: 'historical' | 'forecast';
}

// ============================================================================
// COMPONENT
// ============================================================================

const ForecastTab: React.FC = () => {
  // --- State ---
  const [processModels, setProcessModels] = useState<ProcessModel[]>([]);
  const [forecasters, setForecasters] = useState<Forecaster[]>([]);
  const [dataStatus, setDataStatus] = useState<DataCollectionStatus | null>(null);
  const [trainingConfig, setTrainingConfig] = useState<TrainingConfig>({
    autoRetrain: true,
    frequency: 'weekly',
    time: '03:00',
    triggers: {
      accuracyDrop: true,
      accuracyThreshold: 80,
      newData: true,
      newDataThreshold: 2000,
      driftDetection: true,
    },
  });
  const [trainingHistory, setTrainingHistory] = useState<TrainingHistoryItem[]>([]);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [showTrainingModal, setShowTrainingModal] = useState<boolean>(false);
  const [selectedFeature, setSelectedFeature] = useState<string>('temperature');
  const [predictionData, setPredictionData] = useState<PredictionData[]>([]);
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const [isRetrainingAll, setIsRetrainingAll] = useState<boolean>(false);

  // --- Initialize Data ---
  useEffect(() => {
    // Process Models (one per controlled feature)
    const initialModels: ProcessModel[] = [
      {
        id: 'temp-model',
        name: 'Indoor Temperature',
        feature: 'temperature',
        featureLabel: (
        <>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg> Temperature
        </>),
        modelType: 'ANN',
        accuracy: 94.2,
        rmse: 0.38,
        mae: 0.27,
        r2: 0.94,
        status: 'trained',
        lastTrained: new Date(Date.now() - 2 * 3600000),
        samples: 12847,
        selected: true,
      },
      {
        id: 'aq-model',
        name: 'Air Quality (CO₂)',
        feature: 'airquality',
        featureLabel: (
          <>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 8h14.5a2.5 2.5 0 0 1 0 5H14" /><path d="M6 16h13.5a2.5 2.5 0 0 0 0-5H19" /><path d="M2 12h5" /><path d="M16 8V7" /></svg> Air Quality
          </>),
        modelType: 'LinReg',
        accuracy: 89.1,
        rmse: 45.2,
        mae: 32.1,
        r2: 0.89,
        status: 'trained',
        lastTrained: new Date(Date.now() - 2 * 3600000),
        samples: 12801,
        selected: true,
      },
      {
        id: 'energy-model',
        name: 'Energy Consumption',
        feature: 'energy',
        featureLabel: (
          <>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg> Energy
          </>),
        modelType: 'LinReg',
        accuracy: 91.3,
        rmse: 12.4,
        mae: 8.7,
        r2: 0.91,
        status: 'trained',
        lastTrained: new Date(Date.now() - 2 * 3600000),
        samples: 12847,
        selected: true,
      },
    ];
    setProcessModels(initialModels);

    // Forecasters (disturbance predictors)
    const initialForecasters: Forecaster[] = [
      {
        id: 'occ-forecaster',
        name: 'Occupancy Forecaster',
        type: 'occupancy',
        mode: 'ml',
        accuracy: 87.3,
        status: 'ready',
        lastUpdated: new Date(Date.now() - 3600000),
      },
      {
        id: 'weather-forecaster',
        name: 'Weather Forecaster',
        type: 'weather',
        mode: 'api',
        accuracy: 92.1,
        status: 'ready',
        lastUpdated: new Date(Date.now() - 1800000),
      },
    ];
    setForecasters(initialForecasters);

    // Data Collection Status
    setDataStatus({
      totalSamples: 12847,
      targetSamples: 20000,
      startDate: new Date('2025-11-15'),
      variables: [
        { name: 'Temperature', samples: 12847, status: 'good' },
        { name: 'Occupancy', samples: 12801, status: 'good' },
        { name: 'Energy', samples: 12847, status: 'good' },
        { name: 'Weather', samples: 12832, status: 'good' },
      ],
      samplingInterval: 15,
    });

    // Training History
    setTrainingHistory([
      { date: new Date(Date.now() - 2 * 3600000), trigger: 'Scheduled', duration: 4, result: 'success', modelsUpdated: ['Temperature', 'Air Quality', 'Energy'] },
      { date: new Date(Date.now() - 7 * 24 * 3600000), trigger: 'Scheduled', duration: 5, result: 'success', modelsUpdated: ['Temperature', 'Air Quality', 'Energy'] },
      { date: new Date(Date.now() - 9 * 24 * 3600000), trigger: 'Accuracy Drop', duration: 3, result: 'success', modelsUpdated: ['Temperature'] },
      { date: new Date(Date.now() - 14 * 24 * 3600000), trigger: 'Scheduled', duration: 4, result: 'success', modelsUpdated: ['Temperature', 'Air Quality', 'Energy'] },
    ]);
  }, []);

  // --- Generate Prediction Data ---
  useEffect(() => {
    const selectedModel = processModels.find(m => m.feature === selectedFeature);
    if (!selectedModel) return;

    const data: PredictionData[] = [];
    const now = new Date();
    const msPerInterval = 900000; // 15 min
    const historicalPoints = 48;
    const forecastPoints = 48;

    // Historical data
    for (let i = historicalPoints; i > 0; i--) {
      const timestamp = new Date(now.getTime() - i * msPerInterval);
      const baseValue = selectedFeature === 'temperature' ? 22 : selectedFeature === 'energy' ? 50 : 600;
      const variance = selectedFeature === 'temperature' ? 3 : selectedFeature === 'energy' ? 20 : 200;
      const actual = baseValue + Math.sin(i / 10) * variance + (Math.random() - 0.5) * (variance * 0.3);
      
      data.push({
        timestamp: timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        fullTimestamp: timestamp,
        actual,
        predicted: actual + (Math.random() - 0.5) * (variance * 0.1),
        confidence_lower: actual - variance * 0.2,
        confidence_upper: actual + variance * 0.2,
        type: 'historical',
      });
    }

    // Forecast data
    for (let i = 1; i <= forecastPoints; i++) {
      const timestamp = new Date(now.getTime() + i * msPerInterval);
      const baseValue = selectedFeature === 'temperature' ? 22 : selectedFeature === 'energy' ? 50 : 600;
      const variance = selectedFeature === 'temperature' ? 3 : selectedFeature === 'energy' ? 20 : 200;
      const uncertainty = 0.5 + (i / forecastPoints) * 1.5;
      const predicted = baseValue + Math.sin(i / 10) * variance + (Math.random() - 0.5) * (variance * 0.2);
      
      data.push({
        timestamp: timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        fullTimestamp: timestamp,
        predicted,
        confidence_lower: predicted - variance * 0.2 * uncertainty,
        confidence_upper: predicted + variance * 0.2 * uncertainty,
        type: 'forecast',
      });
    }

    setPredictionData(data);
  }, [selectedFeature, processModels]);

  // --- Handlers ---
  const handleRetrainModel = (modelId: string) => {
    setProcessModels(prev => prev.map(m => 
      m.id === modelId ? { ...m, status: 'training', trainingProgress: 0 } : m
    ));

    let progress = 0;
    const interval = setInterval(() => {
      progress += Math.random() * 15;
      if (progress >= 100) {
        clearInterval(interval);
        setProcessModels(prev => prev.map(m => 
          m.id === modelId ? {
            ...m,
            status: 'trained',
            trainingProgress: undefined,
            lastTrained: new Date(),
            accuracy: 88 + Math.random() * 10,
          } : m
        ));
      } else {
        setProcessModels(prev => prev.map(m => 
          m.id === modelId ? { ...m, trainingProgress: progress } : m
        ));
      }
    }, 200);
  };

  const handleRetrainAll = () => {
    setIsRetrainingAll(true);
    processModels.forEach((model, index) => {
      setTimeout(() => handleRetrainModel(model.id), index * 500);
    });
    setTimeout(() => setIsRetrainingAll(false), processModels.length * 3000);
  };

  const handleChangeModelType = (modelId: string, newType: 'ANN' | 'GPR' | 'LinReg') => {
    setProcessModels(prev => prev.map(m => 
      m.id === modelId ? { ...m, modelType: newType, status: 'pending' } : m
    ));
  };

  const getAccuracyColor = (accuracy: number): string => {
    if (accuracy >= 90) return '#10b981';
    if (accuracy >= 80) return '#f59e0b';
    return '#ef4444';
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'trained': case 'ready': return '#10b981';
      case 'training': return '#f59e0b';
      case 'pending': return '#3b82f6';
      case 'error': case 'disconnected': return '#ef4444';
      default: return '#6b7280';
    }
  };

  const getUnit = (feature: string): string => {
    switch (feature) {
      case 'temperature': return '°C';
      case 'airquality': return 'ppm';
      case 'energy': return 'kWh';
      default: return '';
    }
  };

  // --- Custom Tooltip ---
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const isHistorical = payload[0]?.payload?.type === 'historical';
      return (
        <div className="chart-tooltip-glass">
          <div className="tooltip-header">{label}</div>
          <div className="tooltip-body">
            {isHistorical && payload[0]?.payload?.actual !== undefined && (
              <div className="tooltip-row">
                <div className="row-left">
                  <div className="indicator" style={{ background: '#3b82f6' }} />
                  <span>Actual</span>
                </div>
                <div className="row-value">
                  {payload[0].payload.actual.toFixed(2)}
                  <span className="unit">{getUnit(selectedFeature)}</span>
                </div>
              </div>
            )}
            <div className="tooltip-row">
              <div className="row-left">
                <div className="indicator" style={{ background: '#8b5cf6' }} />
                <span>Predicted</span>
              </div>
              <div className="row-value">
                {payload[0]?.payload?.predicted?.toFixed(2)}
                <span className="unit">{getUnit(selectedFeature)}</span>
              </div>
            </div>
            <div className="tooltip-row">
              <div className="row-left">
                <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '11px' }}>Confidence</span>
              </div>
              <div className="row-value" style={{ color: 'rgba(255,255,255,0.5)', fontSize: '11px' }}>
                {payload[0]?.payload?.confidence_lower?.toFixed(1)} - {payload[0]?.payload?.confidence_upper?.toFixed(1)}
              </div>
            </div>
          </div>
          <div className={`tooltip-badge ${isHistorical ? 'historical' : 'forecast'}`}>
            {isHistorical ? 'Historical' : 'AI Forecast'}
          </div>
        </div>
      );
    }
    return null;
  };

  // --- Render ---
  return (
    <div className="forecast-container">
      <Topbar
        title="Predictive Models"
        subtitle="ML Model Training & Management"
        rightContent={
          <>
            <div className="topbar-status">
              <span className="status-dot online" />
              <span>All Models Ready</span>
            </div>
            <button 
              className="topbar-btn primary" 
              onClick={handleRetrainAll}
              disabled={isRetrainingAll}
            >
              {isRetrainingAll ? '⏳ Training...' : '🔄 Retrain All'}
            </button>
          </>
        }
      />

      <div className="forecast-dashboard">
        {/* === LEFT: Main Content === */}
        <div className="main-content">
          
          {/* Data Collection Status */}
          <section className="data-status-section">
            <div className="section-header">
              <h2>📊 Data Collection Status</h2>
              <span className="status-pill active">● Active</span>
            </div>
            
            {dataStatus && (
              <div className="data-status-content">
                <div className="progress-block">
                  <div className="progress-header">
                    <span className="samples-count">{dataStatus.totalSamples.toLocaleString()}</span>
                    <span className="samples-target">/ {dataStatus.targetSamples.toLocaleString()} samples</span>
                  </div>
                  <div className="progress-bar">
                    <div 
                      className="progress-fill" 
                      style={{ width: `${(dataStatus.totalSamples / dataStatus.targetSamples) * 100}%` }}
                    />
                  </div>
                  <p className="progress-hint">
                    ℹ️ Recommended: {dataStatus.targetSamples.toLocaleString()} samples for optimal model performance
                  </p>
                </div>

                <div className="variables-grid">
                  {dataStatus.variables.map(v => (
                    <div key={v.name} className={`variable-card ${v.status}`}>
                      <span className="var-name">{v.name}</span>
                      <span className="var-samples">{v.samples.toLocaleString()} ✓</span>
                    </div>
                  ))}
                </div>

                <div className="data-meta">
                  <span>Sampling: Every {dataStatus.samplingInterval} min</span>
                  <span>Since: {dataStatus.startDate.toLocaleDateString()}</span>
                </div>
              </div>
            )}
          </section>

          {/* Process Models */}
          <section className="models-section">
            <div className="section-header">
              <h2>Process Models</h2>
              <span className="section-subtitle">Predict how the building responds to HVAC actions</span>
            </div>

            <div className="models-grid">
              {processModels.map(model => (
                <div 
                  key={model.id} 
                  className={`model-card ${expandedModel === model.id ? 'expanded' : ''} ${model.status}`}
                  onClick={() => setExpandedModel(expandedModel === model.id ? null : model.id)}
                >
                  <div className="model-card-header">
                    <div className="model-title">
                      <span className="feature-label">{model.featureLabel}</span>
                      <span className={`status-badge ${model.status}`}>
                        {model.status === 'training' ? `Training ${model.trainingProgress?.toFixed(0)}%` : model.status}
                      </span>
                    </div>
                    <div className="accuracy-badge" style={{ color: getAccuracyColor(model.accuracy) }}>
                      {model.accuracy.toFixed(1)}%
                    </div>
                  </div>

                  {model.status === 'training' && (
                    <div className="training-progress">
                      <div className="progress-fill" style={{ width: `${model.trainingProgress}%` }} />
                    </div>
                  )}

                  <div className="model-metrics">
                    <div className="metric">
                      <span className="metric-label">Model</span>
                      <span className="metric-value">{model.modelType}</span>
                    </div>
                    <div className="metric">
                      <span className="metric-label">RMSE</span>
                      <span className="metric-value">{model.rmse.toFixed(2)}</span>
                    </div>
                    <div className="metric">
                      <span className="metric-label">R²</span>
                      <span className="metric-value">{model.r2.toFixed(2)}</span>
                    </div>
                  </div>

                  {expandedModel === model.id && (
                    <div className="model-expanded" onClick={e => e.stopPropagation()}>
                      <div className="comparison-table">
                        <div className="table-header">
                          <span>Model Type</span>
                          <span>RMSE</span>
                          <span>MAE</span>
                          <span>R²</span>
                          <span></span>
                        </div>
                        {['ANN', 'GPR', 'LinReg'].map(type => (
                          <div 
                            key={type} 
                            className={`table-row ${model.modelType === type ? 'selected' : ''}`}
                            onClick={() => handleChangeModelType(model.id, type as any)}
                          >
                            <span className="type-name">{type}</span>
                            <span>{(model.rmse * (type === 'ANN' ? 1 : type === 'GPR' ? 1.15 : 1.4)).toFixed(2)}</span>
                            <span>{(model.mae * (type === 'ANN' ? 1 : type === 'GPR' ? 1.1 : 1.35)).toFixed(2)}</span>
                            <span>{(model.r2 * (type === 'ANN' ? 1 : type === 'GPR' ? 0.97 : 0.91)).toFixed(2)}</span>
                            <span>{model.modelType === type ? '✓ Active' : ''}</span>
                          </div>
                        ))}
                      </div>
                      
                      <div className="model-actions">
                        <button 
                          className="action-btn"
                          onClick={() => handleRetrainModel(model.id)}
                          disabled={model.status === 'training'}
                        >
                          🔄 Retrain
                        </button>
                        <button 
                          className="action-btn secondary"
                          onClick={() => setSelectedFeature(model.feature)}
                        >
                          📈 View Predictions
                        </button>
                      </div>

                      <div className="model-meta">
                        <span>Last trained: {model.lastTrained?.toLocaleString() || 'Never'}</span>
                        <span>Samples: {model.samples.toLocaleString()}</span>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Forecasters */}
          <section className="forecasters-section">
            <div className="section-header">
              <h2>📈 Forecasters</h2>
              <span className="section-subtitle">Predict future disturbances (external factors)</span>
            </div>

            <div className="forecasters-grid">
              {forecasters.map(forecaster => (
                <div key={forecaster.id} className={`forecaster-card ${forecaster.type}`}>
                  <div className="forecaster-header">
                    <span className="forecaster-icon">
                      {forecaster.type === 'occupancy' ? <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> : '🌤️'}
                    </span>
                    <div className="forecaster-title">
                      <h3>{forecaster.name}</h3>
                      <span className={`status-indicator ${forecaster.status}`}>
                        {forecaster.status === 'ready' ? '● Ready' : forecaster.status}
                      </span>
                    </div>
                  </div>

                  <div className="forecaster-config">
                    <div className="config-row">
                      <span className="config-label">Mode</span>
                      <div className="mode-selector">
                        {forecaster.type === 'occupancy' ? (
                          <>
                            <button className={forecaster.mode === 'schedule' ? 'active' : ''}>Schedule</button>
                            <button className={forecaster.mode === 'ml' ? 'active' : ''}>ML Pattern</button>
                            <button className={forecaster.mode === 'hybrid' ? 'active' : ''}>Hybrid</button>
                          </>
                        ) : (
                          <>
                            <button className={forecaster.mode === 'api' ? 'active' : ''}>External API</button>
                            <button className={forecaster.mode === 'ml' ? 'active' : ''}>ML Forecast</button>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="config-row">
                      <span className="config-label">Accuracy</span>
                      <span className="config-value" style={{ color: getAccuracyColor(forecaster.accuracy) }}>
                        {forecaster.accuracy.toFixed(1)}%
                      </span>
                    </div>
                  </div>

                  <div className="forecaster-preview">
                    <span className="preview-label">Tomorrow's Forecast</span>
                    {forecaster.type === 'occupancy' ? (
                      <div className="occupancy-preview">
                        <div className="hour-bar"><span>08:00</span><div className="bar" style={{ width: '10%' }} /><span>5</span></div>
                        <div className="hour-bar"><span>10:00</span><div className="bar" style={{ width: '70%' }} /><span>35</span></div>
                        <div className="hour-bar"><span>12:00</span><div className="bar" style={{ width: '100%' }} /><span>50</span></div>
                        <div className="hour-bar"><span>14:00</span><div className="bar" style={{ width: '90%' }} /><span>45</span></div>
                        <div className="hour-bar"><span>17:00</span><div className="bar" style={{ width: '40%' }} /><span>20</span></div>
                      </div>
                    ) : (
                      <div className="weather-preview">
                        <div className="weather-item"><span>Morning</span><span>4°C ☁️</span></div>
                        <div className="weather-item"><span>Noon</span><span>8°C ⛅</span></div>
                        <div className="weather-item"><span>Evening</span><span>5°C 🌧️</span></div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* === RIGHT: Sidebar === */}
        <div className="sidebar">
          {/* Preview Chart */}
          <div className="preview-section">
            <div className="preview-header">
              <h3>Prediction Preview</h3>
              <div className="feature-pills">
                {processModels.map(m => (
                  <button
                    key={m.feature}
                    className={`feature-pill ${selectedFeature === m.feature ? 'active' : ''}`}
                    onClick={() => setSelectedFeature(m.feature)}
                  >
                    {m.feature === 'temperature' ? '🌡️' : m.feature === 'energy' ? '⚡' : '💨'}
                  </button>
                ))}
              </div>
            </div>

            <div className="preview-chart">
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={predictionData}>
                  <defs>
                    <linearGradient id="confidenceGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="timestamp" stroke="rgba(255,255,255,0.3)" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
                  <YAxis stroke="rgba(255,255,255,0.3)" tick={{ fontSize: 9 }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Area type="monotone" dataKey="confidence_upper" stroke="none" fill="url(#confidenceGrad)" />
                  <Area type="monotone" dataKey="confidence_lower" stroke="none" fill="#0b0d12" />
                  <Line type="monotone" dataKey="actual" stroke="#3b82f6" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="predicted" stroke="#8b5cf6" strokeWidth={2} strokeDasharray="5 5" dot={false} />
                  <ReferenceLine x={predictionData[48]?.timestamp} stroke="#ef4444" strokeDasharray="3 3" />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="preview-legend">
              <span><span className="dot" style={{ background: '#3b82f6' }} /> Actual</span>
              <span><span className="dot" style={{ background: '#8b5cf6' }} /> Predicted</span>
              <span><span className="area" style={{ background: '#8b5cf6' }} /> Confidence</span>
            </div>
          </div>

          {/* Training Settings */}
          <div className="training-settings-section">
            <div className="settings-header" onClick={() => setShowAdvanced(!showAdvanced)}>
              <h3>Training Settings</h3>
              <span className="toggle-icon">{showAdvanced ? '▼' : '▶'}</span>
            </div>

            {showAdvanced && (
              <div className="settings-content">
                <div className="setting-row">
                  <label>Auto-Retrain</label>
                  <div className="toggle-switch">
                    <input 
                      type="checkbox" 
                      checked={trainingConfig.autoRetrain}
                      onChange={e => setTrainingConfig({ ...trainingConfig, autoRetrain: e.target.checked })}
                    />
                    <span className="slider" />
                  </div>
                </div>

                <div className="setting-row">
                  <label>Frequency</label>
                  <select 
                    value={trainingConfig.frequency}
                    onChange={e => setTrainingConfig({ ...trainingConfig, frequency: e.target.value as any })}
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>

                <div className="setting-row">
                  <label>Time</label>
                  <input 
                    type="time" 
                    value={trainingConfig.time}
                    onChange={e => setTrainingConfig({ ...trainingConfig, time: e.target.value })}
                  />
                </div>

                <div className="triggers-section">
                  <span className="triggers-label">Retrain Triggers</span>
                  
                  <label className="trigger-item">
                    <input 
                      type="checkbox" 
                      checked={trainingConfig.triggers.accuracyDrop}
                      onChange={e => setTrainingConfig({
                        ...trainingConfig,
                        triggers: { ...trainingConfig.triggers, accuracyDrop: e.target.checked }
                      })}
                    />
                    <span>Accuracy drops below {trainingConfig.triggers.accuracyThreshold}%</span>
                  </label>

                  <label className="trigger-item">
                    <input 
                      type="checkbox" 
                      checked={trainingConfig.triggers.newData}
                      onChange={e => setTrainingConfig({
                        ...trainingConfig,
                        triggers: { ...trainingConfig.triggers, newData: e.target.checked }
                      })}
                    />
                    <span>New data exceeds {trainingConfig.triggers.newDataThreshold} samples</span>
                  </label>

                  <label className="trigger-item">
                    <input 
                      type="checkbox" 
                      checked={trainingConfig.triggers.driftDetection}
                      onChange={e => setTrainingConfig({
                        ...trainingConfig,
                        triggers: { ...trainingConfig.triggers, driftDetection: e.target.checked }
                      })}
                    />
                    <span>Distribution drift detected</span>
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Training History */}
          <div className="history-section">
            <h3>Training History</h3>
            <div className="history-list">
              {trainingHistory.slice(0, 4).map((item, i) => (
                <div key={i} className={`history-item ${item.result}`}>
                  <div className="history-main">
                    <span className="history-date">{item.date.toLocaleDateString()}</span>
                    <span className="history-trigger">{item.trigger}</span>
                  </div>
                  <div className="history-meta">
                    <span>{item.duration} min</span>
                    <span className={`result-badge ${item.result}`}>
                      {item.result === 'success' ? '✓' : '✗'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ForecastTab;
