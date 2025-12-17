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
import "./components/RightSidebar.scss";
import "./components/MainContent.scss";
import Topbar from "./components/Topbar";
import RightSidebar, { SidebarSection } from "./components/RightSidebar";
import MainContent, { ContentArea, Section } from "./components/MainContent";

interface SelectedModel {
  feature: 'temperature' | 'airquality' | 'energy';
  featureLabel: string;
  icon: JSX.Element;
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
  const [simulationMetrics, setSimulationMetrics] = useState({
    avgTemp: 21.8,
    energy: 12.4,
    comfort: 94,
    cost: 2.48
  });

  const scenarioPresets = [
    { name: 'Comfort', params: { comfortWeight: 0.85, energyWeight: 0.15, temperatureTolerance: 1 } },
    { name: 'Balanced', params: { comfortWeight: 0.5, energyWeight: 0.5, temperatureTolerance: 2 } },
    { name: 'Eco', params: { comfortWeight: 0.25, energyWeight: 0.75, temperatureTolerance: 3 } },
  ];

  useEffect(() => {
    setSelectedModels([
      {
        feature: 'temperature',
        featureLabel: 'Temperature',
        icon: (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}>
            <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>
          </svg>
        ),
        modelType: 'ANN',
        accuracy: 94.2,
        status: 'ready',
        lastTrained: new Date(Date.now() - 2 * 3600000),
      },
      {
        feature: 'airquality',
        featureLabel: 'Air Quality',
        icon: (
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 8h14.5a2.5 2.5 0 0 1 0 5H14" /><path d="M6 16h13.5a2.5 2.5 0 0 0 0-5H19" /><path d="M2 12h5" /><path d="M16 8V7" /></svg>
        ),
        modelType: 'LinReg',
        accuracy: 89.1,
        status: 'ready',
        lastTrained: new Date(Date.now() - 2 * 3600000),
      },
      {
        feature: 'energy',
        featureLabel: 'Energy',
        icon: (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
        ),
        modelType: 'LinReg',
        accuracy: 91.3,
        status: 'ready',
        lastTrained: new Date(Date.now() - 2 * 3600000),
      },
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
      const type: SimulationData['type'] =
        i < 0 ? 'historical' : i === 0 ? 'current' : i <= mpcParams.controlHorizon ? 'control' : 'prediction';

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

      data.push({
        timestamp: timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        fullTimestamp: timestamp,
        temperature,
        energy,
        comfort,
        occupancy,
        type
      });
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

  const handlePresetClick = (preset: typeof scenarioPresets[0]) =>
    setMPCParams(prev => ({ ...prev, ...preset.params }));

  const handleDeploy = () => {
    setShowDeployModal(false);
    setDeploymentStatus(prev => ({ ...prev, isActive: true, runningSince: new Date(), optimizationsRun: 0 }));
  };

  const handlePause = () => setDeploymentStatus(prev => ({ ...prev, isActive: false }));

  const handleRunSimulation = () => {
    setIsSimulating(true);
    setTimeout(() => setIsSimulating(false), 1500);
  };

  const getOverallStatus = () => {
    const allReady = selectedModels.every(m => m.status === 'ready') && forecasters.every(f => f.status === 'ready');

    const modelsAcc = selectedModels.reduce((s, m) => s + m.accuracy, 0);
    const forecastersAcc = forecasters.reduce((s, f) => s + f.accuracy, 0);
    const totalCount = selectedModels.length + forecasters.length;
    const avgAccuracy = totalCount > 0 ? (modelsAcc + forecastersAcc) / totalCount : 0;

    if (!allReady) return { status: 'Models Missing', color: '#ef4444' };
    if (avgAccuracy >= 90) return { status: 'All Models Ready', color: '#10b981' };
    if (avgAccuracy >= 80) return { status: 'Models Ready (Fair)', color: '#f59e0b' };
    return { status: 'Models Need Training', color: '#ef4444' };
  };

  // Calculate timeline percentages based on actual data distribution
  const getTimelinePercentages = () => {
    const historicalCount = simulationData.filter(d => d.type === 'historical').length;
    const currentCount = simulationData.filter(d => d.type === 'current').length;
    const controlCount = simulationData.filter(d => d.type === 'control').length;
    const predictionCount = simulationData.filter(d => d.type === 'prediction').length;
    const totalCount = historicalCount + currentCount + controlCount + predictionCount;

    return {
      historical: (historicalCount / totalCount) * 100,
      control: ((currentCount + controlCount) / totalCount) * 100, // Include current in control
      prediction: (predictionCount / totalCount) * 100,
    };
  };

  const timelinePercentages = getTimelinePercentages();

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0]?.payload;
      const typeColors: Record<string, string> = {
        historical: '#6b7280',
        current: '#ef4444',
        control: '#3b82f6',
        prediction: '#8b5cf6'
      };

      return (
        <div className="chart-tooltip-glass">
          <div className="tooltip-header">{label}</div>
          <div className="tooltip-body">
            <div className="tooltip-row">
              <div className="row-left">
                <div className="indicator" style={{ background: '#ef4444' }} />
                Temp
              </div>
              <div className="row-value">{data?.temperature?.toFixed(1)}<span className="unit">°C</span></div>
            </div>
            <div className="tooltip-row">
              <div className="row-left">
                <div className="indicator" style={{ background: '#10b981' }} />
                Comfort
              </div>
              <div className="row-value">{data?.comfort?.toFixed(0)}<span className="unit">%</span></div>
            </div>
            <div className="tooltip-row">
              <div className="row-left">
                <div className="indicator" style={{ background: '#f59e0b' }} />
                Occupancy
              </div>
              <div className="row-value">{data?.occupancy?.toFixed(0)}<span className="unit">ppl</span></div>
            </div>
          </div>
          <div
            className="tooltip-badge"
            style={{ background: typeColors[data?.type] || '#6b7280' }}
          >
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
        subtitle="Model Predictive Control Configuration"
        rightContent={
          <>
            <div className="topbar-status">
              <span className={`status-dot ${deploymentStatus.isActive ? 'online' : ''}`} />
              <span>{deploymentStatus.isActive ? 'Controller Active' : 'Controller Paused'}</span>
            </div>
            <button className="topbar-btn" onClick={() => setIsSimulating(!isSimulating)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 6v6l4 2"/>
              </svg>
              {isSimulating ? 'Stop Simulation' : 'Run Simulation'}
            </button>
            <button 
              className="topbar-btn primary" 
              onClick={() => setShowDeployModal(true)}
              disabled={!deploymentStatus.isActive}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                <path d="M22 4L12 14.01l-3-3"/>
              </svg>
              Deploy to HVAC
            </button>
          </>
        }
      />

      <MainContent
        sidebar={
          <RightSidebar width="360px">
            {/* Sidebar sections from lines 459-573 */}
          <SidebarSection title="Optimization Objectives" className="glass-card">
            <div className="weight-slider-card">
              <div className="weight-labels" style={{display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '12px'}}>
                <span className="comfort" style={{color: '#10b981'}}>Comfort</span>
                <span className="energy" style={{color: '#f59e0b'}}>Energy</span>
              </div>
              <div className="weight-display" style={{display: 'flex', justifyContent: 'space-between', marginBottom: '12px', fontSize: '18px', fontWeight: 700}}>
                <span className="comfort" style={{color: '#10b981'}}>{(mpcParams.comfortWeight * 100).toFixed(0)}%</span>
                <span className="energy" style={{color: '#f59e0b'}}>{(mpcParams.energyWeight * 100).toFixed(0)}%</span>
              </div>
              <input type="range" min="0" max="1" step="0.05" value={mpcParams.comfortWeight} onChange={e => setMPCParams({ ...mpcParams, comfortWeight: parseFloat(e.target.value), energyWeight: 1 - parseFloat(e.target.value) })} className="weight-slider" style={{width:'100%'}} />
              <div className="mode-indicator" style={{textAlign: 'center', fontSize: '12px', color: 'rgba(255,255,255,0.5)', marginTop: '8px'}}>{mpcParams.comfortWeight >= 0.6 ? 'Comfort Priority' : mpcParams.comfortWeight <= 0.4 ? 'Energy Priority' : 'Balanced'}</div>
            </div>
            <div className="pill-grid" style={{marginTop: '16px'}}>
                {scenarioPresets.map(p => <button key={p.name} className="pill-btn" onClick={() => handlePresetClick(p)}>{p.name}</button>)}
            </div>
          </SidebarSection>

          {/* Setpoints */}
          <SidebarSection title="Setpoints">
            <div className="setpoint-card" style={{padding: '16px', background: 'rgba(255,255,255,0.02)', borderRadius: '12px', marginBottom: '12px'}}>
              <div className="setpoint-header" style={{marginBottom: '12px', fontWeight: 600}}><span><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg> Temperature</span></div>
              <div className="setpoint-row" style={{display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '12px'}}>
                <label>Target</label><span className="value" style={{color: '#3b82f6'}}>{mpcParams.temperatureSetpoint}°C</span>
              </div>
              <input type="range" min="18" max="26" step="0.5" value={mpcParams.temperatureSetpoint} onChange={e => setMPCParams({ ...mpcParams, temperatureSetpoint: parseFloat(e.target.value) })} style={{width: '100%', marginBottom: '16px'}} />
              
              <div className="setpoint-row" style={{display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '12px'}}>
                <label>Tolerance</label><span className="value" style={{color: '#3b82f6'}}>±{mpcParams.temperatureTolerance}°C</span>
              </div>
              <input type="range" min="0.5" max="5" step="0.5" value={mpcParams.temperatureTolerance} onChange={e => setMPCParams({ ...mpcParams, temperatureTolerance: parseFloat(e.target.value) })} style={{width: '100%'}} />
            </div>
            
            <div className={`setpoint-card ${!mpcParams.co2Enabled ? 'disabled' : ''}`} style={{padding: '16px', background: 'rgba(255,255,255,0.02)', borderRadius: '12px', opacity: !mpcParams.co2Enabled ? 0.5 : 1}}>
              <div className="setpoint-header" style={{display: 'flex', justifyContent: 'space-between', marginBottom: '12px', fontWeight: 600}}>
                <span><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 8h14.5a2.5 2.5 0 0 1 0 5H14" /><path d="M6 16h13.5a2.5 2.5 0 0 0 0-5H19" /><path d="M2 12h5" /><path d="M16 8V7" /></svg> CO₂</span>
                <div className="toggle-switch">
                   <input type="checkbox" checked={mpcParams.co2Enabled} onChange={e => setMPCParams({ ...mpcParams, co2Enabled: e.target.checked })} />
                   <span className="slider" />
                </div>
              </div>
              {mpcParams.co2Enabled && (
                <>
                  <div className="setpoint-row" style={{display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '12px'}}>
                    <label>Target</label><span className="value" style={{color: '#3b82f6'}}>{mpcParams.co2Setpoint} ppm</span>
                  </div>
                  <input type="range" min="400" max="1000" step="50" value={mpcParams.co2Setpoint} onChange={e => setMPCParams({ ...mpcParams, co2Setpoint: parseInt(e.target.value) })} style={{width: '100%'}} />
                </>
              )}
            </div>
          </SidebarSection>

          {/* Schedule */}
          <SidebarSection title="Schedule">
            <div className="pill-grid" style={{marginBottom: '16px'}}>
              <button className={`pill-btn ${scheduleConfig.mode === '24/7' ? 'active' : ''}`} onClick={() => setScheduleConfig({ ...scheduleConfig, mode: '24/7' })}>24/7</button>
              <button className={`pill-btn ${scheduleConfig.mode === 'scheduled' ? 'active' : ''}`} onClick={() => setScheduleConfig({ ...scheduleConfig, mode: 'scheduled' })}>Office Hours</button>
            </div>
            {scheduleConfig.mode === 'scheduled' && (
              <div className="schedule-config">
                <div className="time-inputs" style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'12px', marginBottom:'12px'}}>
                  <div className="control-group">
                    <label>Start</label>
                    <input type="time" value={scheduleConfig.officeHours.start} onChange={e => setScheduleConfig({ ...scheduleConfig, officeHours: { ...scheduleConfig.officeHours, start: e.target.value } })} />
                  </div>
                  <div className="control-group">
                    <label>End</label>
                    <input type="time" value={scheduleConfig.officeHours.end} onChange={e => setScheduleConfig({ ...scheduleConfig, officeHours: { ...scheduleConfig.officeHours, end: e.target.value } })} />
                  </div>
                </div>
                
                <label className="weekdays-toggle" style={{display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', color: 'rgba(255,255,255,0.5)', marginBottom: '12px'}}>
                    <input type="checkbox" checked={scheduleConfig.officeHours.weekdaysOnly} onChange={e => setScheduleConfig({ ...scheduleConfig, officeHours: { ...scheduleConfig.officeHours, weekdaysOnly: e.target.checked } })} />
                    <span>Weekdays only</span>
                </label>

                <div className="current-mode-display" style={{display: 'flex', justifyContent: 'space-between', padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px'}}>
                  <span className={`mode-badge ${currentMode}`} style={{fontSize: '13px', fontWeight: 600, padding: '4px 10px', borderRadius: '6px', background: currentMode === 'in-office' ? 'rgba(16,185,129, 0.15)' : 'rgba(139,92,246, 0.15)', color: currentMode === 'in-office' ? '#10b981' : '#8b5cf6'}}>
                      {currentMode === 'in-office' ? 'In-Office' : 'Out-of-Office'}
                  </span>
                  <span className="time-display" style={{fontFamily: 'monospace', fontSize: '14px', color: 'rgba(255,255,255,0.5)'}}>
                      {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            )}
          </SidebarSection>

          {/* Advanced MPC */}
          <SidebarSection title="Advanced MPC" collapsible={true} defaultExpanded={false}>
                <div className="control-group">
                    <div style={{display:'flex', justifyContent:'space-between', marginBottom:'8px', fontSize: '12px'}}>
                        <label>Prediction Horizon</label><span style={{color: '#3b82f6', fontFamily: 'monospace'}}>{mpcParams.predictionHorizon} steps</span>
                    </div>
                    <input type="range" min="4" max="24" value={mpcParams.predictionHorizon} onChange={e => setMPCParams({ ...mpcParams, predictionHorizon: parseInt(e.target.value) })} style={{width: '100%'}} />
                </div>
                <div className="control-group">
                    <div style={{display:'flex', justifyContent:'space-between', marginBottom:'8px', fontSize: '12px'}}>
                        <label>Control Horizon</label><span style={{color: '#3b82f6', fontFamily: 'monospace'}}>{mpcParams.controlHorizon} steps</span>
                    </div>
                    <input type="range" min="1" max="12" value={mpcParams.controlHorizon} onChange={e => setMPCParams({ ...mpcParams, controlHorizon: parseInt(e.target.value) })} style={{width: '100%'}} />
                </div>
                <div className="control-group">
                    <div style={{display:'flex', justifyContent:'space-between', marginBottom:'8px', fontSize: '12px'}}>
                        <label>Optimization Interval</label><span style={{color: '#3b82f6', fontFamily: 'monospace'}}>{mpcParams.optimizationInterval} min</span>
                    </div>
                    <input type="range" min="5" max="60" step="5" value={mpcParams.optimizationInterval} onChange={e => setMPCParams({ ...mpcParams, optimizationInterval: parseInt(e.target.value) })} style={{width: '100%'}} />
                </div>
                <label className="constraint-toggle" style={{display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', color: 'rgba(255,255,255,0.5)'}}>
                    <input type="checkbox" checked={mpcParams.rateConstraints} onChange={e => setMPCParams({ ...mpcParams, rateConstraints: e.target.checked })} />
                    <span>Rate Constraints (max {mpcParams.maxHvacChange}%/step)</span>
                </label>
          </SidebarSection>
        </RightSidebar>
        }
        sidebarWidth="360px"
      >
        <ContentArea padding="compact" gap="16px">
          <div className="model-status-section">
            <div className="status-header">
              <h2>Model Selection</h2>
              <div className="overall-status">
                <div className="status-dot" style={{ background: overallStatus.color }} />
                {overallStatus.status}
              </div>
            </div>
            <div className="models-row">
              {selectedModels.map(m => (
                <div key={m.feature} className={`model-pill ${m.status}`}>
                  <div className="model-icon">{m.icon}</div>
                  <div className="model-info">
                    <div className="model-name">{m.featureLabel}</div>
                    <div className="model-detail">{m.modelType} • {m.accuracy.toFixed(0)}%</div>
                  </div>
                  <div className={`status-badge ${m.status}`}>{m.status === 'ready' ? '✓' : '!'}</div>
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
          </div>

          <div className="kpi-row">
            <div className="kpi-card"><div className="kpi-icon temp"> <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg></div><div className="kpi-data"><span className="label">Avg Temp</span> <span className="value">{simulationMetrics.avgTemp.toFixed(1)}°C</span></div></div>
            <div className="kpi-card"><div className="kpi-icon energy"> <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg> </div><div className="kpi-data"><span className="label">Energy</span><span className="value">{simulationMetrics.energy.toFixed(1)} kWh</span></div></div>
            <div className="kpi-card"><div className="kpi-icon comfort"> <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none"><rect x="6" y="12" width="12" height="6" rx="2" stroke="currentColor" strokeWidth="2"/><path d="M10 6c0 1 1 1 1 2s-1 1-1 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M14 6c0 1 1 1 1 2s-1 1-1 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg> </div><div className="kpi-data"><span className="label">Comfort</span><span className="value">{simulationMetrics.comfort.toFixed(0)}%</span></div></div>
            <div className="kpi-card"><div className="kpi-icon cost"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M13 7L9 12h4l-2 5"/></svg> </div><div className="kpi-data"><span className="label">Est. Cost</span><span className="value">£{simulationMetrics.cost.toFixed(2)}</span></div></div>
          </div>

          <div className="chart-section">
            <div className="chart-header-row">
              <h3>System Response Forecast</h3>
              <div className="chart-legend">
                <span><div className="dot" style={{ background: '#ef4444' }} /> Temp</span>
                <span><div className="dot" style={{ background: '#10b981' }} /> Comfort</span>
                <span><div className="line dashed" /> Setpoint</span>
              </div>
            </div>
            <div className="chart-container">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={simulationData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                  <XAxis dataKey="timestamp" stroke="rgba(255,255,255,0.3)" style={{ fontSize: 11 }} />
                  <YAxis stroke="rgba(255,255,255,0.3)" style={{ fontSize: 11 }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Line type="monotone" dataKey="temperature" stroke="#ef4444" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="comfort" stroke="#10b981" strokeWidth={2} dot={false} />
                  <ReferenceLine
                    y={mpcParams.temperatureSetpoint}
                    stroke="#4ade80"
                    strokeDasharray="5 5"
                    strokeWidth={1.5}
                  />
                  <ReferenceLine
                    x={simulationData.find(d => d.type === 'current')?.timestamp}
                    stroke="#ef4444"
                    strokeDasharray="3 3"
                    strokeWidth={2}
                    label={{ position: 'top', value: 'NOW', fill: '#ef4444', fontSize: 10 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div className="horizon-bar">
              <span className="horizon-label">Timeline</span>
              <div className="timeline-graphic">
                <div className="segment history" style={{ width: `${timelinePercentages.historical}%` }}>
                  Past 6h
                </div>
                <div className="now-marker" style={{ left: `${timelinePercentages.historical}%` }} />
                <div className="segment control" style={{ width: `${timelinePercentages.control}%` }}>
                  Control ({mpcParams.controlHorizon * 15}m)
                </div>
                <div className="segment prediction" style={{ width: `${timelinePercentages.prediction}%` }}>
                  Prediction ({(mpcParams.predictionHorizon - mpcParams.controlHorizon) * 15}m)
                </div>
              </div>
            </div>
          </div>
        </ContentArea>
      </MainContent>

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
            <div className="modal-footer"><button className="cancel" onClick={() => setShowDeployModal(false)}>Cancel</button><button className="confirm" onClick={handleDeploy}>Deploy to HVAC</button></div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ControllerTab;