import React, { useState } from "react";
import "./LeftNavBar.scss";
import {
  HomeIcon,
  HomeIconOutline,
  DashboardIcon,
  DashboardIconOutline,
  PredictionIcon,
  PredictionIconOutline,
  ControllerIcon,
  ControllerIconOutline,
  AlertsIconOutline,
  SettingsIconOutline,
} from "./tabs/components/Icons";

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
            <img src="/public/images/EquiTwin_logo.png"
            alt="EquiTwin"
            style={{ width: '50px', backgroundColor: 'transparent' }}
            />
          </span>
          <span className="logo-label" style={{ fontSize: '17px'}}>EquiTwin</span>
        </button>
        <div className="nav-divider" style={{ marginBottom: '12px' }}></div>
        
        {/* Home Button */}
        <button
          type="button"
          id="home-button"
          className={`tab-button ${activeTab === "home" ? "active" : ""}`}
          onClick={() => setActiveTab("home")}
        >
          <span className="tab-icon">
            {activeTab === "home" ? (
              <HomeIcon width={38} height={38} />
            ) : (
              <HomeIconOutline width={38} height={38} />
            )}
          </span>
          <span className="tab-label">Home</span>
        </button>
        
        {/* Dashboard Button */}
        <button
          type="button"
          id="dashboard-button"
          className={`tab-button ${activeTab === "dashboard" ? "active" : ""}`}
          onClick={() => setActiveTab("dashboard")}
        >
          <span className="tab-icon">
            {activeTab === "dashboard" ? (
              <DashboardIcon width={38} height={38} />
            ) : (
              <DashboardIconOutline width={38} height={38} />
            )}
          </span>
          <span className="tab-label">Dashboard</span>
        </button>
        
        {/* Prediction Button */}
        <button
          type="button"
          id="prediction-button"
          className={`tab-button ${activeTab === "forecast" ? "active" : ""}`}
          onClick={() => setActiveTab("forecast")}
        >
          <span className="tab-icon">
            {activeTab === "forecast" ? (
              <PredictionIcon width={38} height={38} />
            ) : (
              <PredictionIconOutline width={38} height={38} />
            )}
          </span>
          <span className="tab-label">Prediction</span>
        </button>
        
        {/* Controller Button */}
        <button
          type="button"
          id="controller-button"
          className={`tab-button ${activeTab === "tuning" ? "active" : ""}`}
          onClick={() => setActiveTab("tuning")}
        >
          <span className="tab-icon">
            {activeTab === "tuning" ? (
              <ControllerIcon width={38} height={38} />
            ) : (
              <ControllerIconOutline width={38} height={38} />
            )}
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
            <AlertsIconOutline width={30} height={30} />
          </span>
          <span className="info-label">Alerts</span>
        </button>
        <button
          className="info-button"
          type="button"
          style={{ marginBottom: '3px', marginTop: '3px' }}
        >
          <span className="info-icon">
            <SettingsIconOutline width={30} height={30} />
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
            <img src="/public/images/SAWB.png"
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
