import React, { ReactNode } from 'react';
import './Topbar.scss';

interface TopbarProps {
  title: string;
  subtitle?: string;
  rightContent?: ReactNode; // For buttons, toggles, status pills
  leftContent?: ReactNode;  // In case you need an icon next to the title
  className?: string;
}

const Topbar: React.FC<TopbarProps> = ({ 
  title, 
  subtitle, 
  rightContent, 
  leftContent,
  className = '' 
}) => {
  return (
    <header className={`topbar-container ${className}`}>
      <div className="topbar-branding">
        <div className="topbar-title">
          {leftContent}
          {title}
        </div>
        {subtitle && <div className="topbar-subtitle">{subtitle}</div>}
      </div>
      
      <div className="topbar-actions">
        {rightContent}
      </div>
    </header>
  );
};

export default Topbar;