import React, { useState, useEffect } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Area,
  AreaChart,
  Brush,
} from "recharts";
import "./DashboardTab.scss";
import "./components/ChartTooltip.scss";
import Topbar from "./components/Topbar";

interface ChartDataPoint {
  timestamp: string;
  fullTimestamp: Date;
  value: number;
  predicted?: boolean;
}
interface EnergyFloorData extends ChartDataPoint {
  floor3: number;
  floor4: number;
}
interface DeviationDataPoint {
  metric: string;
  actual: number;
  ideal: number;
  deviation: number;
  status: 'critical' | 'warning' | 'good';
  impact: string;
}
interface SensorData {
  temperature: ChartDataPoint[];
  occupancy: ChartDataPoint[];
  airQuality: ChartDataPoint[];
  energy: ChartDataPoint[];
  energyByFloor: EnergyFloorData[];
  deviations: DeviationDataPoint[];
}
interface TimeRange {
  start: number;
  end: number;
}
const DashboardTab = () => {
  // --- State ---
  const [activeTimeRange, setActiveTimeRange] = useState<string>("24hr");
  const [selectedFloors, setSelectedFloors] = useState<string[]>(["floor1", "floor2", "floor3"]);
  const [timeRange, setTimeRange] = useState<TimeRange>({ start: 0, end: 100 });
  const [refreshKey, setRefreshKey] = useState<number>(0);
  const [sensorData, setSensorData] = useState<SensorData | null>(null);
  // --- Data Generation ---
  const generateTimeBasedData = (hours: number, max: number, min: number = 0, volatility: number = 0.15): ChartDataPoint[] => {
    const data: ChartDataPoint[] = [];
    const now = new Date();
    const msPerInterval = 900000;
    const totalIntervals = hours * 4;
    let lastValue = (max + min) / 2;
    for (let i = 0; i < totalIntervals; i++) {
      const timestamp = new Date(now.getTime() - (totalIntervals - i) * msPerInterval);
      const hour = timestamp.getHours();
      let baseValue = lastValue;
      if (hour >= 9 && hour <= 17) baseValue += (max - min) * 0.2;
      else if (hour >= 0 && hour <= 6) baseValue -= (max - min) * 0.15;
      
      const change = (Math.random() - 0.5) * (max - min) * volatility;
      lastValue = Math.max(min, Math.min(max, baseValue + change));
      
      let timeString;
      if (hours <= 24) timeString = timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      else timeString = timestamp.toLocaleDateString([], { month: "short", day: "numeric" });
      data.push({
        timestamp: timeString,
        fullTimestamp: timestamp,
        value: lastValue,
        predicted: i > totalIntervals * 0.75,
      });
    }
    return data;
  };
  const generateEnergyByFloor = (hours: number): EnergyFloorData[] => {
    const data: EnergyFloorData[] = [];
    const now = new Date();
    const totalIntervals = hours * 4;
    for (let i = 0; i < totalIntervals; i++) {
      const timestamp = new Date(now.getTime() - (totalIntervals - i) * 900000);
      let timeString;
      if (hours <= 24) timeString = timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      else timeString = timestamp.toLocaleDateString([], { month: "short", day: "numeric" });
      
      data.push({
        timestamp: timeString,
        fullTimestamp: timestamp,
        value: 2000 + Math.random() * 500,
        floor3: 800 + Math.random() * 200,
        floor4: 1200 + Math.random() * 300,
        predicted: i > totalIntervals * 0.75,
      });
    }
    return data;
  };
  const generateDeviationData = (): DeviationDataPoint[] => {
    return [
      { metric: "Temperature", actual: 23.5, ideal: 22, deviation: 6.8, status: 'warning', impact: "Slight Efficiency Loss" },
      { metric: "Occupancy", actual: 180, ideal: 150, deviation: 20, status: 'critical', impact: "Zone Overcrowded" },
      { metric: "Air Quality", actual: 42, ideal: 50, deviation: -16, status: 'good', impact: "Optimal Conditions" },
      { metric: "Energy", actual: 1450, ideal: 1200, deviation: 20.8, status: 'critical', impact: "Baseline Exceeded" },
    ];
  };
  useEffect(() => {
    let hours = 24;
    if (activeTimeRange === "7days") hours = 168;
    if (activeTimeRange === "30days") hours = 720;
    const newData = {
      temperature: generateTimeBasedData(hours, 28, 18, 0.1),
      occupancy: generateTimeBasedData(hours, 200, 20, 0.25),
      airQuality: generateTimeBasedData(hours, 100, 30, 0.15),
      energy: generateTimeBasedData(hours, 2000, 500, 0.2),
      energyByFloor: generateEnergyByFloor(hours),
      deviations: [] as DeviationDataPoint[]
    };
    newData.deviations = generateDeviationData();
    setSensorData(newData);
  }, [activeTimeRange, refreshKey]);
  // --- Helpers ---
  const getFilteredData = (data: any[]) => {
    if (!data) return [];
    const startIdx = Math.floor((timeRange.start / 100) * data.length);
    const endIdx = Math.ceil((timeRange.end / 100) * data.length);
    return data.slice(startIdx, endIdx);
  };
  const calculateMetrics = (data: ChartDataPoint[]) => {
    if (!data || !data.length) return { avg: 0, max: 0, trend: 0 };
    const actual = data.filter(d => !d.predicted);
    if (!actual.length) return { avg: 0, max: 0, trend: 0 };
    
    const max = Math.max(...actual.map(d => d.value));
    const avg = actual.reduce((a, b) => a + b.value, 0) / actual.length;
    const current = actual[actual.length - 1].value;
    const trend = actual.length > 1 ? ((current - actual[0].value) / actual[0].value) * 100 : 0;
    return { avg, max, trend };
  };
  const resetTimeline = () => setTimeRange({ start: 0, end: 100 });
  if (!sensorData) return <div className="loading-state">Loading Analytics...</div>;
  const filteredTemp = getFilteredData(sensorData.temperature);
  const filteredOcc = getFilteredData(sensorData.occupancy);
  const filteredAir = getFilteredData(sensorData.airQuality);
  const filteredEnergy = getFilteredData(sensorData.energy);
  // --- NEW: THE NEAT BACKGROUND TOOLTIP ---
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="chart-tooltip-glass">
          <div className="tooltip-header">{label}</div>
          <div className="tooltip-body">
            {payload.map((entry: any, index: number) => (
              <div key={index} className="tooltip-row">
                <div className="row-left">
                  <div className="indicator" style={{ backgroundColor: entry.color, color: entry.color }} />
                  <span>{entry.name}</span>
                </div>
                <div className="row-value">
                  {Number(entry.value).toFixed(1)}
                  <span className="unit">{entry.unit || ''}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }
    return null;
  };
  // --- Chart Card ---
  const ChartCard = ({ title, subtitle, data, color, type = "area", unit }: any) => {
    const metrics = calculateMetrics(data);
    return (
      <div className="chart-card">
        <div className="card-header">
          <div className="title-group">
            <h3>{title}</h3>
            <div className="subtitle">{subtitle}</div>
          </div>
          <div className="stats-group">
            <div className="stat"><span className="label">AVG</span><span className="val">{metrics.avg.toFixed(1)}</span></div>
            <div className="stat"><span className="label">PEAK</span><span className="val">{metrics.max.toFixed(1)}</span></div>
          </div>
        </div>
        <div className="chart-area">
          <ResponsiveContainer width="100%" height="100%">
            {type === 'bar' ? (
              <BarChart data={data}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis 
                  dataKey="timestamp" 
                  stroke="rgba(255,255,255,0.3)" 
                  tickLine={false} 
                  tick={{fontSize:10}} 
                  minTickGap={30} 
                />
                <YAxis stroke="rgba(255,255,255,0.3)" tickLine={false} tick={{fontSize:10}} domain={['auto','auto']} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="value" fill={color} name={title} unit={unit} radius={[4, 4, 0, 0]} opacity={0.8} />
              </BarChart>
            ) : (
              <AreaChart data={data}>
                <defs>
                   <linearGradient id={`grad-${title}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={color} stopOpacity={0.4}/>
                      <stop offset="95%" stopColor={color} stopOpacity={0}/>
                   </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis 
                  dataKey="timestamp" 
                  stroke="rgba(255,255,255,0.3)" 
                  tickLine={false} 
                  tick={{fontSize:10}} 
                  minTickGap={30} 
                />
                <YAxis stroke="rgba(255,255,255,0.3)" tickLine={false} tick={{fontSize:10}} domain={['auto','auto']} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="value" stroke={color} fill={`url(#grad-${title})`} name={title} unit={unit} strokeWidth={2} />
              </AreaChart>
            )}
          </ResponsiveContainer>
        </div>
      </div>
    );
  };
  return (
    <div className="dashboard-container">
      {/* Header */}
      <Topbar 
        title="Historical Analytics"
        subtitle="Deep dive into sensor logs and anomaly history"
        rightContent={
          <>
             <div className="topbar-meta">Last Sync: 10:42 AM</div>
             <button className="topbar-btn" onClick={() => setRefreshKey(p => p + 1)}>
               Refresh Dataset
             </button>
             <button className="topbar-btn primary">
               Export PDF Report
             </button>
             <button className="topbar-btn">
               Download CSV
             </button>
          </>
        }
      />
      <div className="dashboard-layout">
        <main className="main-stage">
          <div className="dashboard-scroll-area">
            <section className="analytics-grid">
               <ChartCard title="Temperature Log" subtitle="Zone Avg" data={filteredTemp} color="#ef4444" unit="°C" />
               <ChartCard title="Weather" subtitle="Avg" data={filteredEnergy} color="#f59e0b" unit="kWh" />
               <ChartCard title="Occupancy" subtitle="Density" data={filteredOcc} color="#8b5cf6" type="bar" unit="Ppl" />
               <ChartCard title="Air Quality" subtitle="CO2 / PM2.5" data={filteredAir} color="#10b981" unit="AQI" />
               <div className="chart-card wide">
                  <div className="card-header">
                     <div className="title-group">
                       <h3>Energy Distribution by Floor</h3>
                       <div className="subtitle">Stacked view of power draw per level</div>
                     </div>
                  </div>
                  <div className="chart-area">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={getFilteredData(sensorData.energyByFloor)}>
                         <defs>
                            <linearGradient id="g-f3" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4}/><stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/></linearGradient>
                            <linearGradient id="g-f4" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.4}/><stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}/></linearGradient>
                         </defs>
                         <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.05)" />
                         <XAxis 
                           dataKey="timestamp" 
                           stroke="rgba(255,255,255,0.3)" 
                           tickLine={false} 
                           style={{fontSize:'10px'}} 
                           minTickGap={30}
                         />
                         <YAxis stroke="rgba(255,255,255,0.3)" tickLine={false} style={{fontSize:'10px'}}/>
                         <Tooltip content={<CustomTooltip />} />
                         <Legend />
                         <Area type="monotone" dataKey="floor3" name="Floor 3" stroke="#3b82f6" fill="url(#g-f3)" stackId="1" unit="kWh" />
                         <Area type="monotone" dataKey="floor4" name="Floor 4" stroke="#8b5cf6" fill="url(#g-f4)" stackId="1" unit="kWh" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
               </div>
            </section>
          </div>
          <section className="master-timeline-section">
            <div className="section-header">
              <h3>Global Time Scrubber</h3>
              <span className="range-display">
                Zoomed: {timeRange.start.toFixed(0)}% - {timeRange.end.toFixed(0)}%
              </span>
            </div>
            <div className="timeline-wrapper">
               <ResponsiveContainer width="100%" height="100%">
                 <LineChart data={sensorData.temperature}>
                   <Line type="monotone" dataKey="value" stroke="#4b5563" dot={false} strokeWidth={1} />
                   <Brush 
                     dataKey="timestamp" 
                     height={18} 
                     stroke="#3b82f6" 
                     fill="rgba(59, 130, 246, 0.05)"
                     onChange={(range: any) => {
                       if(range.startIndex !== undefined) {
                         const total = sensorData.temperature.length;
                         setTimeRange({ start: (range.startIndex/total)*100, end: (range.endIndex/total)*100 });
                       }
                     }}
                   />
                 </LineChart>
               </ResponsiveContainer>
            </div>
          </section>
        </main>
        <aside className="context-sidebar">
          <div className="sidebar-section">
            <div className="section-title">
              <span>View Settings</span>
            </div>
            
            <div className="control-group-vertical">
              <label>Time Range</label>
              <div className="pill-grid">
                {['24hr', '7days', '30days', '1M', '3M', '1Y'].map(r => (
                  <button 
                    key={r} 
                    className={`pill-btn ${activeTimeRange === r ? 'active' : ''}`}
                    onClick={() => { setActiveTimeRange(r); resetTimeline(); }}
                  >
                    {r.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div className="control-group-vertical">
              <label>Floor Filter</label>
              <div className="pill-grid">
                {['1', '2', '3'].map(f => (
                  <button 
                     key={f}
                     className={`pill-btn ${selectedFloors.includes('floor'+f) ? 'active' : ''}`}
                     onClick={() => {
                       const val = 'floor'+f;
                       setSelectedFloors(p => p.includes(val) ? p.filter(x => x !== val) : [...p, val]);
                     }}
                  >
                    FL-{f}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="sidebar-section">
            <div className="section-title">
              <span>Key Insights</span>
            </div>
            <div className="insights-list">
              <div className="insight-item">
                <div className="dot warning"></div>
                <p><strong>Energy Spike:</strong> Floor 3 exceeded baseline by 12% at 14:00.</p>
              </div>
              <div className="insight-item">
                <div className="dot success"></div>
                <p><strong>Optimization:</strong> HVAC efficiency improved by 4% vs last week.</p>
              </div>
              <div className="insight-item">
                <div className="dot neutral"></div>
                <p><strong>Occupancy:</strong> Peak density observed in Conference Zone A.</p>
              </div>
            </div>
          </div>
          
          <div className="sidebar-section" style={{borderBottom: 'none'}}>
            <div className="section-title">
              <span>Anomaly Detection Log</span>
            </div>
            <div className="anomaly-list">
              {sensorData.deviations.map(dev => (
                <div key={dev.metric} className={`anomaly-item ${dev.status}`}>
                   <div className="anomaly-top">
                     <span className="metric-name">{dev.metric}</span>
                     <span className="status">{dev.status}</span>
                   </div>
                   <div className="deviation-value">
                     {dev.deviation > 0 ? '+' : ''}{dev.deviation.toFixed(1)}% deviation
                   </div>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};
export default DashboardTab;
