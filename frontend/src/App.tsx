import "./App.scss";
import LeftNavBar from "./LeftNavBar";
import HomeTab from "./tabs/HomeTab";
import DashboardTab from "./tabs/DashboardTab";
import ForecastTab from "./tabs/ForecastTab";
import ControllerTab from "./tabs/ControllerTab";
import React, { useEffect, useRef, useState } from "react";
import { useTheme } from "./ThemeContext";

const App: React.FC = () => {
  const { theme } = useTheme();

  const [activeTab, setActiveTab] = useState<"home" | "dashboard" | "forecast" | "tuning">("home");
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(new Set(["home"]));
  const activeTabRef = useRef<string>(activeTab);

  useEffect(() => {
    activeTabRef.current = activeTab;
    setVisitedTabs((prev) => new Set(prev).add(activeTab));

    document.querySelectorAll<HTMLElement>(".tab-content").forEach((el) => {
      if (el.classList.contains("active") && !el.getAttribute("data-tab")?.includes(activeTab)) {
        el.classList.replace("active", "inactive");
      }
    });
  }, [activeTab]);

  return (
    <div className={`app-root${theme === "light" ? " light-theme" : ""}`}>
      <div className="app-shell">
        <LeftNavBar activeTab={activeTab} setActiveTab={setActiveTab} />
        <main className="app-main">
          <div className="tabs-container">

            {activeTab === "home" && (
              <div className={`tab-content ${activeTab === "home" ? "active" : "inactive"}`} data-tab="home">
                <HomeTab />
              </div>
            )}

            {visitedTabs.has("dashboard") && (
              <div className={`tab-content ${activeTab === "dashboard" ? "active" : "inactive"}`} data-tab="dashboard">
                <DashboardTab />
              </div>
            )}

            {visitedTabs.has("forecast") && (
              <div className={`tab-content ${activeTab === "forecast" ? "active" : "inactive"}`} data-tab="forecast">
                <ForecastTab />
              </div>
            )}

            {visitedTabs.has("tuning") && (
              <div className={`tab-content ${activeTab === "tuning" ? "active" : "inactive"}`} data-tab="tuning">
                <ControllerTab />
              </div>
            )}

          </div>
        </main>
      </div>
    </div>
  );
};

export default App;
