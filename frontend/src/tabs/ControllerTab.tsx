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
} from "recharts";
import "./ControllerTab.scss";
import Topbar from "./components/Topbar";

interface MPCParameters {
  predictionHorizon: number;
  controlHorizon: number;
  comfortWeight: number;
  energyWeight: number;
  temperatureSetpoint: number;
  temperatureTolerance: number;
  optimizationInterval: number;
  constraintsEnabled: boolean;
}

interface TrainedModel {
  id: string;
  name: string;
  type: string;
  accuracy: number;
  trainedDate: Date;
  status: 'active' | 'inactive' | 'deployed';
}

interface SimulationData {
  timestamp: string;
  fullTimestamp: Date;
  temperature: number;
  energy: number;
  comfort: number;
  type: 'historical' | 'current' | 'control' | 'prediction';
}

const ControllerTab = () => {
  const [mpcParams, setMPCParams] = useState<MPCParameters>({
    predictionHorizon: 12,
    controlHorizon: 4,
    comfortWeight: 0.6,
    energyWeight: 0.4,
    temperatureSetpoint: 22,
    temperatureTolerance: 2,
    optimizationInterval: 15,
    constraintsEnabled: true,
  });

  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [models, setModels] = useState<TrainedModel[]>([]);
  const [deployedModel, setDeployedModel] = useState<string | null>(null);
  const [simulationData, setSimulationData] = useState<SimulationData[]>([]);
  const [showDeployModal, setShowDeployModal] = useState<boolean>(false);
  const [isSimulating, setIsSimulating] = useState<boolean>(false);
  const [chartView, setChartView] = useState<'full' | 'historical' | 'future'>('full');
  const [visibleSeries, setVisibleSeries] = useState({
    temperature: true,
    comfort: true,
    setpoint: true,
  });
  const [liveUpdate, setLiveUpdate] = useState<boolean>(true);
  const [savedConfigs, setSavedConfigs] = useState<Array<{name: string, params: MPCParameters}>>([]);
  const [showSaveModal, setShowSaveModal] = useState<boolean>(false);
  const [configName, setConfigName] = useState<string>("");
  const [activeSection, setActiveSection] = useState<string>('params');

  const scenarioPresets = [
    { name: "Maximum Comfort", icon: "", params: { ...mpcParams, comfortWeight: 0.85, energyWeight: 0.15, temperatureTolerance: 1, controlHorizon: 6 } },
    { name: "Balanced", icon: "", params: { ...mpcParams, comfortWeight: 0.5, energyWeight: 0.5, temperatureTolerance: 2, controlHorizon: 4 } },
    { name: "Eco Mode", icon: "", params: { ...mpcParams, comfortWeight: 0.25, energyWeight: 0.75, temperatureTolerance: 3, controlHorizon: 3 } },
    { name: "Night Operation", icon: "", params: { ...mpcParams, comfortWeight: 0.3, energyWeight: 0.7, temperatureSetpoint: 20, temperatureTolerance: 3.5 } },
  ];

  const applyPreset = (presetParams: MPCParameters) => setMPCParams(presetParams);
  
  const saveConfiguration = () => {
    if (configName.trim()) {
      setSavedConfigs([...savedConfigs, { name: configName, params: { ...mpcParams } }]);
      setConfigName("");
      setShowSaveModal(false);
    }
  };

  const handleDeployModel = () => {
    if (selectedModel) {
      setModels((prev) => prev.map((m) => ({ ...m, status: m.id === selectedModel ? "deployed" : "inactive" })));
      setDeployedModel(selectedModel);
      setShowDeployModal(false);
    }
  };

  const handleRunSimulation = () => {
    setIsSimulating(true);
    setTimeout(() => { setIsSimulating(false); }, 1500);
  };

  useEffect(() => {
    const initialModels: TrainedModel[] = [
      { id: "Linear Regression", name: "Regression", type: "Deep Learning", accuracy: 94.2, trainedDate: new Date(), status: "inactive" },
      { id: "transformer-001", name: "Neural Network", type: "Attention-Based", accuracy: 95.6, trainedDate: new Date(), status: "deployed" },
      { id: "gru-001", name: "Gaussian Processes", type: "Statistical", accuracy: 92.8, trainedDate: new Date(), status: "inactive" },
    ];
    setModels(initialModels);
    setSelectedModel(initialModels[1].id);
    setDeployedModel(initialModels[1].id);
  }, []);

  useEffect(() => {
    if (!liveUpdate) return;
    const timeoutId = setTimeout(() => {
      const now = new Date();
      const generateDummyData = () => {
        const arr = [];
        for(let i=-24; i<=mpcParams.predictionHorizon; i++) {
          let type: any = i < 0 ? 'historical' : i === 0 ? 'current' : i <= mpcParams.controlHorizon ? 'control' : 'prediction';
          arr.push({
            timestamp: new Date(now.getTime() + i*900000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
            fullTimestamp: new Date(now.getTime() + i*900000),
            temperature: mpcParams.temperatureSetpoint + Math.sin(i/5) + (Math.random()*0.5),
            energy: 800 + Math.random()*200,
            comfort: 100 - Math.abs(Math.sin(i/5))*20,
            type
          })
        }
        return arr;
      };
      setSimulationData(generateDummyData());
    }, 300);
    return () => clearTimeout(timeoutId);
  }, [mpcParams, liveUpdate]);

  const avgTemperature = simulationData.reduce((sum, d) => sum + d.temperature, 0) / (simulationData.length || 1);
  const avgEnergy = simulationData.reduce((sum, d) => sum + d.energy, 0) / (simulationData.length || 1);
  const avgComfort = simulationData.reduce((sum, d) => sum + d.comfort, 0) / (simulationData.length || 1);

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="custom-tooltip" style={{ background: 'rgba(19, 21, 28, 0.95)', border: '1px solid rgba(255,255,255,0.1)', padding: '12px', borderRadius: '8px' }}>
          <p style={{ color: '#fff', fontSize: '12px', marginBottom: '8px' }}>{label}</p>
          {payload.map((entry: any, index: number) => (
            <div key={index} style={{ color: entry.color, fontSize: '12px', display: 'flex', justifyContent: 'space-between', width: '160px', marginBottom: '4px' }}>
              <span>{entry.name}:</span>
              <span style={{ fontFamily: 'monospace', fontWeight: 'bold' }}>{Number(entry.value).toFixed(1)}</span>
            </div>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="controller-container">
      <Topbar 
        title="MPC Command Center"
        subtitle="HVAC Optimization & Model Deployment"
        rightContent={
          <>
            <label className="live-toggle-wrapper" style={{
               display: 'flex', alignItems: 'center', gap: '8px', marginRight: '16px',
               padding: '6px 12px', background: 'rgba(255,255,255,0.05)', borderRadius: '20px'
            }}>
              <div className={`pulse-dot ${liveUpdate ? 'active' : ''}`} style={{
                 width: '8px', height: '8px', borderRadius: '50%', 
                 background: liveUpdate ? '#10b981' : 'rgba(255,255,255,0.5)', 
                 boxShadow: liveUpdate ? '0 0 8px #10b981' : 'none',
                 transition: '0.3s'
              }} />
              <span style={{fontSize: '12px', fontWeight: 600, color: 'rgba(255,255,255,0.5)'}}>
                {liveUpdate ? 'Live Feed' : 'Paused'}
              </span>
              <input type="checkbox" checked={liveUpdate} onChange={e => setLiveUpdate(e.target.checked)} hidden />
            </label>

            <button className="topbar-btn" onClick={handleRunSimulation} disabled={isSimulating}>
              {isSimulating ? 'Processing...' : '▶ Run Sim'}
            </button>
            <button className="topbar-btn success" onClick={() => setShowDeployModal(true)}>
              Deploy Config
            </button>
          </>
        }
      />
      <div className="dashboard-grid">
        <div className="visualization-panel">
          <div className="kpi-row">
            <div className="kpi-card">
              <div className="kpi-icon temp">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg>
              </div>
              <div className="kpi-data"><span className="label">Avg Temp</span><span className="value">{avgTemperature.toFixed(1)}°C</span></div>
            </div>
            <div className="kpi-card">
              <div className="kpi-icon energy">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
              </div>
              <div className="kpi-data"><span className="label">Proj. Energy</span><span className="value">{avgEnergy.toFixed(0)}</span></div>
            </div>
            <div className="kpi-card">
              <div className="kpi-icon comfort">
                <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none"><rect x="6" y="12" width="12" height="6" rx="2" stroke="currentColor" stroke-width="2"/><path d="M10 6c0 1 1 1 1 2s-1 1-1 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M14 6c0 1 1 1 1 2s-1 1-1 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              </div>
              <div className="kpi-data"><span className="label">Comfort Index</span><span className="value">{avgComfort.toFixed(0)}%</span></div>
            </div>
          </div>

          <div className="chart-section">
            <div className="chart-header-row">
              <h3>System Response Forecast</h3>
              <div className="chart-toggles">
                <button className={visibleSeries.temperature ? 'active' : ''} onClick={() => setVisibleSeries({...visibleSeries, temperature: !visibleSeries.temperature})}>Temp</button>
                <button className={visibleSeries.comfort ? 'active' : ''} onClick={() => setVisibleSeries({...visibleSeries, comfort: !visibleSeries.comfort})}>Comfort</button>
                <button className={chartView === 'full' ? 'active' : ''} onClick={() => setChartView('full')}>All</button>
                <button className={chartView === 'future' ? 'active' : ''} onClick={() => setChartView('future')}>Future</button>
              </div>
            </div>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartView === 'future' ? simulationData.filter(d => d.type !== 'historical') : simulationData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="timestamp" stroke="rgba(255,255,255,0.3)" tick={{fontSize: 10}} minTickGap={30} />
                <YAxis yAxisId="left" stroke="rgba(255,255,255,0.3)" domain={[15, 30]} tick={{fontSize: 10}} />
                <YAxis yAxisId="right" orientation="right" stroke="rgba(255,255,255,0.3)" domain={[0, 100]} tick={{fontSize: 10}} />
                <Tooltip content={<CustomTooltip />} />
                <ReferenceLine x={simulationData.find(d => d.type === 'current')?.timestamp} stroke="#ef4444" strokeDasharray="3 3" label={{position: 'top', value: 'NOW', fill: '#ef4444', fontSize: 10}} />
                <ReferenceLine yAxisId="left" y={mpcParams.temperatureSetpoint} stroke="#4ade80" strokeOpacity={0.3} strokeDasharray="5 5" />
                {visibleSeries.temperature && <Line yAxisId="left" type="monotone" dataKey="temperature" stroke="#3b82f6" strokeWidth={2} dot={false} activeDot={{r: 6}} />}
                {visibleSeries.comfort && <Line yAxisId="right" type="monotone" dataKey="comfort" stroke="#10b981" strokeWidth={2} dot={false} strokeOpacity={0.5} />}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="horizon-bar">
            <span className="horizon-title">Horizon Timeline</span>
            <div className="timeline-graphic">
              <div className="now-marker" />
              <div className="segment history">History (-6h)</div>
              <div className="segment control" style={{flex: mpcParams.controlHorizon}}>Control Action ({mpcParams.controlHorizon * 15}m)</div>
              <div className="segment prediction" style={{flex: mpcParams.predictionHorizon - mpcParams.controlHorizon}}>Prediction Only ({(mpcParams.predictionHorizon - mpcParams.controlHorizon) * 15}m)</div>
            </div>
          </div>
        </div>

        {/* --- RIGHT PANEL: Controls (Moved Second) --- */}
        <div className="controls-panel">
          <div className="panel-section">
            <div className="section-header"><h3>Quick Scenarios</h3></div>
            <div className="presets-mini-grid">
              {scenarioPresets.map(preset => (
                <div key={preset.name} className="preset-chip" onClick={() => applyPreset(preset.params)}>
                  <span>{preset.icon}</span> {preset.name}
                </div>
              ))}
            </div>
          </div>

          <div className="panel-section">
             <div className="section-header">
              <h3>Control Parameters</h3>
              <button style={{background: 'none', border:'none', color:'#3b82f6', cursor:'pointer', fontSize:'12px'}} onClick={() => setShowSaveModal(true)}>+ Save Config</button>
            </div>
            <div className={`control-card active-card`}>
              <div className="card-top"><span>Optimization Weight</span><span className="val">{(mpcParams.comfortWeight * 100).toFixed(0)}% Comfort</span></div>
              <input type="range" min="0" max="1" step="0.05" value={mpcParams.comfortWeight} onChange={(e) => setMPCParams({...mpcParams, comfortWeight: parseFloat(e.target.value), energyWeight: 1 - parseFloat(e.target.value)})} />
            </div>
            <div className="control-card">
              <div className="card-top"><span>Target Temp</span><span className="val">{mpcParams.temperatureSetpoint}°C</span></div>
              <input type="range" min="18" max="26" step="0.5" value={mpcParams.temperatureSetpoint} onChange={(e) => setMPCParams({...mpcParams, temperatureSetpoint: parseFloat(e.target.value)})} />
            </div>
             <div className="control-card">
              <div className="card-top"><span>Tolerance Band</span><span className="val">±{mpcParams.temperatureTolerance}°C</span></div>
              <input type="range" min="0.5" max="5" step="0.5" value={mpcParams.temperatureTolerance} onChange={(e) => setMPCParams({...mpcParams, temperatureTolerance: parseFloat(e.target.value)})} />
            </div>
          </div>

          <div className="accordion">
            <div className="accordion-header" onClick={() => setActiveSection(activeSection === 'advanced' ? '' : 'advanced')}>Advanced MPC Settings {activeSection === 'advanced' ? '▼' : '▶'}</div>
            {activeSection === 'advanced' && (
              <div className="accordion-body">
                <div className="control-card" style={{padding: '12px'}}>
                  <div className="card-top" style={{fontSize: '12px', marginBottom: '8px'}}><span>Control Horizon</span><span className="val">{mpcParams.controlHorizon} steps</span></div>
                  <input type="range" min="1" max="12" value={mpcParams.controlHorizon} onChange={e => setMPCParams({...mpcParams, controlHorizon: parseInt(e.target.value)})} />
                </div>
                <div className="control-card" style={{padding: '12px'}}>
                  <div className="card-top" style={{fontSize: '12px', marginBottom: '8px'}}><span>Prediction Horizon</span><span className="val">{mpcParams.predictionHorizon} steps</span></div>
                  <input type="range" min="4" max="24" value={mpcParams.predictionHorizon} onChange={e => setMPCParams({...mpcParams, predictionHorizon: parseInt(e.target.value)})} />
                </div>
              </div>
            )}
          </div>
          
          <div className="accordion">
             <div className="accordion-header" onClick={() => setActiveSection(activeSection === 'models' ? '' : 'models')}>Model Selection {activeSection === 'models' ? '▼' : '▶'}</div>
            {activeSection === 'models' && (
              <div className="accordion-body">
                {models.map(m => (
                  <div key={m.id} style={{padding: '10px', background: selectedModel === m.id ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255,255,255,0.05)', border: selectedModel === m.id ? '1px solid #3b82f6' : '1px solid transparent', borderRadius: '8px', cursor: 'pointer', fontSize: '13px'}} onClick={() => setSelectedModel(m.id)}>
                    <div style={{display:'flex', justifyContent:'space-between', fontWeight:'bold', color:'white'}}>{m.name} {m.status === 'deployed' && <span style={{color: '#10b981', fontSize: '10px'}}>● LIVE</span>}</div>
                    <div style={{color: 'rgba(255,255,255,0.6)', marginTop:'4px'}}>Acc: {m.accuracy}% | {m.type}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {showDeployModal && (
        <div className="modal-overlay" onClick={() => setShowDeployModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header"><h2>Confirm Deployment</h2><button className="close-btn" onClick={() => setShowDeployModal(false)}>×</button></div>
            <div className="modal-body">
              <div className="warning-box"><span>⚠️</span><span>You are writing to live HVAC registers. This will override existing schedules.</span></div>
              <p style={{color: 'rgba(255,255,255,0.7)', fontSize: '14px', lineHeight: '1.5'}}>Model <strong>{models.find(m => m.id === selectedModel)?.name}</strong> will take control with a comfort weight of <strong>{(mpcParams.comfortWeight * 100).toFixed(0)}%</strong>.</p>
            </div>
            <div className="modal-footer"><button className="cancel" onClick={() => setShowDeployModal(false)}>Cancel</button><button className="confirm" onClick={handleDeployModel}>Deploy to Controller</button></div>
          </div>
        </div>
      )}
      {showSaveModal && (
        <div className="modal-overlay" onClick={() => setShowSaveModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
             <div className="modal-header"><h2>Save Configuration</h2></div>
            <div className="modal-body">
               <input autoFocus type="text" placeholder="Config Name (e.g. Winter Night)" value={configName} onChange={e => setConfigName(e.target.value)} style={{width: '100%', padding: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'white', borderRadius: '6px', outline: 'none'}} />
            </div>
             <div className="modal-footer"><button className="cancel" onClick={() => setShowSaveModal(false)}>Cancel</button><button className="confirm" style={{background: '#3b82f6', color: 'white'}} onClick={saveConfiguration}>Save</button></div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ControllerTab;
