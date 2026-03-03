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
import "./components/RightSidebar.scss";
import "./components/MainContent.scss";
import Topbar from "./components/Topbar";
import TimelineControl from "./components/TimelineControl";
import RightSidebar, { SidebarSection } from "./components/RightSidebar";
import MainContent, { ContentArea, Section } from "./components/MainContent";
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

interface DbResponse {
  rows: Record<string, any>[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  columns: string[];
}

const DB_API = "http://localhost:8000";

// Columns shown by default on first load (intersected with what the table has).
const DB_DEFAULT_COLS = [
  "id", "timestamp", "event_label", "net_occupancy",
  "temp", "humidity", "co2", "total_act_power",
  "num_targets", "entries", "exits",
];

const formatDbCell = (col: string, val: any): React.ReactNode => {
  if (val === null || val === undefined) return <span className="cell-null">—</span>;
  if (col === "timestamp" && typeof val === "string")
    return val.replace("T", " ").slice(0, 19);
  if (col === "event_label") {
    const cls = val === "No Motion"     ? "ev-motion"
              : val === "Exit Detected" ? "ev-exit"
              : val === "Energy Meter"  ? "ev-energy"
              : val === "Air Quality"   ? "ev-aq"
              : "ev-other";
    return <span className={`event-badge ${cls}`}>{val}</span>;
  }
  if (col === "net_occupancy" && typeof val === "number")
    return <span className="occ-count">{val}</span>;
  if (typeof val === "number") {
    const s = val.toFixed(4);
    return s.replace(/\.?0+$/, "");
  }
  return String(val);
};

const dbCellClass = (col: string, val: any): string => {
  if (col === "net_occupancy" && typeof val === "number") {
    if (val === 0)   return "cell-occ-zero";
    if (val <= 5)    return "cell-occ-low";
    if (val <= 15)   return "cell-occ-mid";
    return "cell-occ-high";
  }
  return "";
};

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
    case 'Energy':      return <EnergyIcon />;
    default:            return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>;
  }
};

// --- Timeseries API types & conversion ----------------------------------------

interface TimeseriesPoint { ts: string; value: number; }
interface EnergyPoint extends TimeseriesPoint { circuit0: number; circuit1: number; }
interface WeatherApiPoint extends TimeseriesPoint { condition?: string; }
interface TimeseriesApiResponse {
  temperature: TimeseriesPoint[];
  airQuality:  TimeseriesPoint[];
  occupancy:   TimeseriesPoint[];
  energy:      EnergyPoint[];
  weather:     WeatherApiPoint[];
}

// Map Open-Meteo / WeatherClient condition strings → chart's 5 categories.
const mapWeatherCondition = (c?: string): WeatherDataPoint['condition'] => {
  switch (c) {
    case 'sunny':        return 'sunny';
    case 'mostly_sunny': return 'partly-cloudy';
    case 'rain':         return 'rainy';
    case 'snow':         return 'snowy';
    case 'thunderstorm': return 'rainy';
    case 'fog':          return 'cloudy';
    default:             return 'cloudy';
  }
};

const convertApiToSensorData = (api: TimeseriesApiResponse): SensorData => {
  const toChart = (pts: TimeseriesPoint[]): ChartDataPoint[] =>
    pts.map(p => ({ timestamp: "", fullTimestamp: new Date(p.ts), value: p.value }));

  const avgOf = (arr: TimeseriesPoint[]) =>
    arr.length > 0 ? arr.reduce((s, p) => s + p.value, 0) / arr.length : 0;

  const devStatus = (pct: number): DeviationDataPoint["status"] =>
    Math.abs(pct) > 15 ? "critical" : Math.abs(pct) > 7 ? "warning" : "good";

  const tempAvg   = avgOf(api.temperature);
  const co2Avg    = avgOf(api.airQuality);
  const occMax    = api.occupancy.length > 0 ? Math.max(...api.occupancy.map(p => p.value)) : 0;
  const energyAvg = avgOf(api.energy);

  const pct = (actual: number, ideal: number) =>
    ideal !== 0 ? +((actual - ideal) / ideal * 100).toFixed(1) : 0;

  return {
    temperature: toChart(api.temperature),
    occupancy:   toChart(api.occupancy),
    airQuality:  toChart(api.airQuality),
    weather: api.weather.map(p => ({
      timestamp: "", fullTimestamp: new Date(p.ts),
      value: p.value,
      condition: mapWeatherCondition(p.condition),
      temperature: p.value,
    })),
    energyByFloor: api.energy.map(p => ({
      timestamp: "", fullTimestamp: new Date(p.ts),
      value: p.value, floor3: p.circuit0, floor4: p.circuit1,
    })),
    deviations: [
      { metric: "Temperature", actual: +tempAvg.toFixed(1),   ideal: 22,  deviation: pct(tempAvg, 22),   status: devStatus(pct(tempAvg, 22)),   impact: "Comfort"  },
      { metric: "Occupancy",   actual: occMax,                 ideal: 20,  deviation: pct(occMax, 20),    status: devStatus(pct(occMax, 20)),    impact: "Capacity" },
      { metric: "Air Quality", actual: +co2Avg.toFixed(0),    ideal: 600, deviation: pct(co2Avg, 600),   status: co2Avg <= 600 ? "good" : devStatus(pct(co2Avg, 600)), impact: "Health" },
      { metric: "Energy",      actual: +energyAvg.toFixed(2), ideal: 5.0, deviation: pct(energyAvg, 5.0), status: devStatus(pct(energyAvg, 5.0)), impact: "Cost"     },
    ],
  };
};

const DashboardTab = () => {
  const [activeTimeRange, setActiveTimeRange] = useState<string>("24hr");
  const [selectedFloors, setSelectedFloors] = useState<string[]>(["Level 3", "Level 4"]);
  const [timeRange, setTimeRange] = useState<TimeRange>({ start: null, end: null });
  const [refreshKey, setRefreshKey] = useState<number>(0);
  const EMPTY_SENSOR_DATA: SensorData = {
    temperature: [], occupancy: [], airQuality: [],
    weather: [], energyByFloor: [], deviations: [],
  };
  const [sensorData, setSensorData] = useState<SensorData>(EMPTY_SENSOR_DATA);
  const [chartsLoading, setChartsLoading] = useState(true);
  const [chartsError, setChartsError]     = useState<string | null>(null);
  const [timelineViewRange, setTimelineViewRange] = useState<{ start: number; end: number } | null>(null);

  // Fetch real sensor data from the backend on mount and on manual refresh.
  useEffect(() => {
    setChartsLoading(true);
    setChartsError(null);
    fetch(`${DB_API}/api/db/timeseries`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`); return r.json(); })
      .then((api: TimeseriesApiResponse) => {
        setSensorData(convertApiToSensorData(api));
        setChartsLoading(false);
      })
      .catch(err => {
        console.error("Timeseries fetch failed:", err);
        setChartsError(err.message);
        setChartsLoading(false);
      });
  }, [refreshKey]);

  // Build a flat list of all timestamps across every data series so time-range
  // calculations are not accidentally pinned to whichever series has the
  // narrowest coverage (e.g. temperature data only existing for Jun-Jul while
  // energy spans the full DB history).
  const allSeriesPoints = useMemo((): ChartDataPoint[] => [
    ...sensorData.temperature,
    ...sensorData.occupancy,
    ...sensorData.airQuality,
    ...sensorData.energyByFloor,
    ...sensorData.weather,
  ], [sensorData]);

  // Slide the selected time window whenever the active range button changes
  // or when fresh data arrives.  Uses the latest timestamp across ALL series.
  useEffect(() => {
    if (allSeriesPoints.length === 0) {
      setTimeRange({ start: null, end: null });
      setTimelineViewRange(null);
      return;
    }
    const endTime = allSeriesPoints.reduce(
      (max, p) => Math.max(max, p.fullTimestamp.getTime()), -Infinity
    );
    const config = getRangeConfig(activeTimeRange);
    setTimeRange({ start: endTime - config.selectedHours * 3600000, end: endTime });
    setTimelineViewRange(null);
  }, [allSeriesPoints, activeTimeRange]);

  const filteredData = useMemo(() => {
    if (!timeRange.start || !timeRange.end) return sensorData;

    const filter = (arr: ChartDataPoint[]) =>
      arr.filter(d => {
        const t = d.fullTimestamp.getTime();
        return t >= timeRange.start! && t <= timeRange.end!;
      });

    return {
      temperature:   filter(sensorData.temperature),
      occupancy:     filter(sensorData.occupancy),
      airQuality:    filter(sensorData.airQuality),
      weather:       filter(sensorData.weather) as WeatherDataPoint[],
      energyByFloor: filter(sensorData.energyByFloor) as EnergyFloorData[],
      deviations:    sensorData.deviations,
    };
  }, [sensorData, timeRange]);

  const fullTimeRange = useMemo(() => {
    if (allSeriesPoints.length === 0) {
      return { start: Date.now() - 86400000, end: Date.now() };
    }
    const times = allSeriesPoints.map(p => p.fullTimestamp.getTime());
    return {
      start: Math.min(...times),
      end:   Math.max(...times),
    };
  }, [allSeriesPoints]);

  // Shared X-axis domain for all chart cards: use the selected time window
  // (or the full DB range when no window is active). Passing this to every
  // ChartCard forces identical X-axis spans even when individual series have
  // data gaps or shorter coverage than the full dataset.
  const chartXDomain = useMemo((): [number, number] => [
    timeRange.start  ?? fullTimeRange.start,
    timeRange.end    ?? fullTimeRange.end,
  ], [timeRange, fullTimeRange]);

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

  // ---- Database viewer state ------------------------------------------------
  const [dbPage, setDbPage]               = useState(1);
  const [dbPageSize, setDbPageSize]       = useState(50);
  const [dbData, setDbData]               = useState<DbResponse | null>(null);
  const [dbLoading, setDbLoading]         = useState(false);
  const [dbError, setDbError]             = useState<string | null>(null);
  const [dbVisibleCols, setDbVisibleCols] = useState<string[]>([]);
  const [dbColPickerOpen, setDbColPickerOpen] = useState(false);

  useEffect(() => {
    setDbLoading(true);
    setDbError(null);
    fetch(`${DB_API}/api/db/rows?page=${dbPage}&page_size=${dbPageSize}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`);
        return r.json() as Promise<DbResponse>;
      })
      .then(data => {
        setDbData(data);
        setDbVisibleCols(prev =>
          prev.length === 0
            ? data.columns.filter(c => DB_DEFAULT_COLS.includes(c))
            : prev
        );
        setDbLoading(false);
      })
      .catch(err => {
        setDbError(err.message);
        setDbLoading(false);
      });
  }, [dbPage, dbPageSize]);

  const ChartCard = React.memo(({
    title,
    subtitle,
    data,
    color,
    unit,
    type = 'area',
    stackConfig,
    isWide = false,
    domain,
    xDomain,
    emptyMessage,
  }: {
    title: string;
    subtitle: string;
    data: any;
    color: string;
    unit: string;
    type?: 'area' | 'bar' | 'stacked' | 'weather';
    stackConfig?: Array<{dataKey: string; name: string; color: string}>;
    isWide?: boolean;
    domain?: [number | string, number | string];
    xDomain?: [number, number];
    emptyMessage?: string;
  }) => {
    // Precision helper: kW → 2dp, °C → 1dp, everything else → 0dp
    const fmt = (v: number) =>
      unit === 'kW' ? v.toFixed(2) : unit === '°C' ? v.toFixed(1) : v.toFixed(0);

    const avg = useMemo(() => {
      if (!data || data.length === 0) return '—';
      if (type === 'weather') {
        return (data.reduce((a: number, b: WeatherDataPoint) => a + b.temperature, 0) / data.length).toFixed(1);
      }
      return fmt(data.reduce((a: number, b: any) => a + (b.value || 0), 0) / data.length);
    }, [data, type, unit]);

    const max = useMemo(() => {
      if (!data || data.length === 0) return '—';
      if (type === 'weather') {
        return Math.max(...data.map((d: WeatherDataPoint) => d.temperature)).toFixed(1);
      }
      return fmt(Math.max(...data.map((d: any) => d.value || 0)));
    }, [data, type, unit]);

    // Add numeric timestamp (_tsMs) so XAxis can use type="number" scale="time"
    // and accept an explicit domain that spans the full selected window — even
    // when this particular series has data only in a sub-range.
    const chartData = useMemo(
      () => data?.map((d: any) => ({ ...d, _tsMs: (d.fullTimestamp as Date).getTime() })) ?? [],
      [data]
    );

    if (!data || data.length === 0) {
      return (
        <div className={`chart-card ${isWide ? 'wide' : ''}`}>
          <div className="card-header">
            <div className="title-group">
              <h3>{title}</h3>
              <div className="subtitle">{subtitle}</div>
            </div>
          </div>
          <div className="chart-area chart-area-empty">
            <span className="chart-empty-msg">{emptyMessage ?? 'No data available'}</span>
          </div>
        </div>
      );
    }

    // XAxis props shared by all chart variants.
    // When xDomain is provided the axis is pinned to [start, end] in epoch-ms
    // so all charts share the same time span regardless of data gaps.
    const xAxisProps = {
      dataKey: '_tsMs',
      type: 'number' as const,
      scale: 'time' as const,
      domain: xDomain ?? (['dataMin', 'dataMax'] as [string, string]),
      tickFormatter: (ms: number) => {
        if (!ms) return '';
        const date = new Date(ms);
        const duration = xDomain ? xDomain[1] - xDomain[0]
          : (timeRange.end && timeRange.start ? timeRange.end - timeRange.start : Infinity);
        if (duration <= 86400000)
          return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        if (duration <= 2592000000)
          return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      },
      stroke: 'rgba(255,255,255,0.3)' as const,
      style: { fontSize: '10px' },
      tickCount: 6,
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
                  {typeof entry.value === 'number'
                    ? (unit === 'kW' ? entry.value.toFixed(3) : unit === '°C' ? entry.value.toFixed(1) : entry.value.toFixed(0))
                    : entry.value}
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
              const currentData = chartData[index] as WeatherDataPoint;
              const color = WEATHER_COLORS[currentData.condition as keyof typeof WEATHER_COLORS] ?? '#94a3b8';
              return (
                <line
                  key={`line-${index}`}
                  x1={point.x} y1={point.y}
                  x2={nextPoint.x} y2={nextPoint.y}
                  stroke={color} strokeWidth={2} fill="none"
                />
              );
            })}
          </g>
        );
      };

      return (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis {...xAxisProps} />
            <YAxis
              stroke="rgba(255,255,255,0.3)"
              style={{ fontSize: '10px' }}
              domain={['dataMin - 2', 'dataMax + 2']}
              tickFormatter={(val: any) => {
                const n = typeof val === 'number' ? val : Number(val);
                return Number.isNaN(n) ? '' : `${n.toFixed(1)}°C`;
              }}
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
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id={`gradient-${title}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={color} stopOpacity={0.3}/>
                    <stop offset="95%" stopColor={color} stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis {...xAxisProps} />
                <YAxis stroke="rgba(255,255,255,0.3)" style={{ fontSize: '10px' }} domain={domain} />
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
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis {...xAxisProps} />
                <YAxis stroke="rgba(255,255,255,0.3)" style={{ fontSize: '10px' }} domain={domain} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} name={title} />
              </BarChart>
            </ResponsiveContainer>
          ) : type === 'stacked' && stackConfig ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  {stackConfig.map(config => (
                    <linearGradient key={config.dataKey} id={`gradient-${config.dataKey}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={config.color} stopOpacity={0.3}/>
                      <stop offset="95%" stopColor={config.color} stopOpacity={0}/>
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis {...xAxisProps} />
                <YAxis stroke="rgba(255,255,255,0.3)" style={{ fontSize: '10px' }} domain={domain} />
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

  return (
    <div className="dashboard-container">
      <Topbar
        variant="dashboard"
        title="Dashboard"
        subtitle="Past sensor logs and weather data"
        rightContent={
          <>
            <div className="topbar-status">
              {chartsLoading
                ? <><span className="status-dot" style={{background:"#f59e0b"}}/><span>Loading…</span></>
                : chartsError
                  ? <><span className="status-dot" style={{background:"#ef4444"}}/><span>Backend unreachable</span></>
                  : <><span className="status-dot online" /><span>Live Data</span></>
              }
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

      <MainContent
        sidebar={
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
        }
        sidebarWidth="360px"
      >
        <ContentArea padding="compact" gap="12px">
          {chartsError && (
            <div className="charts-error-banner">
              <span>⚠ Could not load sensor data: {chartsError}</span>
              <span className="charts-error-hint">
                Make sure the backend is running and DATABASE_URL is set:&nbsp;
                <code>$env:DATABASE_URL = "postgresql+psycopg2://postgres:6196@localhost:5432/eco_init"</code>
              </span>
            </div>
          )}
          <section className="analytics-grid">
            <ChartCard
              title="Temperature"
              subtitle="Indoor °C"
              data={filteredData.temperature}
              color="#ef4444"
              unit="°C"
              domain={['dataMin - 1', 'dataMax + 1']}
              xDomain={chartXDomain}
            />
            {filteredData.weather.length > 0 ? (
              <ChartCard
                title="External Weather"
                subtitle="Outdoor °C"
                data={filteredData.weather}
                color="#f59e0b"
                unit="°C"
                type="weather"
                xDomain={chartXDomain}
              />
            ) : (
              <ChartCard
                title="Energy Overview"
                subtitle="Avg Power"
                data={filteredData.energyByFloor}
                color="#f59e0b"
                unit="kW"
                type="area"
                domain={[0, 'auto']}
                xDomain={chartXDomain}
                emptyMessage="No energy data recorded"
              />
            )}
            <ChartCard
              title="Occupancy"
              subtitle="People"
              data={filteredData.occupancy}
              color="#f97316"
              type="bar"
              unit="Ppl"
              domain={[0, 'dataMax + 1']}
              xDomain={chartXDomain}
            />
            <ChartCard
              title="Air Quality"
              subtitle="CO₂"
              data={filteredData.airQuality}
              color="#10b981"
              unit="ppm"
              domain={['dataMin - 100', 'dataMax + 100']}
              xDomain={chartXDomain}
            />

            <ChartCard
              title="Floor Distribution"
              subtitle="Energy by Circuit"
              data={filteredData.energyByFloor}
              color="#3b82f6"
              unit="kW"
              type="stacked"
              stackConfig={[
                { dataKey: 'floor3', name: 'Circuit 0', color: '#3b82f6' },
                { dataKey: 'floor4', name: 'Circuit 1', color: '#8b5cf6' }
              ]}
              domain={[0, 'auto']}
              xDomain={chartXDomain}
              isWide={true}
            />
          </section>

          <Section 
            className="glass-panel"
            title="Timeline"
            headerActions={
              <>
                <span className="range-display">
                  {timeRange.start ? 'CUSTOM FILTER' : 'FULL RANGE'}
                </span>
                {timeRange.start && (
                  <button className="reset-btn" onClick={resetTimeline}>
                    Reset Zoom
                  </button>
                )}
              </>
            }
          >
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
          </Section>
          <Section
            className="glass-panel"
            title="Database Viewer"
            headerActions={
              <span className="db-total-badge">
                {dbData ? `${dbData.total.toLocaleString()} rows` : "—"}
              </span>
            }
          >
            <div className="db-viewer">
              {/* ---- Controls bar ---- */}
              <div className="db-controls">
                <div className="db-controls-left">
                  <select
                    className="db-page-size-select"
                    value={dbPageSize}
                    onChange={e => { setDbPageSize(Number(e.target.value)); setDbPage(1); }}
                  >
                    {[25, 50, 100].map(n => <option key={n} value={n}>{n} rows</option>)}
                  </select>

                  <div className="db-col-picker-wrap">
                    <button
                      className="db-col-picker-btn"
                      onClick={() => setDbColPickerOpen(p => !p)}
                    >
                      Columns&nbsp;
                      <span className="col-count">
                        {dbVisibleCols.length}/{dbData?.columns.length ?? 0}
                      </span>
                      &nbsp;▾
                    </button>
                    {dbColPickerOpen && dbData && (
                      <div className="db-col-picker-dropdown">
                        <div className="col-picker-actions">
                          <button onClick={() => setDbVisibleCols(dbData.columns)}>All</button>
                          <button onClick={() => setDbVisibleCols(dbData.columns.filter(c => DB_DEFAULT_COLS.includes(c)))}>Default</button>
                          <button onClick={() => setDbVisibleCols([])}>None</button>
                        </div>
                        {dbData.columns.map(col => (
                          <label key={col} className="db-col-option">
                            <input
                              type="checkbox"
                              checked={dbVisibleCols.includes(col)}
                              onChange={() =>
                                setDbVisibleCols(prev =>
                                  prev.includes(col)
                                    ? prev.filter(c => c !== col)
                                    : [...prev, col]
                                )
                              }
                            />
                            {col}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="db-pagination">
                  <span className="db-page-info">
                    {dbData
                      ? `${((dbPage - 1) * dbPageSize + 1).toLocaleString()}–${Math.min(dbPage * dbPageSize, dbData.total).toLocaleString()} of ${dbData.total.toLocaleString()}`
                      : "—"}
                  </span>
                  <button
                    className="db-page-btn"
                    disabled={dbPage <= 1 || dbLoading}
                    onClick={() => setDbPage(p => p - 1)}
                  >‹</button>
                  <span className="db-page-current">{dbPage}</span>
                  <button
                    className="db-page-btn"
                    disabled={!dbData || dbPage >= dbData.total_pages || dbLoading}
                    onClick={() => setDbPage(p => p + 1)}
                  >›</button>
                </div>
              </div>

              {/* ---- Error state ---- */}
              {dbError && (
                <div className="db-error">
                  <span>⚠ Could not reach database: {dbError}</span>
                  <span className="db-error-hint">
                    Start the backend and set DATABASE_URL env var, e.g.:<br />
                    <code>export DATABASE_URL="postgresql+psycopg2://user:pass@host/db"</code>
                  </span>
                </div>
              )}

              {/* ---- Table ---- */}
              {!dbError && (
                <div className="db-table-wrap">
                  {dbLoading && (
                    <div className="db-loading-overlay"><span>Loading…</span></div>
                  )}
                  <table className="db-table">
                    <thead>
                      <tr>
                        {dbVisibleCols.map(col => <th key={col}>{col}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {dbData?.rows.map((row, i) => {
                        const et: string = row.event_type ?? "";
                        const rowCls =
                          et.includes("NORMAL_EM")  ? "db-row-energy"
                        : et.includes("NORMAL_AQ")  ? "db-row-aq"
                        : et.includes("MOVEMENT") || et.includes("EXIT") || et.includes("HVAC")
                          ? "db-row-occ"
                        : "";
                        return (
                          <tr key={row.id ?? i} className={rowCls}>
                            {dbVisibleCols.map(col => (
                              <td key={col} className={dbCellClass(col, row[col])}>
                                {formatDbCell(col, row[col])}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                      {(!dbData || dbData.rows.length === 0) && !dbLoading && (
                        <tr>
                          <td colSpan={dbVisibleCols.length} className="db-empty">
                            No data
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Section>
        </ContentArea>
      </MainContent>
    </div>
  );
};

export default DashboardTab;
