import React, { useState } from "react";
import "./LeftNavBar.scss";

interface LeftNavBarProps {
  activeTab: "home" | "dashboard" | "forecast" | "tuning";
  setActiveTab: (tab: "home" | "dashboard" | "forecast" | "tuning") => void;
}

const LeftNavBar: React.FC<LeftNavBarProps> = ({ activeTab, setActiveTab }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const toggleExpanded = () => {
    setIsExpanded(!isExpanded);
  };

  return (
    <nav className={`app-sidebar ${isExpanded ? "expanded" : ""}`}>
      <div className="nav-buttons">
        <button
          type="button" 
          className="logo-button"
          style={{ backgroundColor: 'transparent', border: 'none' }}
          onClick={toggleExpanded}
        >
          <span>
            <img src="/images/EquiTwin_logo.png"
            alt="EquiTwin"
            style={{ width: '50px', backgroundColor: 'transparent' }}
            />
          </span>
          <span className="logo-label" style={{ fontSize: '17px'}}>EquiTwin</span>
        </button>
        <div className="nav-divider" style={{ marginBottom: '12px' }}></div>
        <button
          type="button"
          id="home-button"
          className={`tab-button ${activeTab === "home" ? "active" : ""}`}
          onClick={() => setActiveTab("home")}
        >
          <span className="tab-icon">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-4H10v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z" />
            </svg>
          </span>
          <span className="tab-label">Home</span>
        </button>
        <button
          type="button"
          id="dashboard-button"
          className={`tab-button ${activeTab === "dashboard" ? "active" : ""}`}
          onClick={() => setActiveTab("dashboard")}
        >
          <span className="tab-icon">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="7" height="7"></rect>
              <rect x="14" y="3" width="7" height="5"></rect>
              <rect x="14" y="11" width="7" height="10"></rect>
              <rect x="3" y="12" width="7" height="9"></rect>
            </svg>
          </span>
          <span className="tab-label">Dashboard</span>
        </button>
        <button
          type="button"
          id="prediction-button"
          className={`tab-button ${activeTab === "forecast" ? "active" : ""}`}
          onClick={() => setActiveTab("forecast")}
        >
          <span className="tab-icon">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 17l6-6 4 4 8-8"></path>
              <path d="M14 7h7v7"></path>
            </svg>
          </span>
          <span className="tab-label">Prediction</span>
        </button>
        <button
          type="button"
          id="controller-button"
          className={`tab-button ${activeTab === "tuning" ? "active" : ""}`}
          onClick={() => setActiveTab("tuning")}
        >
          <span className="tab-icon">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="4" y1="21" x2="4" y2="14"></line>
              <line x1="4" y1="10" x2="4" y2="3"></line>
              <line x1="12" y1="21" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12" y2="3"></line>
              <line x1="20" y1="21" x2="20" y2="16"></line>
              <line x1="20" y1="12" x2="20" y2="3"></line>
              <line x1="1" y1="14" x2="7" y2="14"></line>
              <line x1="9" y1="8" x2="15" y2="8"></line>
              <line x1="17" y1="16" x2="23" y2="16"></line>
            </svg>
          </span>
          <span className="tab-label">Controller</span>
        </button>
      </div>
      <div className="info-buttons">
        <button
          className="info-button"
          type="button"
        >
          <span className="info-icon">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path>
              <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path>
            </svg>
          </span>
          <span className="info-label">Alerts</span>
        </button>
        <button
          className="info-button"
          type="button"
          style={{ marginBottom: '3px', marginTop: '3px' }}
        >
          <span className="info-icon">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path 
                d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
                transform="rotate(30 12 12)"
              ></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
          </span>
          <span className="info-label">Settings</span>
        </button>
        <div className="nav-divider"></div>
        <button
          className="logo-button"
          type="button"
          onClick={toggleExpanded}
        >
          <span className="logo-icon">
            <img src="/images/SAWB.png"
            alt="Sir Alwyn Willam Building"
            style={{ width: '50px', borderRadius: '50%', objectFit: 'cover' }}
            />
          </span>
          <span className="info-label">SAW Building</span>
        </button>
      </div>
    </nav>
  );
};

export default LeftNavBar;
