import React from 'react';
import ReactApexChart from 'react-apexcharts';
import { ApexOptions } from 'apexcharts';

import './TimelineScrubber.scss';

interface TimelineScrubberProps {
  data: any[]; // The full dataset
  onChange: (min: number, max: number) => void; // Callback when selection changes
  height?: number;
}

const TimelineScrubber: React.FC<TimelineScrubberProps> = ({ data, onChange, height = 130 }) => {
  // 1. Transform data for ApexCharts [timestamp, value]
  const series = [{
    name: 'Global Trend',
    data: data.map(d => [d.fullTimestamp.getTime(), d.value])
  }];

  // 2. Configuration for the Dark/Glass Theme
  const options: ApexOptions = {
    chart: {
      id: 'scrubber-chart',
      type: 'area',
      height: height,
      fontFamily: 'Inter, sans-serif',
      background: 'transparent',
      toolbar: { show: false }, // Hide the default hamburger menu
      events: {
        // This triggers when the user stops dragging/brushing
        selection: (chartContext, { xaxis }) => {
          if (xaxis) {
            onChange(xaxis.min, xaxis.max);
          }
        },
        // Optional: Update in real-time while dragging (can be heavy)
        // zoomed: (chartContext, { xaxis }) => { ... }
      },
      selection: {
        enabled: true,
        type: 'x',
        fill: {
          color: '#3b82f6',
          opacity: 0.1
        },
        stroke: {
          width: 1,
          dashArray: 3,
          color: '#3b82f6',
          opacity: 0.4
        }
      }
    },
    theme: { mode: 'dark' }, // Auto-adjusts text colors for dark mode
    stroke: {
      curve: 'smooth',
      width: 2,
      colors: ['#3b82f6'] // Primary Blue
    },
    fill: {
      type: 'gradient',
      gradient: {
        shadeIntensity: 1,
        opacityFrom: 0.4,
        opacityTo: 0.05,
        stops: [0, 100]
      }
    },
    grid: {
      borderColor: 'rgba(255,255,255,0.05)',
      yaxis: { lines: { show: false } } // Cleaner look
    },
    dataLabels: { enabled: false },
    xaxis: {
      type: 'datetime',
      tooltip: { enabled: false },
      axisBorder: { show: false },
      axisTicks: { show: false },
      labels: {
        style: { colors: 'rgba(255,255,255,0.4)', fontSize: '10px' },
        datetimeFormatter: {
          year: 'yyyy',
          month: 'MMM \'yy',
          day: 'dd MMM',
          hour: 'HH:mm'
        }
      }
    },
    yaxis: {
      show: false, // Hide Y axis for the scrubber to save space
      tickAmount: 2,
    },
    tooltip: {
      theme: 'dark',
      x: { format: 'dd MMM HH:mm' }
    }
  };

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactApexChart 
        options={options} 
        series={series} 
        type="area" 
        height={height} 
      />
    </div>
  );
};

export default TimelineScrubber;
