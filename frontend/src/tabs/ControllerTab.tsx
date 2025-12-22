import React, { useState, useEffect } from "react";
import { ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Area } from "recharts";
import "./ControllerTab.scss";
import Topbar from "./components/Topbar";
import RightSidebar, { SidebarSection } from "./components/RightSidebar";
import MainContent, { ContentArea, Section } from "./components/MainContent";

// --- Interfaces ---
interface MPCParameters {
  predictionHorizon: number;
  controlHorizon: number;
  comfortWeight: number;
  energyWeight: number;
  temperatureSetpoint: number;
  temperatureTolerance: number;
  optimizationInterval: number;
  maxHvacChange: number;
}

const ControllerTab: React.FC = () => {
  const [mpcParams, setMPCParams] = useState<MPCParameters>({
    predictionHorizon: 24, // 6 hours
    controlHorizon: 8,    // 2 hours
    comfortWeight: 0.6,
    energyWeight: 0.4,
    temperatureSetpoint: 22.0,
    temperatureTolerance: 1.5,
    optimizationInterval: 15,
    maxHvacChange: 20
  });
  
  const [simulationData, setSimulationData] = useState<any[]>([]);
  const [hvacState, setHvacState] = useState({ fanSpeed: 45, valvePos: 32, heating: true });
  const [activeConstraints, setActiveConstraints] = useState<string[]>(['Rate Limit', 'Valve Max']);
  const [deploymentActive, setDeploymentActive] = useState(true);

  // --- Mock Data Generator ---
  useEffect(() => {
    const data = [];
    const now = new Date();
    // Generate 4 hours past, 6 hours future
    for (let i = -16; i <= mpcParams.predictionHorizon; i++) {
        const isFuture = i > 0;
        const baseTemp = 22 + Math.sin(i/8) * 1.5;
        data.push({
            time: new Date(now.getTime() + i * 900000).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
            temp: baseTemp + (Math.random()*0.2),
            setpoint: mpcParams.temperatureSetpoint,
            energy: isFuture ? Math.max(0, 50 + Math.sin(i)*20) : null,
            comfort: 100 - Math.abs(baseTemp - mpcParams.temperatureSetpoint) * 10,
            isFuture,
            isControl: i > 0 && i <= mpcParams.controlHorizon
        });
    }
    setSimulationData(data);
  }, [mpcParams]);

  return (
    <div className="controller-container">
      <Topbar 
        title="MPC Controller" 
        subtitle="Real-time Optimization Engine" 
        rightContent={
          <div className="topbar-actions-group">
            <div className={`system-status-pill ${deploymentActive ? 'active' : 'paused'}`}>
                <span className="dot"></span> {deploymentActive ? 'Auto-Control Active' : 'Manual Override'}
            </div>
            <button className={`btn btn-sm ${deploymentActive ? 'btn-danger' : 'btn-primary'}`} onClick={() => setDeploymentActive(!deploymentActive)}>
                {deploymentActive ? 'Stop' : 'Start'}
            </button>
          </div>
        } 
      />
      
      <MainContent
        sidebar={
          <RightSidebar width="360px">
            {/* 1. Live HVAC State (Visual) */}
            <SidebarSection title="Live Equipment State">
                <div className="hvac-schematic-box">
                    <div className="schematic-row">
                        <span className="label">Fan Speed</span>
                        <div className="state-bar-track">
                            <div className="state-bar-fill" style={{width: `${hvacState.fanSpeed}%`}}></div>
                        </div>
                        <span className="value">{hvacState.fanSpeed}%</span>
                    </div>
                    <div className="schematic-row">
                        <span className="label">Heating Valve</span>
                        <div className="state-bar-track">
                            <div className="state-bar-fill heat" style={{width: `${hvacState.valvePos}%`}}></div>
                        </div>
                        <span className="value">{hvacState.valvePos}%</span>
                    </div>
                    <div className="status-grid">
                        <div className={`status-item ${hvacState.heating ? 'active' : ''}`}>Heating</div>
                        <div className="status-item">Cooling</div>
                        <div className="status-item active">Vent</div>
                    </div>
                </div>
            </SidebarSection>

            {/* 2. Objectives (Sliders) */}
            <SidebarSection title="Optimization Objectives">
                <div className="weight-control">
                    <div className="wc-labels">
                        <span>Comfort Priority</span>
                        <span>Energy Savings</span>
                    </div>
                    <input 
                        type="range" min="0" max="1" step="0.1" 
                        value={mpcParams.comfortWeight} 
                        onChange={e => setMPCParams({...mpcParams, comfortWeight: parseFloat(e.target.value)})}
                        className="balance-slider"
                    />
                    <div className="wc-values">
                        <span className="c-val">{(mpcParams.comfortWeight * 100).toFixed(0)}%</span>
                        <span className="e-val">{((1-mpcParams.comfortWeight) * 100).toFixed(0)}%</span>
                    </div>
                </div>
            </SidebarSection>

            {/* 3. Advanced MPC Settings (Restored from previous version) */}
            <SidebarSection title="Advanced Configuration" collapsible={true} defaultExpanded={false}>
                 <div className="advanced-input-group">
                    <label>Prediction Horizon</label>
                    <div className="input-row">
                        <input type="range" min="12" max="48" step="4" value={mpcParams.predictionHorizon} onChange={e => setMPCParams({...mpcParams, predictionHorizon: parseInt(e.target.value)})} />
                        <span className="val">{mpcParams.predictionHorizon * 15}m</span>
                    </div>
                 </div>
                 <div className="advanced-input-group">
                    <label>Control Horizon</label>
                    <div className="input-row">
                        <input type="range" min="4" max="12" step="1" value={mpcParams.controlHorizon} onChange={e => setMPCParams({...mpcParams, controlHorizon: parseInt(e.target.value)})} />
                        <span className="val">{mpcParams.controlHorizon * 15}m</span>
                    </div>
                 </div>
                 <div className="advanced-input-group">
                    <label>Opt. Interval</label>
                    <div className="input-row">
                        <input type="number" value={mpcParams.optimizationInterval} onChange={e => setMPCParams({...mpcParams, optimizationInterval: parseInt(e.target.value)})} />
                        <span className="unit">min</span>
                    </div>
                 </div>
            </SidebarSection>
            
            <SidebarSection title="Active Constraints">
                <div className="constraint-list">
                    {activeConstraints.map((c, i) => (
                        <div key={i} className="constraint-tag">
                            <span className="icon">🔒</span> {c}
                        </div>
                    ))}
                </div>
            </SidebarSection>
          </RightSidebar>
        }
        sidebarWidth="360px"
      >
        <ContentArea padding="compact" gap="16px">
            
            {/* 1. KPI Hero Row (High Level Status) */}
            <div className="kpi-hero-row">
                 <div className="kpi-hero-card">
                     <div className="kpi-label">Avg Temp</div>
                     <div className="kpi-val">21.8<span className="unit">°C</span></div>
                     <div className="kpi-trend up">↑ 0.2</div>
                 </div>
                 <div className="kpi-hero-card">
                     <div className="kpi-label">Comfort Idx</div>
                     <div className="kpi-val">94<span className="unit">%</span></div>
                     <div className="kpi-trend flat">− 0.0</div>
                 </div>
                 <div className="kpi-hero-card">
                     <div className="kpi-label">Energy Rate</div>
                     <div className="kpi-val">12.4<span className="unit">kW</span></div>
                     <div className="kpi-trend down">↓ 1.2</div>
                 </div>
                 <div className="kpi-hero-card highlight">
                     <div className="kpi-label">Est. Cost</div>
                     <div className="kpi-val">£2.48<span className="unit">/hr</span></div>
                 </div>
            </div>

            {/* 2. Model Health Row (Restored from Industrial Glass version) */}
            <div className="model-health-row">
                <div className="health-label">Active Models:</div>
                <div className="model-pill ready">
                    <span className="icon">🌡️</span> Temperature <span className="acc">94%</span>
                </div>
                <div className="model-pill ready">
                    <span className="icon">👥</span> Occupancy <span className="acc">87%</span>
                </div>
                <div className="model-pill warning">
                    <span className="icon">🌤️</span> Weather API <span className="acc">--</span>
                </div>
                <div className="model-pill ready">
                    <span className="icon">⚡</span> Energy <span className="acc">91%</span>
                </div>
            </div>

            {/* 3. Main Chart Section */}
            <Section className="chart-wrapper-section">
                <div className="cw-header">
                    <h3>Optimal Control Trajectory</h3>
                    <div className="cw-legend">
                        <span><span className="line temp"></span> Temp</span>
                        <span><span className="line set"></span> Setpoint</span>
                        <span><span className="area energy"></span> Energy Plan</span>
                    </div>
                </div>
                <div className="cw-body">
                    <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={simulationData} margin={{top: 10, right: 0, left: 0, bottom: 0}}>
                            <defs>
                                <linearGradient id="energyFill" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.2}/>
                                    <stop offset="100%" stopColor="#f59e0b" stopOpacity={0}/>
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                            <XAxis dataKey="time" stroke="rgba(255,255,255,0.3)" style={{fontSize: 10}} tickLine={false} minTickGap={30} />
                            <YAxis yAxisId="left" stroke="rgba(255,255,255,0.3)" style={{fontSize: 10}} tickLine={false} axisLine={false} domain={[18, 26]} />
                            <YAxis yAxisId="right" orientation="right" stroke="rgba(255,255,255,0.3)" style={{fontSize: 10}} tickLine={false} axisLine={false} />
                            <Tooltip contentStyle={{backgroundColor: '#0b0d12', border: '1px solid #333'}} />
                            
                            <ReferenceLine x={simulationData.find(d=>d.isFuture)?.time} stroke="#ef4444" strokeDasharray="3 3" label={{value: "NOW", position: "insideTopLeft", fill: "#ef4444", fontSize: 10}} />
                            
                            <Area yAxisId="right" type="step" dataKey="energy" fill="url(#energyFill)" stroke="#f59e0b" strokeWidth={1} />
                            <Line yAxisId="left" type="monotone" dataKey="setpoint" stroke="#10b981" strokeDasharray="5 5" dot={false} strokeWidth={1.5} />
                            <Line yAxisId="left" type="monotone" dataKey="temp" stroke="#3b82f6" strokeWidth={3} dot={false} activeDot={{r: 6}} />
                        </ComposedChart>
                    </ResponsiveContainer>
                </div>
                
                {/* Visual Horizon Track */}
                <div className="horizon-track">
                    <div className="track-segment history" style={{flex: 16}}>History (4h)</div>
                    <div className="track-segment control" style={{flex: mpcParams.controlHorizon}}>Control ({mpcParams.controlHorizon * 15}m)</div>
                    <div className="track-segment prediction" style={{flex: mpcParams.predictionHorizon - mpcParams.controlHorizon}}>Prediction</div>
                </div>
            </Section>

            {/* 4. Scenario Comparison */}
            <div className="scenario-grid">
                <div className="scenario-card active">
                    <div className="sc-header">Current Strategy</div>
                    <div className="sc-stat"><span>Comfort Violation</span><strong>0.2%</strong></div>
                    <div className="sc-stat"><span>Energy (24h)</span><strong>145 kWh</strong></div>
                </div>
                <div className="scenario-card alt">
                    <div className="sc-header">Aggressive Savings</div>
                    <div className="sc-stat"><span>Comfort Violation</span><strong className="warn">4.5%</strong></div>
                    <div className="sc-stat"><span>Energy (24h)</span><strong className="good">110 kWh</strong></div>
                    <button className="btn btn-secondary btn-sm full-width mt-sm">Apply</button>
                </div>
                <div className="scenario-card alt">
                    <div className="sc-header">Max Comfort</div>
                    <div className="sc-stat"><span>Comfort Violation</span><strong className="good">0.0%</strong></div>
                    <div className="sc-stat"><span>Energy (24h)</span><strong className="warn">180 kWh</strong></div>
                    <button className="btn btn-secondary btn-sm full-width mt-sm">Apply</button>
                </div>
            </div>

        </ContentArea>
      </MainContent>
    </div>
  );
};

export default ControllerTab;
