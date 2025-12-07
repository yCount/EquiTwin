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

  // --- Memoized Values ---
  const currentValue = useMemo(() => {
    // If no range selected, show full range (0-100)
    if (!selectedRange.start || !selectedRange.end) return [0, 100];
    return [
      rangeToPercent(selectedRange.start),
      rangeToPercent(selectedRange.end)
    ];
  }, [selectedRange, fullTimeRange]);

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

    // 2. Build SVG Path (now with 0-100 for X, will be scaled by transform)
    return data.map((d, i) => {
        const x = (i / (data.length - 1)) * 100;
        const normalizedVal = (d[dataKey] - min) / range;
        const y = (1 - normalizedVal) * 100; 
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

  // --- Render ---
  const handleRender = (node: any, handleProps: any) => {
    return (
      <div {...node.props} className={`custom-timeline-handle handle-${handleProps.index}`}>
        <div className="handle-line" />
        <div className="handle-dot" /> 
        {/* Tooltip logic (Optional: stripped for brevity, add back if desired) */}
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

      {/* Hover Tooltip */}
      {hoverPosition && (
        <div 
          className="timeline-tooltip" 
          style={{ left: `${hoverPosition.x}%` }}
        >
          <div className="tooltip-time">
            {new Date(hoverPosition.data.fullTimestamp).toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            })}
          </div>
          <div className="tooltip-value">
            {Number(hoverPosition.data[dataKey]).toFixed(1)} kWh
          </div>
        </div>
      )}

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
