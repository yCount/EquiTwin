import React, { ReactNode } from 'react';
import './RightSidebar.scss';

interface RightSidebarProps {
  children: ReactNode;
  className?: string;
}

const RightSidebar = ({ children, className = '' }: RightSidebarProps) => {
  return (
    <aside className={`right-sidebar ${className}`}>
      <div className="sidebar-content">
        {children}
      </div>
    </aside>
  );
};

// Sub-component for consistent Sections
interface SectionProps {
  title: string;
  rightElement?: ReactNode; // For a button or badge in the header
  children: ReactNode;
  className?: string;
}

const Section = ({ title, rightElement, children, className = '' }: SectionProps) => {
  return (
    <div className={`sidebar-section ${className}`}>
      <div className="section-title">
        <span>{title}</span>
        {rightElement && <span>{rightElement}</span>}
      </div>
      {children}
    </div>
  );
};

// Attach sub-component
(RightSidebar as any).Section = Section;

export default RightSidebar as typeof RightSidebar & {
  Section: typeof Section;
};
