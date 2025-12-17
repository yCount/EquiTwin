import React, { ReactNode } from 'react';
import './Topbar.scss';

interface TopbarProps {
  title: string;
  subtitle?: string;
  rightContent?: ReactNode;
  leftContent?: ReactNode; 
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