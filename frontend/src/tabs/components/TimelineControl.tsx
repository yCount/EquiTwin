import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import Slider from 'rc-slider';
import 'rc-slider/assets/index.css';
import './TimelineControl.scss';

interface TimelineControlProps {
  fullTimeRange: { start: number; end: number };
  selectedRange: { start: number | null; end: number | null };
  data?: any[]; // The full dataset to visualize
  dataKey?: string; // Which key to plot (e.g., 'value')
  onChange: (start: number, end: number) => void;
}

const TimelineControl: React.FC<TimelineControlProps> = ({ 
  fullTimeRange, 
  selectedRange, 
  data = [],
  dataKey = 'value',
  onChange 
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverPosition, setHoverPosition] = useState<{ x: number; data: any } | null>(null);

  // --- Helpers ---
  const rangeToPercent = (val: number) => {
    if (!fullTimeRange.start || !fullTimeRange.end) return 0;
    const total = fullTimeRange.end - fullTimeRange.start;
    if (total === 0) return 0;
    return Math.max(0, Math.min(100, ((val - fullTimeRange.start) / total) * 100));
  };

  const percentToRange = (pct: number) => {
    const total = fullTimeRange.end - fullTimeRange.start;
    return fullTimeRange.start + (pct / 100) * total;
  };

  const formatCompactDate = (ms: number) =>
    new Date(ms).toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  // --- Memoized Values ---
  const currentValue = useMemo(() => {
    // If no range selected, show full range (0-100)
    if (!selectedRange.start || !selectedRange.end) return [0, 100];
    return [
      rangeToPercent(selectedRange.start),
      rangeToPercent(selectedRange.end)
    ];
  }, [selectedRange, fullTimeRange]);

  const keySpots = useMemo(() => {
    const n = 6; // start + 4 interior + end
    const total = fullTimeRange.end - fullTimeRange.start;
    if (total <= 0) return [] as Array<{ pct: number; label: string }>;
    return Array.from({ length: n }).map((_, i) => {
      const pct = (i / (n - 1)) * 100;
      const ts = fullTimeRange.start + (total * pct / 100);
      return { pct, label: formatCompactDate(ts) };
    });
  }, [fullTimeRange.start, fullTimeRange.end]);

  const selectedStartMs = selectedRange.start ?? fullTimeRange.start;
  const selectedEndMs = selectedRange.end ?? fullTimeRange.end;

  // --- Sparkline Path Generation ---
  const sparklinePath = useMemo(() => {
    if (!data || data.length === 0) return "";
    
    // 1. Find Min/Max for Y-Axis scaling
    let min = Infinity;
    let max = -Infinity;
    data.forEach(d => {
        const val = d[dataKey];
        if (val < min) min = val;
        if (val > max) max = val;
    });
    const range = max - min;
    const isFlat = range === 0;
    const safeRange = isFlat ? 1 : range;

    // 2. Build SVG Path (now with 0-100 for X, will be scaled by transform)
    return data.map((d, i) => {
        const x = data.length === 1 ? 50 : (i / (data.length - 1)) * 100;
        const normalizedVal = (d[dataKey] - min) / safeRange;
        const y = isFlat ? 50 : (1 - normalizedVal) * 100; 
        return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
    }).join(' ') + ' L 100 100 L 0 100 Z';
  }, [data, dataKey]);

  // --- Zoom / Wheel Handler ---
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!selectedRange.start || !selectedRange.end) return;

    const ZOOM_SENSITIVITY = 0.001;
    const totalDuration = fullTimeRange.end - fullTimeRange.start;
    const currentDuration = selectedRange.end - selectedRange.start;
    
    // Delta Y positive = Scroll Down = Zoom Out (Expand range)
    // Delta Y negative = Scroll Up = Zoom In (Shrink range)
    const zoomFactor = 1 + (e.deltaY * ZOOM_SENSITIVITY);
    
    let newDuration = currentDuration * zoomFactor;
    // Clamp duration: Can't be larger than total, can't be smaller than 1 min
    newDuration = Math.max(60000, Math.min(totalDuration, newDuration));

    // Calculate center of current selection to zoom around center
    const center = selectedRange.start + (currentDuration / 2);
    
    let newStart = center - (newDuration / 2);
    let newEnd = center + (newDuration / 2);

    // Boundary Checks (Don't pan past edges)
    if (newStart < fullTimeRange.start) {
        newStart = fullTimeRange.start;
        newEnd = newStart + newDuration;
    }
    if (newEnd > fullTimeRange.end) {
        newEnd = fullTimeRange.end;
        newStart = newEnd - newDuration;
    }

    onChange(newStart, newEnd);
  }, [selectedRange, fullTimeRange, onChange]);

  // Attach/Detach non-passive wheel listener
  useEffect(() => {
    const el = containerRef.current;
    if (el) {
        el.addEventListener('wheel', handleWheel, { passive: false });
    }
    return () => {
        if (el) el.removeEventListener('wheel', handleWheel);
    };
  }, [handleWheel]);

  // --- Mouse hover handlers ---
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!data || data.length === 0) return;
    
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect) return;
    
    const x = e.clientX - rect.left;
    const percent = (x / rect.width) * 100;
    
    // Find closest data point
    const dataIndex = Math.round((percent / 100) * (data.length - 1));
    const clampedIndex = Math.max(0, Math.min(data.length - 1, dataIndex));
    
    setHoverPosition({
      x: percent,
      data: data[clampedIndex]
    });
  };

  const handleMouseLeave = () => {
    setHoverPosition(null);
  };

  const getHoverMetric = (row: any): { label: string; valueText: string } => {
    const asNum = (v: any) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const candidates: Array<{ key: string; label: string; unit: string; digits: number }> = [
      { key: "temperature", label: "Temperature", unit: "°C", digits: 1 },
      { key: "value",       label: "Value",       unit: "",   digits: 1 },
      { key: "airQuality",  label: "Air Quality", unit: "ppm", digits: 0 },
      { key: "occupancy",   label: "Occupancy",   unit: "ppl", digits: 0 },
      { key: "energy",      label: "Energy",      unit: "kW",  digits: 2 },
      { key: "net_occupancy", label: "Occupancy", unit: "ppl", digits: 0 },
    ];

    // Prefer current dataKey unless it's the synthetic flat-line key.
    if (dataKey && dataKey !== "flat") {
      const n = asNum(row?.[dataKey]);
      if (n !== null) {
        const unit = dataKey === "temperature" ? "°C" : "";
        return { label: dataKey, valueText: `${n.toFixed(1)}${unit ? ` ${unit}` : ""}` };
      }
    }

    for (const c of candidates) {
      const n = asNum(row?.[c.key]);
      if (n !== null) {
        return {
          label: c.label,
          valueText: `${n.toFixed(c.digits)}${c.unit ? ` ${c.unit}` : ""}`,
        };
      }
    }
    return { label: "Value", valueText: "N/A" };
  };

  // --- Render ---
  const handleRender = (node: any, handleProps: any) => {
    const pct = Number(handleProps?.value ?? 0);
    const ts = percentToRange(pct);
    return (
      <div {...node.props} className={`custom-timeline-handle handle-${handleProps.index}`}>
        <div className="handle-line" />
        <div className="handle-dot" />
        <div className="handle-tooltip">{formatCompactDate(ts)}</div>
      </div>
    );
  };

  return (
    <div 
      className="timeline-control-container" 
      ref={containerRef}
    >
      
      {/* 1. Sparkline Background Layer */}
      <div 
        className="timeline-sparkline-layer"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
         <svg viewBox="0 0 1000 100" preserveAspectRatio="none">
            {/* Fill gradient area */}
            <path 
                d={sparklinePath} 
                className="sparkline-fill" 
                transform="scale(10, 1)"
            />
            {/* Stroke line */}
            <path 
                d={sparklinePath} 
                className="sparkline-stroke" 
                fill="none" 
                transform="scale(10, 1)"
            />
            {/* Selection overlay - highlights the selected region */}
            {selectedRange.start && selectedRange.end && (
              <>
                {/* Dimmed areas outside selection */}
                <rect 
                  x="0" 
                  y="0" 
                  width={currentValue[0] * 10} 
                  height="100" 
                  className="selection-dim"
                />
                <rect 
                  x={currentValue[1] * 10} 
                  y="0" 
                  width={(100 - currentValue[1]) * 10} 
                  height="100" 
                  className="selection-dim"
                />
                {/* Solid vertical lines for selection boundaries */}
                <line 
                  x1={currentValue[0] * 10} 
                  y1="0" 
                  x2={currentValue[0] * 10} 
                  y2="100" 
                  className="selection-line selection-line-start"
                />
                <line 
                  x1={currentValue[1] * 10} 
                  y1="0" 
                  x2={currentValue[1] * 10} 
                  y2="100" 
                  className="selection-line selection-line-end"
                />
              </>
            )}
            {/* Hover indicator line */}
            {hoverPosition && (
              <line 
                x1={hoverPosition.x * 10} 
                y1="0" 
                x2={hoverPosition.x * 10} 
                y2="100" 
                className="hover-line"
              />
            )}
         </svg>
      </div>

      <div className="timeline-keyspots" aria-hidden="true">
        {keySpots.map((k, i) => (
          <div key={i} className="keyspot" style={{ left: `${k.pct}%` }}>
            <div className="keyspot-line" />
            <div className="keyspot-label">{k.label}</div>
          </div>
        ))}
      </div>

      {/* Hover Tooltip */}
      {hoverPosition && (
        <div 
          className="timeline-tooltip" 
          style={{ left: `${hoverPosition.x}%` }}
        >
          <div className="tooltip-time">
            Date
          </div>
          <div className="tooltip-value">
            {formatCompactDate(new Date(hoverPosition.data.fullTimestamp).getTime())}
          </div>
          <div className="tooltip-time">
            {getHoverMetric(hoverPosition.data).label}
          </div>
          <div className="tooltip-value">
            {getHoverMetric(hoverPosition.data).valueText}
          </div>
        </div>
      )}

      <div className="timeline-edge-label edge-start">
        {formatCompactDate(selectedStartMs)}
      </div>
      <div className="timeline-edge-label edge-end">
        {formatCompactDate(selectedEndMs)}
      </div>

      {/* 2. Slider Interactive Layer */}
      <div className="slider-wrapper">
        <Slider
          range
          min={0}
          max={100}
          step={0.1} 
          allowCross={false}
          value={currentValue as [number, number]}
          onChange={(val) => {
            if (Array.isArray(val)) {
              onChange(percentToRange(val[0]), percentToRange(val[1]));
            }
          }}
          handleRender={handleRender}
        />
      </div>
    </div>
  );
};

export default TimelineControl;
