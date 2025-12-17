import React, { ReactNode } from 'react';
import './MainContent.scss';

interface MainContentProps {
  children: ReactNode;
  className?: string;
  sidebar?: ReactNode;
  sidebarWidth?: string | number;
}

interface ContentAreaProps {
  children: ReactNode;
  className?: string;
  padding?: 'compact' | 'spacious';
  gap?: string | number;
}

interface SectionProps {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  headerActions?: ReactNode;
}

interface CardGridProps {
  children: ReactNode;
  className?: string;
  /** Number of columns (auto-fits by default) */
  columns?: number | 'auto';
  /** Gap between cards */
  gap?: string | number;
  /** Minimum card width for auto-fit */
  minCardWidth?: string;
}

export const MainContent: React.FC<MainContentProps> = ({ 
  children, 
  className = '', 
  sidebar,
  sidebarWidth = '360px'
}) => {
  const hasSidebar = Boolean(sidebar);
  
  return (
    <div 
      className={`main-content-layout ${hasSidebar ? 'with-sidebar' : ''} ${className}`}
      style={hasSidebar ? { gridTemplateColumns: `1fr ${sidebarWidth}` } : undefined}
    >
      <main className="main-content-area">
        {children}
      </main>
      
      {sidebar && (
        <aside className="main-content-sidebar">
          {sidebar}
        </aside>
      )}
    </div>
  );
};

export const ContentArea: React.FC<ContentAreaProps> = ({ 
  children, 
  className = '',
  padding = 'compact',
  gap = '12px'
}) => {
  return (
    <div 
      className={`content-area ${padding} ${className}`}
      style={{ gap }}
    >
      {children}
    </div>
  );
};

export const Section: React.FC<SectionProps> = ({ 
  children, 
  className = '',
  title,
  subtitle,
  headerActions
}) => {
  const hasHeader = Boolean(title || subtitle || headerActions);
  
  return (
    <section className={`content-section ${className}`}>
      {hasHeader && (
        <div className="section-header">
          <div className="section-header-content">
            {title && (
              <h2 className="section-title">
                {title}
              </h2>
            )}
            {subtitle && (
              <span className="section-subtitle">
                {subtitle}
              </span>
            )}
          </div>
          
          {headerActions && (
            <div className="section-header-actions">
              {headerActions}
            </div>
          )}
        </div>
      )}
      
      <div className="section-content">
        {children}
      </div>
    </section>
  );
};

export const CardGrid: React.FC<CardGridProps> = ({ 
  children, 
  className = '',
  columns = 'auto',
  gap = '16px',
  minCardWidth = '280px'
}) => {
  const gridTemplateColumns = 
    columns === 'auto' 
      ? `repeat(auto-fit, minmax(${minCardWidth}, 1fr))`
      : `repeat(${columns}, 1fr)`;
  
  return (
    <div 
      className={`card-grid ${className}`}
      style={{ 
        gridTemplateColumns,
        gap 
      }}
    >
      {children}
    </div>
  );
};

export default MainContent;
