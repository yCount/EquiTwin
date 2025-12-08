import React, { ReactNode } from 'react';
import './RightSidebar.scss';

// --- Interfaces ---

interface RightSidebarProps {
  children: ReactNode;
  className?: string;
  width?: string | number;
}

interface SidebarSectionProps {
  title?: ReactNode; // Can be string or JSX (for icons/toggles)
  children: ReactNode;
  className?: string;
  noBorder?: boolean;
  collapsible?: boolean;
  defaultExpanded?: boolean;
}

// --- Sub-Components ---

/**
 * A consistent section container with a standardized header.
 * Supports collapsible content.
 */
export const SidebarSection: React.FC<SidebarSectionProps> = ({ 
  title, 
  children, 
  className = '', 
  noBorder = false,
  collapsible = false,
  defaultExpanded = true
}) => {
  const [isExpanded, setIsExpanded] = React.useState(defaultExpanded);

  const handleToggle = () => {
    if (collapsible) setIsExpanded(!isExpanded);
  };

  return (
    <div className={`sidebar-section ${className} ${noBorder ? 'no-border' : ''}`}>
      {title && (
        <div 
          className={`section-title ${collapsible ? 'clickable' : ''}`} 
          onClick={handleToggle}
        >
          <div className="title-content">{title}</div>
          {collapsible && (
            <span className="toggle-icon">{isExpanded ? '▼' : '▶'}</span>
          )}
        </div>
      )}
      
      {(!collapsible || isExpanded) && (
        <div className="section-content">
          {children}
        </div>
      )}
    </div>
  );
};

// --- Main Component ---

/**
 * The main container for the right-hand context/control bar.
 * wraps content in a styled, scrollable glass-panel container.
 */
const RightSidebar: React.FC<RightSidebarProps> = ({ 
  children, 
  className = '', 
  width 
}) => {
  return (
    <aside 
      className={`right-sidebar-container ${className}`}
      style={width ? { width, minWidth: width, flexBasis: width } : undefined}
    >
      <div className="sidebar-scroll-area">
        {children}
      </div>
    </aside>
  );
};

export default RightSidebar;
