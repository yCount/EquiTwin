import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
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
  Line,
  LineChart,
} from "recharts";
import "./DashboardTab.scss";
import "./components/ChartTooltip.scss";
import Topbar from "./components/Topbar";
import TimelineControl from "./components/TimelineControl";
import RightSidebar, { SidebarSection } from "./components/RightSidebar";
import {
  EyeIcon,
  EyeOffIcon,
  SunIcon,
  TemperatureIcon,
  AirQualityIcon,
  OccupancyIcon,
  EnergyIcon,
  DeviationIcon,
  CameraIcon,
  DownloadIcon,
} from "./components/Icons";

interface ChartDataPoint {
  timestamp: string;
  fullTimestamp: Date;
  value: number;
}

interface WeatherDataPoint extends ChartDataPoint {
  condition: 'sunny' | 'partly-cloudy' | 'cloudy' | 'rainy' | 'snowy';
  temperature: number;
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
  weather: WeatherDataPoint[];
  energyByFloor: EnergyFloorData[];
  deviations: DeviationDataPoint[];
}

interface TimeRange {
  start: number | null;
  end: number | null;
}

// Weather condition colors
const WEATHER_COLORS = {
  'sunny': '#f59e0b',
  'partly-cloudy': '#94a3b8',
  'cloudy': '#64748b',
  'rainy': '#3b82f6',
  'snowy': '#e0f2fe',
};

const getRangeConfig = (range: string) => {
  switch (range) {
    case "24hr":   return { hours: 120,   interval: 900000, selectedHours: 24 };      
    case "7days":  return { hours: 840,  interval: 3600000, selectedHours: 168 };     
    case "30days": return { hours: 3600,  interval: 14400000, selectedHours: 720 };   
    case "3M":     return { hours: 10800, interval: 43200000, selectedHours: 2160 };  
    case "1Y":     return { hours: 43800, interval: 86400000, selectedHours: 8760 };  
    case "ALL":    return { hours: 109500, interval: 259200000, selectedHours: 21900 };  
    default:       return { hours: 120,   interval: 900000, selectedHours: 24 };
  }
};

const getMetricIcon = (metric: string) => {
  switch (metric) {
    case 'Temperature': return <TemperatureIcon />;
    case 'Occupancy':   return <OccupancyIcon />;
    case 'Air Quality': return <AirQualityIcon />;
    default:            return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>;
  }
};

const DashboardTab = () => {
  const [activeTimeRange, setActiveTimeRange] = useState<string>("24hr");
  const [selectedFloors, setSelectedFloors] = useState<string[]>(["Level 3", "Level 4"]);
  const [timeRange, setTimeRange] = useState<TimeRange>({ start: null, end: null });
  const [refreshKey, setRefreshKey] = useState<number>(0);
  const [sensorData, setSensorData] = useState<SensorData | null>(null);
  const [timelineViewRange, setTimelineViewRange] = useState<{ start: number; end: number } | null>(null);

  const generateData = useMemo(() => {
    const config = getRangeConfig(activeTimeRange);
    const totalPoints = Math.floor((config.hours * 3600000) / config.interval);
    const nowTime = new Date().getTime();

    const makeSeries = (min: number, max: number): ChartDataPoint[] => {
        const arr = new Array(totalPoints);
        let lastVal = (min + max) / 2;
        
        for(let i = 0; i < totalPoints; i++) {
            const t = nowTime - (totalPoints - i) * config.interval;
            const change = (Math.random() - 0.5) * (max - min) * 0.1;
            lastVal = Math.max(min, Math.min(max, lastVal + change));
            
            const date = new Date(t);
            const hour = date.getHours();
            let finalVal = lastVal;
            if (hour >= 9 && hour <= 17) finalVal += (max - min) * 0.05;
            
            arr[i] = {
                timestamp: "", 
                fullTimestamp: date,
                value: finalVal
            };
        }
        return arr;
    };

    const makeWeatherSeries = (): WeatherDataPoint[] => {
        const arr = new Array(totalPoints);
        let lastTemp = 20;
        const conditions: ('sunny' | 'partly-cloudy' | 'cloudy' | 'rainy' | 'snowy')[] = 
          ['sunny', 'partly-cloudy', 'cloudy', 'rainy', 'snowy'];
        let currentCondition = 'partly-cloudy' as typeof conditions[number];
        let conditionDuration = 0;
        
        for(let i = 0; i < totalPoints; i++) {
            const t = nowTime - (totalPoints - i) * config.interval;
            const date = new Date(t);
            const hour = date.getHours();
            const month = date.getMonth();
            
            if (conditionDuration === 0) {
                const isWinter = month === 11 || month === 0 || month === 1;
                const isSummer = month >= 5 && month <= 7;
                
                if (isWinter) {
                    const winterWeights = [0.1, 0.2, 0.3, 0.2, 0.2];
                    const rand = Math.random();
                    let cumulative = 0;
                    for (let j = 0; j < winterWeights.length; j++) {
                        cumulative += winterWeights[j];
                        if (rand < cumulative) {
                            currentCondition = conditions[j];
                            break;
                        }
                    }
                } else if (isSummer) {
                    const summerWeights = [0.4, 0.3, 0.2, 0.1, 0.0];
                    const rand = Math.random();
                    let cumulative = 0;
                    for (let j = 0; j < summerWeights.length; j++) {
                        cumulative += summerWeights[j];
                        if (rand < cumulative) {
                            currentCondition = conditions[j];
                            break;
                        }
                    }
                } else {
                    currentCondition = conditions[Math.floor(Math.random() * 4)];
                }
                
                conditionDuration = Math.floor(Math.random() * 8) + 3;
            }
            conditionDuration--;
            
            const seasonalBase = (month === 11 || month === 0 || month === 1) ? 5 : 
                                (month >= 5 && month <= 7) ? 25 : 15;
            const hourlyVariation = hour >= 12 && hour <= 16 ? 5 : hour >= 0 && hour <= 6 ? -5 : 0;
            
            const tempChange = (Math.random() - 0.5) * 2;
            lastTemp = Math.max(-5, Math.min(35, lastTemp + tempChange));
            
            const targetTemp = seasonalBase + hourlyVariation;
            lastTemp = lastTemp * 0.9 + targetTemp * 0.1;
            
            let conditionTempAdjust = 0;
            if (currentCondition === 'sunny') conditionTempAdjust = 2;
            if (currentCondition === 'rainy') conditionTempAdjust = -2;
            if (currentCondition === 'snowy') conditionTempAdjust = -5;
            
            arr[i] = {
                timestamp: "", 
                fullTimestamp: date,
                value: lastTemp + conditionTempAdjust,
                condition: currentCondition,
                temperature: lastTemp + conditionTempAdjust
            };
        }
        return arr;
    };

    return {
      temperature: makeSeries(18, 28),
      occupancy: makeSeries(20, 200),
      airQuality: makeSeries(30, 100),
      weather: makeWeatherSeries(),
      energyByFloor: makeSeries(1000, 3000).map(d => ({
         fullTimestamp: d.fullTimestamp,
         timestamp: "",
         value: d.value,
         floor3: d.value * 0.4,
         floor4: d.value * 0.6
      })),
      deviations: [
        { metric: "Temperature", actual: 23.5, ideal: 22, deviation: 6.8, status: 'warning', impact: "Efficiency" },
        { metric: "Occupancy", actual: 180, ideal: 150, deviation: 20, status: 'critical', impact: "Crowding" },
        { metric: "Air Quality", actual: 42, ideal: 50, deviation: -16, status: 'good', impact: "Optimal" },
        { metric: "Weather", actual: 22, ideal: 20, deviation: 10, status: 'good', impact: "Forecast" },
      ] as DeviationDataPoint[]
    };
  }, [activeTimeRange, refreshKey]);

  useEffect(() => {
      setSensorData(generateData);
      
      if (generateData.temperature.length > 0) {
        const dataLength = generateData.temperature.length;
        const endTime = generateData.temperature[dataLength - 1].fullTimestamp.getTime();
        const config = getRangeConfig(activeTimeRange);
        const selectedDuration = config.selectedHours * 3600000;
        const zoomStart = endTime - selectedDuration;
        setTimeRange({ start: zoomStart, end: endTime });
        setTimelineViewRange(null);
      } else {
        setTimeRange({ start: null, end: null });
        setTimelineViewRange(null);
      }
  }, [generateData, activeTimeRange]);

  const filteredData = useMemo(() => {
    if (!sensorData) return null;
    if (!timeRange.start || !timeRange.end) return sensorData;

    const selectedDuration = timeRange.end - timeRange.start;
    const shouldRegenerateData = selectedDuration <= 604800000;
    
    if (shouldRegenerateData) {
      // (Data regeneration logic omitted for brevity in thought process, but included here for completeness)
      const getIntervalForDuration = (duration: number) => {
        if (duration <= 86400000) return 900000;
        if (duration <= 259200000) return 1800000;
        if (duration <= 604800000) return 3600000;
        return 3600000;
      };
      
      const interval = getIntervalForDuration(selectedDuration);
      const numPoints = Math.floor(selectedDuration / interval);
      
      const regenerateForRange = (min: number, max: number) => {
        const arr = new Array(numPoints);
        let lastVal = (min + max) / 2;
        
        for(let i = 0; i < numPoints; i++) {
          const t = timeRange.start! + (i * interval);
          const change = (Math.random() - 0.5) * (max - min) * 0.1;
          lastVal = Math.max(min, Math.min(max, lastVal + change));
          
          const date = new Date(t);
          const hour = date.getHours();
          let finalVal = lastVal;
          if (hour >= 9 && hour <= 17) finalVal += (max - min) * 0.05;
          
          arr[i] = {
            timestamp: "",
            fullTimestamp: date,
            value: finalVal
          };
        }
        return arr;
      };
      
      // Weather regen logic simplified for display
       const regenerateWeatherForRange = (): WeatherDataPoint[] => {
         // Reuse similar logic or simplified for zoom
         const arr = new Array(numPoints);
         for(let i=0; i<numPoints; i++) {
            const t = timeRange.start! + (i * interval);
            const date = new Date(t);
            arr[i] = {
                timestamp: "", fullTimestamp: date, value: 20, condition: 'sunny', temperature: 20
            }
         }
         return arr;
       };
    }

    const filter = (arr: ChartDataPoint[]) => 
      arr.filter(d => {
        const t = d.fullTimestamp.getTime();
        return t >= timeRange.start! && t <= timeRange.end!;
      });

    return {
      temperature: filter(sensorData.temperature),
      occupancy: filter(sensorData.occupancy),
      airQuality: filter(sensorData.airQuality),
      weather: filter(sensorData.weather) as WeatherDataPoint[],
      energyByFloor: filter(sensorData.energyByFloor) as EnergyFloorData[],
      deviations: sensorData.deviations
    };
  }, [sensorData, timeRange]);

  const fullTimeRange = useMemo(() => {
    if (!sensorData || sensorData.temperature.length === 0) {
      return { start: Date.now() - 86400000, end: Date.now() };
    }
    return {
      start: sensorData.temperature[0].fullTimestamp.getTime(),
      end: sensorData.temperature[sensorData.temperature.length - 1].fullTimestamp.getTime()
    };
  }, [sensorData]);

  const handleTimelineChange = useCallback((start: number, end: number) => {
    setTimeRange({ start, end });
  }, []);

  const resetTimeline = useCallback(() => {
    setTimeRange({ start: null, end: null });
    setTimelineViewRange(null);
  }, []);

  // local state for visual toggle only
const [level4Active, setLevel4Active] = useState(true);
const [level3Active, setLevel3Active] = useState(true);

  const ChartCard = React.memo(({ 
    title, 
    subtitle, 
    data, 
    color, 
    unit, 
    type = 'area',
    stackConfig,
    isWide = false 
  }: { 
    title: string; 
    subtitle: string; 
    data: any; 
    color: string; 
    unit: string; 
    type?: 'area' | 'bar' | 'stacked' | 'weather';
    stackConfig?: Array<{dataKey: string; name: string; color: string}>;
    isWide?: boolean;
  }) => {
    const avg = useMemo(() => {
      if (!data || data.length === 0) return '0';
      if (type === 'weather') {
        return (data.reduce((a: number, b: WeatherDataPoint) => a + b.temperature, 0) / data.length).toFixed(1);
      }
      return (data.reduce((a: number, b: any) => a + (b.value || 0), 0) / data.length).toFixed(0);
    }, [data, type]);

    const max = useMemo(() => {
      if (!data || data.length === 0) return '0';
      if (type === 'weather') {
        return Math.max(...data.map((d: WeatherDataPoint) => d.temperature)).toFixed(1);
      }
      return Math.max(...data.map((d: any) => d.value || 0)).toFixed(0);
    }, [data, type]);

    if (!data || data.length === 0) return null;

    const formatXAxis = (timestamp: Date) => {
      if (!timestamp) return '';
      const date = new Date(timestamp);
      const duration = timeRange.end && timeRange.start ? timeRange.end - timeRange.start : Infinity;
      
      if (duration <= 86400000) {
        return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      } else if (duration <= 604800000) {
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      } else if (duration <= 2592000000) {
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      } else {
        return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      }
    };

    const formatTooltipTime = (timestamp: Date) => {
      if (!timestamp) return '';
      const date = new Date(timestamp);
      return date.toLocaleString('en-US', { 
        month: 'short', 
        day: 'numeric', 
        hour: '2-digit', 
        minute: '2-digit' 
      });
    };

    const CustomTooltip = ({ active, payload }: any) => {
      if (!active || !payload || !payload.length) return null;
      const pointData = payload[0].payload;

      return (
        <div className="chart-tooltip-glass">
          <div className="tooltip-header">
            {formatTooltipTime(pointData.fullTimestamp)}
          </div>
          <div className="tooltip-body">
            {payload.map((entry: any, index: number) => (
              <div className="tooltip-row" key={index}>
                <div className="row-left">
                  <div 
                    className="indicator" 
                    style={{ backgroundColor: entry.color }}
                  />
                  <span>{entry.name || entry.dataKey}</span>
                </div>
                <div className="row-value">
                  {typeof entry.value === 'number' ? entry.value.toFixed(1) : entry.value}
                  <span className="unit">{unit}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    };

    const WeatherTooltip = ({ active, payload }: any) => {
      if (!active || !payload || !payload.length) return null;
      const weatherData = payload[0].payload as WeatherDataPoint;
      const conditionColor = WEATHER_COLORS[weatherData.condition];
      
      return (
        <div className="chart-tooltip-glass">
          <div className="tooltip-header">
            {formatTooltipTime(weatherData.fullTimestamp)}
          </div>
          <div className="tooltip-body">
            <div className="tooltip-row">
              <div className="row-left">
                <div 
                  className="indicator" 
                  style={{ backgroundColor: conditionColor }}
                />
                <span style={{ textTransform: 'capitalize' }}>
                  {weatherData.condition.replace('-', ' ')}
                </span>
              </div>
              <div className="row-value">
                {weatherData.temperature.toFixed(1)}
                <span className="unit">°C</span>
              </div>
            </div>
          </div>
        </div>
      );
    };

    const renderWeatherChart = () => {
      const CustomLine = (props: any) => {
        const { points } = props;
        if (!points || points.length < 2) return null;

        return (
          <g>
            {points.map((point: any, index: number) => {
              if (index === points.length - 1) return null;
              
              const nextPoint = points[index + 1];
              const currentData = data[index] as WeatherDataPoint;
              const color = WEATHER_COLORS[currentData.condition as keyof typeof WEATHER_COLORS];

              return (
                <line
                  key={`line-${index}`}
                  x1={point.x}
                  y1={point.y}
                  x2={nextPoint.x}
                  y2={nextPoint.y}
                  stroke={color}
                  strokeWidth={2}
                  fill="none"
                />
              );
            })}
          </g>
        );
      };

      return (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis 
              dataKey="fullTimestamp" 
              tickFormatter={formatXAxis}
              stroke="rgba(255,255,255,0.3)"
              style={{ fontSize: '10px' }}
            />
            <YAxis
              stroke="rgba(255,255,255,0.3)"
              style={{ fontSize: '10px' }}
              domain={['dataMin - 2', 'dataMax + 2']}
              tickFormatter={(val: any) => {
                const n = typeof val === 'number' ? val : Number(val);
                if (Number.isNaN(n)) return '';
                return `${n.toFixed(1)}°C`;
              }}
              label={{ value: '°C', angle: -90, position: 'insideLeft', offset: -8, style: { fill: 'rgba(255,255,255,0.6)', fontSize: 11 } }}
            />
            <Tooltip content={<WeatherTooltip />} />
            <Line
              type="monotone"
              dataKey="temperature"
              stroke="transparent"
              strokeWidth={2}
              dot={false}
              shape={<CustomLine />}
            />
          </LineChart>
        </ResponsiveContainer>
      );
    };

    return (
      <div className={`chart-card ${isWide ? 'wide' : ''}`}>
        <div className="card-header">
          <div className="title-group">
            <h3>{title}</h3>
            <div className="subtitle">{subtitle}</div>
          </div>
          <div className="stats-group">
            <div className="stat">
              <span className="label">AVG</span>
              <span className="val">{avg} {unit}</span>
            </div>
            <div className="stat">
              <span className="label">MAX</span>
              <span className="val">{max} {unit}</span>
            </div>
          </div>
        </div>
        <div className="chart-area">
          {type === 'weather' ? renderWeatherChart() : 
           type === 'area' ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data}>
                <defs>
                  <linearGradient id={`gradient-${title}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={color} stopOpacity={0.3}/>
                    <stop offset="95%" stopColor={color} stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis 
                  dataKey="fullTimestamp" 
                  tickFormatter={formatXAxis}
                  stroke="rgba(255,255,255,0.3)"
                  style={{ fontSize: '10px' }}
                />
                <YAxis stroke="rgba(255,255,255,0.3)" style={{ fontSize: '10px' }} />
                <Tooltip content={<CustomTooltip />} />
                <Area 
                  type="monotone" 
                  dataKey="value" 
                  stroke={color} 
                  strokeWidth={2}
                  fillOpacity={1} 
                  fill={`url(#gradient-${title})`}
                  name={title}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : type === 'bar' ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis 
                  dataKey="fullTimestamp" 
                  tickFormatter={formatXAxis}
                  stroke="rgba(255,255,255,0.3)"
                  style={{ fontSize: '10px' }}
                />
                <YAxis stroke="rgba(255,255,255,0.3)" style={{ fontSize: '10px' }} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} name={title} />
              </BarChart>
            </ResponsiveContainer>
          ) : type === 'stacked' && stackConfig ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data}>
                <defs>
                  {stackConfig.map(config => (
                    <linearGradient key={config.dataKey} id={`gradient-${config.dataKey}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={config.color} stopOpacity={0.3}/>
                      <stop offset="95%" stopColor={config.color} stopOpacity={0}/>
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis 
                  dataKey="fullTimestamp" 
                  tickFormatter={formatXAxis}
                  stroke="rgba(255,255,255,0.3)"
                  style={{ fontSize: '10px' }}
                />
                <YAxis stroke="rgba(255,255,255,0.3)" style={{ fontSize: '10px' }} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
                {stackConfig.map(config => (
                  <Area
                    key={config.dataKey}
                    type="monotone"
                    dataKey={config.dataKey}
                    stackId="1"
                    stroke={config.color}
                    strokeWidth={2}
                    fill={`url(#gradient-${config.dataKey})`}
                    name={config.name}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          ) : null}
        </div>
      </div>
    );
  });

  if (!filteredData) return <div>Loading...</div>;

  return (
    <div className="dashboard-container">
      <Topbar 
        title="Historical Analytics"
        subtitle="Past sensor logs and weather data"
        rightContent={
          <>
            <div className="topbar-status">
              <span className="status-dot online" />
              <span>Data Streaming</span>
            </div>
            <button className="topbar-btn" onClick={() => console.log('Export data')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
              </svg>
              Export Data
            </button>
            <button className="topbar-btn primary" onClick={() => setRefreshKey(p => p + 1)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
              </svg>
              Refresh
            </button>
          </>
        }
      />

      <div className="dashboard-layout">
        <main className="main-stage">
          <div className="dashboard-scroll-area">
            <section className="analytics-grid">
               <ChartCard title="Temperature" subtitle="Avg" data={filteredData.temperature} color="#ef4444" unit="°C" />
               <ChartCard 
                 title="External Weather" 
                 subtitle="Temp" 
                 data={filteredData.weather} 
                 color="#f59e0b" 
                 unit="°C" 
                 type="weather"
               />
               <ChartCard title="Occupancy" subtitle="Ppl" data={filteredData.occupancy} color="#f97316" type="bar" unit="Ppl" />
               <ChartCard title="Air Quality" subtitle="AQI" data={filteredData.airQuality} color="#10b981" unit="AQI" />
               
               <ChartCard 
                 title="Floor Distribution" 
                 subtitle="Energy" 
                 data={filteredData.energyByFloor} 
                 color="#3b82f6" 
                 unit="kWh"
                 type="stacked"
                 stackConfig={[
                   { dataKey: 'floor3', name: 'Level 3', color: '#3b82f6' },
                   { dataKey: 'floor4', name: 'Level 4', color: '#8b5cf6' }
                 ]}
                 isWide={true}
               />
            </section>
          </div>

          <section className="master-timeline-section">
            <div className="section-header">
              <h3>Timeline</h3>
              <div className="header-controls">
                <span className="range-display">
                  {timeRange.start ? 'CUSTOM FILTER' : 'FULL RANGE'}
                </span>
                {timeRange.start && (
                  <button className="reset-zoom-btn" onClick={resetTimeline}>
                    Reset Zoom
                  </button>
                )}
              </div>
            </div>
            <div 
              className="timeline-wrapper"
              onWheel={(e) => {
                e.preventDefault();
                e.stopPropagation();
                
                const ZOOM_SENSITIVITY = 0.05;
                const fullDatabaseStart = fullTimeRange.start;
                const fullDatabaseEnd = fullTimeRange.end;
                const fullDatabaseDuration = fullDatabaseEnd - fullDatabaseStart;
                
                const currentViewStart = timelineViewRange?.start || fullDatabaseStart;
                const currentViewEnd = timelineViewRange?.end || fullDatabaseEnd;
                const currentViewDuration = currentViewEnd - currentViewStart;
                
                const zoomFactor = 1 + (e.deltaY * ZOOM_SENSITIVITY);
                let newViewDuration = currentViewDuration * zoomFactor;
                
                const minViewDuration = timeRange.start && timeRange.end 
                  ? (timeRange.end - timeRange.start) * 1.2
                  : fullDatabaseDuration * 0.1;
                
                newViewDuration = Math.max(minViewDuration, Math.min(fullDatabaseDuration, newViewDuration));
                
                if (newViewDuration >= fullDatabaseDuration * 0.99) {
                  setTimelineViewRange(null);
                  return;
                }
                
                let center;
                if (timeRange.start && timeRange.end) {
                  center = (timeRange.start + timeRange.end) / 2;
                } else {
                  center = (currentViewStart + currentViewEnd) / 2;
                }
                
                let newViewStart = center - (newViewDuration / 2);
                let newViewEnd = center + (newViewDuration / 2);
                
                if (newViewStart < fullDatabaseStart) {
                  newViewStart = fullDatabaseStart;
                  newViewEnd = newViewStart + newViewDuration;
                }
                if (newViewEnd > fullDatabaseEnd) {
                  newViewEnd = fullDatabaseEnd;
                  newViewStart = newViewEnd - newViewDuration;
                }
                
                setTimelineViewRange({ start: newViewStart, end: newViewEnd });
              }}
            >
               <TimelineControl 
                 fullTimeRange={fullTimeRange}
                 selectedRange={timeRange}
                 onChange={handleTimelineChange}
                 data={timelineViewRange 
                   ? sensorData?.weather.filter(d => {
                       const t = d.fullTimestamp.getTime();
                       return t >= timelineViewRange.start && t <= timelineViewRange.end;
                     })
                   : sensorData?.weather
                 }
                 dataKey="temperature"
               />
            </div>
          </section>
        </main>

        <RightSidebar width="360px">
          <SidebarSection title="Floor Filter" defaultExpanded={true}>
    <div className="folder-toggle-grid">
      
      {/* Level 4 Button */}
      <button 
        className={`folder-toggle-btn ${level4Active ? 'active' : ''}`}
        onClick={() => setLevel4Active(!level4Active)}
      >
        <div className="folder-icon">
          {level4Active ? (
            <EyeIcon />
          ) : (
            <EyeOffIcon />
          )}
        </div>
        <div className="folder-info">
          <span className="folder-name">Level 4</span>
        </div>
      </button>

      {/* Level 3 Button */}
      <button 
        className={`folder-toggle-btn ${level3Active ? 'active' : ''}`}
        onClick={() => setLevel3Active(!level3Active)}
      >
        <div className="folder-icon">
          {level3Active ? (
            <EyeIcon />
          ) : (
            <EyeOffIcon />
          )}
        </div>
        <div className="folder-info">
          <span className="folder-name">Level 3</span>
        </div>
      </button>

    </div>
        </SidebarSection>
          <SidebarSection title="Time Range Filter">
            <div className="control-group">
              <div className="pill-grid">
                {['24hr', '7days', '30days', '3M', '1Y', 'ALL'].map(r => (
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
          </SidebarSection>
        <SidebarSection title="Anomaly Detection Log" noBorder>
            <div className="anomaly-feed">
              {sensorData?.deviations.map((dev) => (
                <div key={dev.metric} className={`anomaly-card ${dev.status}`}>
                  <div className="icon-wrapper">
                    {getMetricIcon(dev.metric)}
                  </div>
                  <div className="content">
                    <span className="metric-name">{dev.metric}</span>
                    <span className="impact-label">{dev.impact} Impact</span>
                  </div>
                  <div className="value-box">
                    <span className="deviation-val">
                      {dev.deviation > 0 ? '+' : ''}{dev.deviation.toFixed(1)}%
                    </span>
                    <span className="status-text">{dev.status}</span>
                  </div>
                </div>
              ))}
            </div>
          </SidebarSection>
        </RightSidebar>
      </div>
    </div>
  );
};

export default DashboardTab;
