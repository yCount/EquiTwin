import React, { useState, useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Area,
  ComposedChart,
} from "recharts";
import "./ControllerTab.scss";
import Topbar from "./components/Topbar";

interface SelectedModel {
  feature: 'temperature' | 'airquality' | 'energy';
  featureLabel: string;
  modelType: 'ANN' | 'GPR' | 'LinReg';
  accuracy: number;
  status: 'ready' | 'outdated' | 'missing';
  lastTrained: Date | null;
}

interface ForecasterStatus {
  type: 'occupancy' | 'weather';
  name: string;
  mode: string;
  accuracy: number;
  status: 'ready' | 'disconnected';
}

interface MPCParameters {
  predictionHorizon: number;
  controlHorizon: number;
  comfortWeight: number;
  energyWeight: number;
  temperatureSetpoint: number;
  temperatureTolerance: number;
  co2Setpoint: number;
  co2Tolerance: number;
  co2Enabled: boolean;
  optimizationInterval: number;
  rateConstraints: boolean;
  maxHvacChange: number;
}

interface ScheduleConfig {
  mode: '24/7' | 'scheduled';
  officeHours: {
    start: string;
    end: string;
    weekdaysOnly: boolean;
  };
  inOfficeParams: Partial<MPCParameters>;
  outOfficeParams: Partial<MPCParameters>;
}

interface SimulationData {
  timestamp: string;
  fullTimestamp: Date;
  temperature: number;
  energy: number;
  comfort: number;
  occupancy: number;
  type: 'historical' | 'current' | 'control' | 'prediction';
}

interface DeploymentStatus {
  isActive: boolean;
  runningSince: Date | null;
  optimizationsRun: number;
  avgSolveTime: number;
  lastAction: string;
  nextOptimization: number;
}

// ============================================================================
// COMPONENT
// ============================================================================

const ControllerTab: React.FC = () => {
  const [selectedModels, setSelectedModels] = useState<SelectedModel[]>([]);
  const [forecasters, setForecasters] = useState<ForecasterStatus[]>([]);
  const [mpcParams, setMPCParams] = useState<MPCParameters>({
    predictionHorizon: 12,
    controlHorizon: 4,
    comfortWeight: 0.7,
    energyWeight: 0.3,
    temperatureSetpoint: 22,
    temperatureTolerance: 1.5,
    co2Setpoint: 600,
    co2Tolerance: 200,
    co2Enabled: true,
    optimizationInterval: 15,
    rateConstraints: true,
    maxHvacChange: 20,
  });
  const [scheduleConfig, setScheduleConfig] = useState<ScheduleConfig>({
    mode: 'scheduled',
    officeHours: { start: '08:00', end: '18:00', weekdaysOnly: true },
    inOfficeParams: { comfortWeight: 0.7, energyWeight: 0.3, temperatureSetpoint: 22, temperatureTolerance: 1.5 },
    outOfficeParams: { comfortWeight: 0.2, energyWeight: 0.8, temperatureSetpoint: 18, temperatureTolerance: 4 },
  });
  const [simulationData, setSimulationData] = useState<SimulationData[]>([]);
  const [deploymentStatus, setDeploymentStatus] = useState<DeploymentStatus>({
    isActive: true,
    runningSince: new Date(Date.now() - 2 * 24 * 3600000),
    optimizationsRun: 1247,
    avgSolveTime: 0.8,
    lastAction: 'Set heating to 45%, ventilation to 30%',
    nextOptimization: 12,
  });
  const [showDeployModal, setShowDeployModal] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [currentMode, setCurrentMode] = useState<'in-office' | 'out-office'>('in-office');
  const [simulationMetrics, setSimulationMetrics] = useState({ avgTemp: 21.8, energy: 12.4, comfort: 94, cost: 2.48 });

  const scenarioPresets = [
    { name: 'Comfort', params: { comfortWeight: 0.85, energyWeight: 0.15, temperatureTolerance: 1 } },
    { name: 'Balanced', params: { comfortWeight: 0.5, energyWeight: 0.5, temperatureTolerance: 2 } },
    { name: 'Eco', params: { comfortWeight: 0.25, energyWeight: 0.75, temperatureTolerance: 3 } },
    { name: 'Night', params: { comfortWeight: 0.2, energyWeight: 0.8, temperatureSetpoint: 18, temperatureTolerance: 4 } },
  ];

  useEffect(() => {
    setSelectedModels([
      { feature: 'temperature', featureLabel: '🌡️ Temperature', modelType: 'ANN', accuracy: 94.2, status: 'ready', lastTrained: new Date(Date.now() - 2 * 3600000) },
      { feature: 'airquality', featureLabel: '💨 Air Quality', modelType: 'LinReg', accuracy: 89.1, status: 'ready', lastTrained: new Date(Date.now() - 2 * 3600000) },
      { feature: 'energy', featureLabel: '⚡ Energy', modelType: 'LinReg', accuracy: 91.3, status: 'ready', lastTrained: new Date(Date.now() - 2 * 3600000) },
    ]);
    setForecasters([
      { type: 'occupancy', name: 'Occupancy', mode: 'ML Pattern', accuracy: 87.3, status: 'ready' },
      { type: 'weather', name: 'Weather', mode: 'External API', accuracy: 92.1, status: 'ready' },
    ]);
    const now = new Date();
    const hour = now.getHours();
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;
    setCurrentMode(hour >= 8 && hour < 18 && !isWeekend ? 'in-office' : 'out-office');
  }, []);

  useEffect(() => {
    const now = new Date();
    const data: SimulationData[] = [];
    for (let i = -24; i <= mpcParams.predictionHorizon; i++) {
      const timestamp = new Date(now.getTime() + i * 900000);
      const type: SimulationData['type'] = i < 0 ? 'historical' : i === 0 ? 'current' : i <= mpcParams.controlHorizon ? 'control' : 'prediction';
      const hour = timestamp.getHours();
      const isWorkHour = hour >= 8 && hour < 18;
      const occupancy = isWorkHour ? 30 + Math.random() * 20 : Math.random() * 5;
      const tempDeviation = (1 - mpcParams.comfortWeight) * 2;
      const baseTemp = isWorkHour ? mpcParams.temperatureSetpoint : mpcParams.temperatureSetpoint - 2;
      const temperature = baseTemp + Math.sin(i / 5) * tempDeviation + (Math.random() - 0.5) * 0.5;
      const baseEnergy = 30 + (1 - mpcParams.comfortWeight) * -15;
      const energy = baseEnergy + (isWorkHour ? 20 : 0) + Math.random() * 10;
      const tempDiff = Math.abs(temperature - mpcParams.temperatureSetpoint);
      const comfort = Math.max(0, 100 - tempDiff * 15 - (occupancy > 10 ? 0 : 20));
      data.push({ timestamp: timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), fullTimestamp: timestamp, temperature, energy, comfort, occupancy, type });
    }
    setSimulationData(data);
    const futureData = data.filter(d => d.type !== 'historical');
    if (futureData.length > 0) {
      setSimulationMetrics({
        avgTemp: futureData.reduce((s, d) => s + d.temperature, 0) / futureData.length,
        energy: futureData.reduce((s, d) => s + d.energy, 0) / futureData.length / 4,
        comfort: futureData.reduce((s, d) => s + d.comfort, 0) / futureData.length,
        cost: futureData.reduce((s, d) => s + d.energy * 0.15, 0) / futureData.length / 4,
      });
    }
  }, [mpcParams]);

  const handlePresetClick = (preset: typeof scenarioPresets[0]) => setMPCParams(prev => ({ ...prev, ...preset.params }));
  const handleDeploy = () => { setShowDeployModal(false); setDeploymentStatus(prev => ({ ...prev, isActive: true, runningSince: new Date(), optimizationsRun: 0 })); };
  const handlePause = () => setDeploymentStatus(prev => ({ ...prev, isActive: false }));
  const handleRunSimulation = () => { setIsSimulating(true); setTimeout(() => setIsSimulating(false), 1500); };

  const getOverallStatus = () => {
    const allReady = selectedModels.every(m => m.status === 'ready') && forecasters.every(f => f.status === 'ready');
    const avgAccuracy = [...selectedModels, ...forecasters].reduce((sum, m) => sum + m.accuracy, 0) / (selectedModels.length + forecasters.length);
    if (!allReady) return { status: 'Models Missing', color: '#ef4444' };
    if (avgAccuracy >= 90) return { status: 'All Models Ready', color: '#10b981' };
    if (avgAccuracy >= 80) return { status: 'Models Ready (Fair)', color: '#f59e0b' };
    return { status: 'Models Need Training', color: '#ef4444' };
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0]?.payload;
      const typeColors: Record<string, string> = { historical: '#6b7280', current: '#ef4444', control: '#3b82f6', prediction: '#8b5cf6' };
      return (
        <div className="chart-tooltip-glass">
          <div className="tooltip-header">{label}</div>
          <div className="tooltip-body">
            <div className="tooltip-row"><div className="row-left"><div className="indicator" style={{ background: '#ef4444' }} /><span>Temp</span></div><div className="row-value">{data?.temperature?.toFixed(1)}<span className="unit">°C</span></div></div>
            <div className="tooltip-row"><div className="row-left"><div className="indicator" style={{ background: '#10b981' }} /><span>Comfort</span></div><div className="row-value">{data?.comfort?.toFixed(0)}<span className="unit">%</span></div></div>
            <div className="tooltip-row"><div className="row-left"><div className="indicator" style={{ background: '#f59e0b' }} /><span>Occupancy</span></div><div className="row-value">{data?.occupancy?.toFixed(0)}<span className="unit">ppl</span></div></div>
          </div>
          <div className="tooltip-badge" style={{ background: `${typeColors[data?.type]}20`, color: typeColors[data?.type] }}>
            {data?.type === 'historical' ? 'Past' : data?.type === 'current' ? 'Now' : data?.type === 'control' ? 'Control' : 'Prediction'}
          </div>
        </div>
      );
    }
    return null;
  };

  const overallStatus = getOverallStatus();

  return (
    <div className="controller-container">
      <Topbar
        title="MPC Controller"
        subtitle="Model Predictive Control Configuration & Deployment"
        rightContent={
          <>
            <div className={`topbar-status ${deploymentStatus.isActive ? 'active' : 'paused'}`}>
              <span className="status-dot" />
              <span>{deploymentStatus.isActive ? 'Controller Active' : 'Paused'}</span>
            </div>
            <button className="topbar-btn" onClick={handleRunSimulation} disabled={isSimulating}>
              {isSimulating ? 'Simulating...' : 'Simulate'}
            </button>
            <button className="topbar-btn success" onClick={() => setShowDeployModal(true)}>Deploy</button>
          </>
        }
      />

      <div className="dashboard-grid">
        {/* LEFT: Visualization */}
        <div className="visualization-panel">
          <section className="model-status-section">
            <div className="status-header">
              <h2>Model Selection</h2>
              <div className="overall-status" style={{ color: overallStatus.color }}>
                <span className="status-dot" style={{ background: overallStatus.color }} />
                {overallStatus.status}
              </div>
            </div>
            <div className="models-row">
              {selectedModels.map(m => (
                <div key={m.feature} className={`model-pill ${m.status}`}>
                  <span className="model-icon">{m.featureLabel.split(' ')[0]}</span>
                  <div className="model-info">
                    <span className="model-name">{m.featureLabel.split(' ').slice(1).join(' ')}</span>
                    <span className="model-detail">{m.modelType} • {m.accuracy.toFixed(0)}%</span>
                  </div>
                  <span className={`status-badge ${m.status}`}>{m.status === 'ready' ? '✓' : '!'}</span>
                </div>
              ))}
              {forecasters.map(f => (
                <div key={f.type} className={`model-pill forecaster ${f.status}`}>
                  <span className="model-icon">{f.type === 'occupancy' ? <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg> : '🌤️'}</span>
                  <div className="model-info">
                    <span className="model-name">{f.name}</span>
                    <span className="model-detail">{f.mode} • {f.accuracy.toFixed(0)}%</span>
                  </div>
                  <span className={`status-badge ${f.status}`}>{f.status === 'ready' ? '✓' : '!'}</span>
                </div>
              ))}
            </div>
            <p className="model-hint">Models trained on <strong>Prediction</strong> page</p>
          </section>

          <div className="kpi-row">
            <div className="kpi-card"><div className="kpi-icon temp"> <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg></div><div className="kpi-data"><span className="label">Avg Temp</span> <span className="value">{simulationMetrics.avgTemp.toFixed(1)}°C</span></div></div>
            <div className="kpi-card"><div className="kpi-icon energy"> <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg> </div><div className="kpi-data"><span className="label">Energy</span><span className="value">{simulationMetrics.energy.toFixed(1)} kWh</span></div></div>
            <div className="kpi-card"><div className="kpi-icon comfort"> <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none"><rect x="6" y="12" width="12" height="6" rx="2" stroke="currentColor" stroke-width="2"/><path d="M10 6c0 1 1 1 1 2s-1 1-1 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M14 6c0 1 1 1 1 2s-1 1-1 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> </div><div className="kpi-data"><span className="label">Comfort</span><span className="value">{simulationMetrics.comfort.toFixed(0)}%</span></div></div>
            <div className="kpi-card"><div className="kpi-icon cost"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M13 7L9 12h4l-2 5"/></svg> </div><div className="kpi-data"><span className="label">Est. Cost</span><span className="value">£{simulationMetrics.cost.toFixed(2)}</span></div></div>
          </div>

          <div className="chart-section">
            <div className="chart-header-row">
              <h3>System Response Forecast</h3>
              <div className="chart-legend">
                <span><span className="dot" style={{ background: '#ef4444' }} />Temp</span>
                <span><span className="dot" style={{ background: '#10b981' }} />Comfort</span>
                <span className="line-legend"><span className="line dashed" />Setpoint</span>
              </div>
            </div>
            <div className="chart-container">
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={simulationData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="timestamp" stroke="rgba(255,255,255,0.3)" tick={{ fontSize: 10 }} />
                  <YAxis yAxisId="left" stroke="rgba(255,255,255,0.3)" domain={[15, 28]} tick={{ fontSize: 10 }} />
                  <YAxis yAxisId="right" orientation="right" stroke="rgba(255,255,255,0.3)" domain={[0, 100]} tick={{ fontSize: 10 }} />
                  <Tooltip content={<CustomTooltip />} />
                  <ReferenceLine x={simulationData.find(d => d.type === 'current')?.timestamp} stroke="#ef4444" strokeDasharray="3 3" strokeWidth={2} label={{ position: 'top', value: 'NOW', fill: '#ef4444', fontSize: 10 }} />
                  <ReferenceLine yAxisId="left" y={mpcParams.temperatureSetpoint} stroke="#4ade80" strokeOpacity={0.5} strokeDasharray="5 5" />
                  <Line yAxisId="left" type="monotone" dataKey="temperature" stroke="#ef4444" strokeWidth={2} dot={false} />
                  <Line yAxisId="right" type="monotone" dataKey="comfort" stroke="#10b981" strokeWidth={2} dot={false} strokeOpacity={0.7} />
                  <Area yAxisId="right" type="monotone" dataKey="occupancy" fill="#8b5cf6" fillOpacity={0.1} stroke="none" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="horizon-bar">
              <span className="horizon-label">Timeline</span>
              <div className="timeline-graphic">
                <div className="segment history">Past 6h</div>
                <div className="now-marker" />
                <div className="segment control" style={{ flex: mpcParams.controlHorizon }}>Control ({mpcParams.controlHorizon * 15}m)</div>
                <div className="segment prediction" style={{ flex: mpcParams.predictionHorizon - mpcParams.controlHorizon }}>Prediction ({(mpcParams.predictionHorizon - mpcParams.controlHorizon) * 15}m)</div>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT: Controls */}
        <div className="controls-panel">
          <section className="panel-section">
            <h3>Optimization Objectives</h3>
            <div className="weight-slider-card">
              <div className="weight-labels"><span className="comfort">Comfort</span><span className="energy">Energy</span></div>
              <div className="weight-display">
                <span className="comfort">{(mpcParams.comfortWeight * 100).toFixed(0)}%</span>
                <span className="energy">{(mpcParams.energyWeight * 100).toFixed(0)}%</span>
              </div>
              <input type="range" min="0" max="1" step="0.05" value={mpcParams.comfortWeight} onChange={e => setMPCParams({ ...mpcParams, comfortWeight: parseFloat(e.target.value), energyWeight: 1 - parseFloat(e.target.value) })} className="weight-slider" />
              <div className="mode-indicator">{mpcParams.comfortWeight >= 0.6 ? 'Comfort Priority' : mpcParams.comfortWeight <= 0.4 ? 'Energy Priority' : 'Balanced'}</div>
            </div>
            <div className="presets-row">{scenarioPresets.map(p => <button key={p.name} className="preset-btn" onClick={() => handlePresetClick(p)}>{p.name}</button>)}</div>
          </section>

          <section className="panel-section">
            <h3>Setpoints</h3>
            <div className="setpoint-card">
              <div className="setpoint-header"><span> <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg> Temperature</span></div>
              <div className="setpoint-row"><label>Target</label><span className="value">{mpcParams.temperatureSetpoint}°C</span></div>
              <input type="range" min="18" max="26" step="0.5" value={mpcParams.temperatureSetpoint} onChange={e => setMPCParams({ ...mpcParams, temperatureSetpoint: parseFloat(e.target.value) })} />
              <div className="setpoint-row"><label>Tolerance</label><span className="value">±{mpcParams.temperatureTolerance}°C</span></div>
              <input type="range" min="0.5" max="5" step="0.5" value={mpcParams.temperatureTolerance} onChange={e => setMPCParams({ ...mpcParams, temperatureTolerance: parseFloat(e.target.value) })} />
            </div>
            <div className={`setpoint-card ${!mpcParams.co2Enabled ? 'disabled' : ''}`}>
              <div className="setpoint-header">
                <span>💨 CO₂</span>
                <label className="toggle"><input type="checkbox" checked={mpcParams.co2Enabled} onChange={e => setMPCParams({ ...mpcParams, co2Enabled: e.target.checked })} /><span className="slider" /></label>
              </div>
              {mpcParams.co2Enabled && (
                <>
                  <div className="setpoint-row"><label>Target</label><span className="value">{mpcParams.co2Setpoint} ppm</span></div>
                  <input type="range" min="400" max="1000" step="50" value={mpcParams.co2Setpoint} onChange={e => setMPCParams({ ...mpcParams, co2Setpoint: parseInt(e.target.value) })} />
                </>
              )}
            </div>
          </section>

          <section className="panel-section">
            <h3>Schedule</h3>
            <div className="schedule-toggle">
              <button className={scheduleConfig.mode === '24/7' ? 'active' : ''} onClick={() => setScheduleConfig({ ...scheduleConfig, mode: '24/7' })}>24/7</button>
              <button className={scheduleConfig.mode === 'scheduled' ? 'active' : ''} onClick={() => setScheduleConfig({ ...scheduleConfig, mode: 'scheduled' })}>Office Hours</button>
            </div>
            {scheduleConfig.mode === 'scheduled' && (
              <div className="schedule-config">
                <div className="time-inputs">
                  <div><label>Start</label><input type="time" value={scheduleConfig.officeHours.start} onChange={e => setScheduleConfig({ ...scheduleConfig, officeHours: { ...scheduleConfig.officeHours, start: e.target.value } })} /></div>
                  <div><label>End</label><input type="time" value={scheduleConfig.officeHours.end} onChange={e => setScheduleConfig({ ...scheduleConfig, officeHours: { ...scheduleConfig.officeHours, end: e.target.value } })} /></div>
                </div>
                <label className="weekdays-toggle"><input type="checkbox" checked={scheduleConfig.officeHours.weekdaysOnly} onChange={e => setScheduleConfig({ ...scheduleConfig, officeHours: { ...scheduleConfig.officeHours, weekdaysOnly: e.target.checked } })} /><span>Weekdays only</span></label>
                <div className="current-mode-display">
                  <span className={`mode-badge ${currentMode}`}>{currentMode === 'in-office' ? '🏢 In-Office' : '🌙 Out-of-Office'}</span>
                  <span className="time-display">{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </div>
            )}
          </section>

          <section className="panel-section collapsible">
            <div className="section-header-toggle" onClick={() => setShowAdvanced(!showAdvanced)}>
              <h3>Advanced MPC</h3>
              <span>{showAdvanced ? '▼' : '▶'}</span>
            </div>
            {showAdvanced && (
              <div className="advanced-content">
                <div className="param-row"><label>Prediction Horizon</label><span>{mpcParams.predictionHorizon} steps ({mpcParams.predictionHorizon * 15}m)</span></div>
                <input type="range" min="4" max="24" value={mpcParams.predictionHorizon} onChange={e => setMPCParams({ ...mpcParams, predictionHorizon: parseInt(e.target.value) })} />
                <div className="param-row"><label>Control Horizon</label><span>{mpcParams.controlHorizon} steps ({mpcParams.controlHorizon * 15}m)</span></div>
                <input type="range" min="1" max="12" value={mpcParams.controlHorizon} onChange={e => setMPCParams({ ...mpcParams, controlHorizon: parseInt(e.target.value) })} />
                <div className="param-row"><label>Optimization Interval</label><span>{mpcParams.optimizationInterval} min</span></div>
                <input type="range" min="5" max="60" step="5" value={mpcParams.optimizationInterval} onChange={e => setMPCParams({ ...mpcParams, optimizationInterval: parseInt(e.target.value) })} />
                <label className="constraint-toggle"><input type="checkbox" checked={mpcParams.rateConstraints} onChange={e => setMPCParams({ ...mpcParams, rateConstraints: e.target.checked })} /><span>Rate Constraints (max {mpcParams.maxHvacChange}%/step)</span></label>
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Deploy Modal */}
      {showDeployModal && (
        <div className="modal-overlay" onClick={() => setShowDeployModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header"><h2>Confirm Deployment</h2><button className="close-btn" onClick={() => setShowDeployModal(false)}>×</button></div>
            <div className="modal-body">
              <div className="warning-box"><span>This will apply new settings to the live HVAC system.</span></div>
              <div className="config-summary">
                <h4>Configuration Summary</h4>
                <div className="summary-row"><span>Comfort/Energy</span><span>{(mpcParams.comfortWeight * 100).toFixed(0)}% / {(mpcParams.energyWeight * 100).toFixed(0)}%</span></div>
                <div className="summary-row"><span>Temperature Target</span><span>{mpcParams.temperatureSetpoint}°C ±{mpcParams.temperatureTolerance}°C</span></div>
                <div className="summary-row"><span>Prediction Horizon</span><span>{mpcParams.predictionHorizon * 15} minutes</span></div>
                <div className="summary-row"><span>Control Horizon</span><span>{mpcParams.controlHorizon * 15} minutes</span></div>
                <div className="summary-row"><span>Schedule Mode</span><span>{scheduleConfig.mode === 'scheduled' ? 'Office Hours' : '24/7'}</span></div>
              </div>
            </div>
            <div className="modal-footer"><button className="cancel" onClick={() => setShowDeployModal(false)}>Cancel</button><button className="confirm" onClick={handleDeploy}>🚀 Deploy to HVAC</button></div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ControllerTab;
