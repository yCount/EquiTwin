import React from 'react';

interface IconProps {
  width?: number;
  height?: number;
  className?: string;
}

// ============================================
// Navigation Icons (Filled versions for navbar)
// ============================================

export const HomeIcon: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="currentColor" stroke="none" className={className} aria-hidden="true">
    <path d="M3 10l9-7 9 7v11c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V10Z"/>
    <rect x="10" y="14" width="4" height="7" rx="0.5" fill="rgba(0,0,0,0.3)"/>
  </svg>
);

export const HomeIconOutline: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <path d="M3 10l9-7 9 7v11c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V10Z"/>
    <rect x="10" y="14" width="4" height="7" rx="0.5"/>
  </svg>
);

export const DashboardIcon: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="currentColor" stroke="none" className={className} aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="3"/>
    <path d="M7 15a5 5 0 0 1 10 0" fill="none" stroke="rgba(0,0,0,0.3)" strokeWidth="2.5" strokeLinecap="round"/>
    <path d="M12 15V10" fill="none" stroke="rgba(0,0,0,0.3)" strokeWidth="2.5" strokeLinecap="round" transform="rotate(-30 12 15)"/>
  </svg>
);

export const DashboardIconOutline: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="3"/>
    <path d="M7 15a5 5 0 0 1 10 0"/>
    <path d="M12 15V10" transform="rotate(-30 12 15)"/>
  </svg>
);

export const PredictionIcon: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="currentColor" stroke="none" className={className} aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="3"/>
    <path d="M6 16l4-3 4 2 4-6" fill="none" stroke="rgba(0,0,0,0.3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M16 9l2 0 0 2" fill="none" stroke="rgba(0,0,0,0.3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

export const PredictionIconOutline: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="3"/>
    <path d="M6 16l4-3 4 2 4-6"/>
    <path d="M16 9l2 0 0 2"/>
  </svg>
);

export const ControllerIcon: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="currentColor" stroke="none" className={className} aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="3"/>
    <path d="M7 8h10M7 12h10M7 16h10" fill="none" stroke="rgba(0,0,0,0.3)" strokeWidth="2" strokeLinecap="round"/>
    <circle cx="10" cy="8" r="2.5" fill="rgba(0,0,0,0.3)"/>
    <circle cx="15" cy="12" r="2.5" fill="rgba(0,0,0,0.3)"/>
    <circle cx="11" cy="16" r="2.5" fill="rgba(0,0,0,0.3)"/>
  </svg>
);

export const ControllerIconOutline: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="3"/>
    <path d="M7 8h10M7 12h10M7 16h10"/>
    <circle cx="10" cy="8" r="2" fill="currentColor" stroke="none"/>
    <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/>
    <circle cx="11" cy="16" r="2" fill="currentColor" stroke="none"/>
  </svg>
);

export const AlertsIcon: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="currentColor" stroke="none" className={className}>
    <path d="M12 2C10.9 2 10 2.9 10 4V4.29C7.19 5.17 5 7.92 5 11V17L3 19V20H21V19L19 17V11C19 7.92 16.81 5.17 14 4.29V4C14 2.9 13.1 2 12 2ZM12 22C10.9 22 10 21.1 10 20H14C14 21.1 13.1 22 12 22Z" />
  </svg>
);

export const AlertsIconOutline: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
);

export const SettingsIcon: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="currentColor" stroke="none" className={className}>
    <path d="M12 15.5C10.07 15.5 8.5 13.93 8.5 12C8.5 10.07 10.07 8.5 12 8.5C13.93 8.5 15.5 10.07 15.5 12C15.5 13.93 13.93 15.5 12 15.5ZM19.43 12.97C19.47 12.65 19.5 12.33 19.5 12C19.5 11.67 19.47 11.35 19.43 11.03L21.54 9.37C21.73 9.22 21.78 8.95 21.66 8.73L19.66 5.27C19.54 5.05 19.27 4.97 19.05 5.05L16.56 6.05C16.04 5.65 15.48 5.32 14.87 5.07L14.5 2.42C14.46 2.18 14.25 2 14 2H10C9.75 2 9.54 2.18 9.5 2.42L9.13 5.07C8.52 5.32 7.96 5.66 7.44 6.05L4.95 5.05C4.73 4.96 4.46 5.05 4.34 5.27L2.34 8.73C2.21 8.95 2.27 9.22 2.46 9.37L4.57 11.03C4.53 11.35 4.5 11.68 4.5 12C4.5 12.32 4.53 12.65 4.57 12.97L2.46 14.63C2.27 14.78 2.21 15.05 2.34 15.27L4.34 18.73C4.46 18.95 4.73 19.03 4.95 18.95L7.44 17.95C7.96 18.35 8.52 18.68 9.13 18.93L9.5 21.58C9.54 21.82 9.75 22 10 22H14C14.25 22 14.46 21.82 14.5 21.58L14.87 18.93C15.48 18.68 16.04 18.34 16.56 17.95L19.05 18.95C19.27 19.04 19.54 18.95 19.66 18.73L21.66 15.27C21.78 15.05 21.73 14.78 21.54 14.63L19.43 12.97Z" />
  </svg>
);

export const SettingsIconOutline: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path 
      d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
      transform="rotate(30 12 12)"
    />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

// ============================================
// Other Utility Icons (from original file)
// ============================================

export const EyeIcon: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
);

export const EyeOffIcon: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);

export const TemperatureIcon: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>
  </svg>
);

export const SunIcon: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <circle cx="12" cy="12" r="5"/>
    <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
  </svg>
);

export const AirQualityIcon: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M2 8h14.5a2.5 2.5 0 0 1 0 5H14" />
    <path d="M6 16h13.5a2.5 2.5 0 0 0 0-5H19" />
    <path d="M2 12h5" />
    <path d="M16 8V7" />
  </svg>
);

export const OccupancyIcon: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>
);

export const EnergyIcon: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
  </svg>
);

export const DeviationIcon: React.FC<IconProps> = ({ width = 24, height = 24, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M3 12h18" strokeDasharray="4 2" opacity="0.5" />
    <path d="M3 12l4 0 4-4 4 8 5-6" />
    <circle cx="20" cy="10" r="2" fill="currentColor" stroke="none" />
  </svg>
);

export const CameraIcon: React.FC<IconProps> = ({ width = 14, height = 14, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <circle cx="8.5" cy="8.5" r="1.5"/>
    <path d="m21 15-5-5L5 21"/>
  </svg>
);

export const DownloadIcon: React.FC<IconProps> = ({ width = 14, height = 14, className }) => (
  <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
  </svg>
);
