import React, { ReactNode } from 'react';
import './Topbar.scss';

export type TopbarVariant = 'home' | 'dashboard' | 'forecast' | 'controller';

interface TopbarProps {
  title: string;
  subtitle?: string;
  variant?: TopbarVariant;
  rightContent?: ReactNode;
  leftContent?: ReactNode;
  className?: string;
}

const variantLabels: Record<TopbarVariant, string> = {
  home:       'LIVE VIEW',
  dashboard:  'ANALYTICS',
  forecast:   'PREDICTION',
  controller: 'CONTROL',
};

const Topbar: React.FC<TopbarProps> = ({
  title,
  subtitle,
  variant,
  rightContent,
  leftContent,
  className = '',
}) => {
  return (
    <header className={`topbar-container${variant ? ` topbar--${variant}` : ''} ${className}`}>
      {/* Decorative left accent bar */}
      <div className="topbar-accent" />

      {/* Branding / title area */}
      <div className="topbar-branding">
        {variant && (
          <span className="topbar-tag">{variantLabels[variant]}</span>
        )}
        <div className="topbar-title-row">
          {leftContent}
          <span className="topbar-title">{title}</span>
        </div>
        {subtitle && <div className="topbar-subtitle">{subtitle}</div>}
      </div>

      {/* Right-side actions */}
      <div className="topbar-actions">
        {rightContent}
      </div>

      {/* Decorative bottom glow line */}
      <div className="topbar-bottom-glow" />
    </header>
  );
};

export default Topbar;
