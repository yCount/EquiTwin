import React, { useState, useCallback, useEffect, useMemo } from "react";
import "./HomeTab.scss";
import Topbar from "./components/Topbar";
import "./components/RightSidebar.scss";
import "./components/MainContent.scss";
import RightSidebar, { SidebarSection } from "./components/RightSidebar";
import MainContent from "./components/MainContent";
import ThreeViewer, { DEFAULT_SENSORS, SensorDef } from "./ThreeViewer";
import {
  EyeIcon,
  EyeOffIcon,
  SunIcon,
  TemperatureIcon,
  AirQualityIcon,
  OccupancyIcon,
  EnergyIcon,
  DeviationIcon,
  CameraIcon,
  DownloadIcon,
} from "./components/Icons";

// Types

type LiveCardStatus = "active" | "pending" | "inactive";

interface LiveCardData {
  label:             string;
  status:            LiveCardStatus | "good" | "warning" | "critical";
  value:             number | null;
  unit:              string;
  deviation?:        number | null;
  deviation_status?: "pending" | "good" | "warning" | "critical";
}

interface HomeSummaryResponse {
  state:           LiveCardStatus;
  polling_enabled: boolean;
  last_update:     string | null;
  pending_reason:  string | null;
  cards: {
    temperature: LiveCardData;
    airQuality:  LiveCardData;
    occupancy:   LiveCardData;
    energyLoad:  LiveCardData;
    deviation:   LiveCardData;
  };
}

interface ActiveSensorPopup {
  sensor: SensorDef;
}

// Constants

const HOME_SUMMARY_URL = "http://localhost:8000/api/home/summary";
const HOME_POLL_MS     = 5000;

const MODEL_URLS: string[] = ["/models/Level 4.rvt", "/models/Level 3.rvt"];
// const MODEL_URLS = ["/models/building.ifc"];
// const MODEL_URLS = ["/models/structure.glb", "/models/mep.ifc"];

const inactiveSnapshot: HomeSummaryResponse = {
  state:           "active",
  polling_enabled: true,
  last_update:     null,
  pending_reason:  null,
  cards: {
    temperature: { label: "Temperature", status: "active", value: 22.4, unit: "degC" },
    airQuality:  { label: "Air Quality", status: "active", value: 612,  unit: "ppm"  },
    occupancy:   { label: "Occupancy",   status: "active", value: 7,    unit: "ppl"  },
    energyLoad:  { label: "Energy Load", status: "active", value: 1.84, unit: "kW"   },
    deviation:   { label: "Deviation",   status: "good",   value: 4.2,  unit: "%"    },
  },
};

const weatherCard = { value: "External", unit: "feed" };

// Component

const HomeTab: React.FC = () => {
  const [homeSummary,       setHomeSummary]       = useState<HomeSummaryResponse>(inactiveSnapshot);
  const [hiddenFloors,      setHiddenFloors]      = useState<Set<string>>(new Set<string>());
  const [activeSensorPopup, setActiveSensorPopup] = useState<ActiveSensorPopup | null>(null);

  // Helpers

  const formatCardValue = (card: LiveCardData) => {
    if (card.value == null) return "--";
    if (card.unit === "degC") return card.value.toFixed(1);
    if (card.unit === "kW")   return card.value.toFixed(2);
    if (card.unit === "%")    return card.value.toFixed(1);
    return Math.round(card.value).toString();
  };

  const formatCardUnit = (unit: string) => (unit === "degC" ? "°C" : unit);

  // Backend polling

  useEffect(() => {
    let cancelled = false;

    const loadHomeSummary = async () => {
      try {
        const res = await fetch(HOME_SUMMARY_URL);
        if (!res.ok) {
          if (res.status === 503 && !cancelled) setHomeSummary(inactiveSnapshot);
          return;
        }
        const payload = (await res.json()) as HomeSummaryResponse;
        if (!cancelled) setHomeSummary(payload);
      } catch {
        if (!cancelled) setHomeSummary(inactiveSnapshot);
      }
    };

    loadHomeSummary();
    const timer = window.setInterval(loadHomeSummary, HOME_POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  // Derived state

  const energyCard    = homeSummary.cards.energyLoad;
  const deviationCard = homeSummary.cards.deviation;

  const topbarIndicator =
    homeSummary.state === "active"
      ? { label: "Real-time ingestion active",  dotClassName: "status-dot online", style: undefined }
      : homeSummary.state === "pending"
        ? { label: "Ingestion pending",  dotClassName: "status-dot", style: { background: "#f59e0b" } }
        : { label: "Ingestion inactive", dotClassName: "status-dot", style: { background: "#ef4444" } };

  const activeSensorContent = useMemo(() => {
    if (!activeSensorPopup) return null;
    const { occupancy, temperature, airQuality } = homeSummary.cards;

    return activeSensorPopup.sensor.kind === "occupancy" ? (
      <div className="sensor-popup__body">
        <div className="sensor-popup__metric">
          <span className="sensor-popup__metric-label">Current occupancy</span>
          <div className="sensor-popup__metric-value-row">
            <span className="sensor-popup__metric-value">{formatCardValue(occupancy)}</span>
            <span className="sensor-popup__metric-unit">{formatCardUnit(occupancy.unit)}</span>
          </div>
        </div>
      </div>
    ) : (
      <div className="sensor-popup__body sensor-popup__body--stacked">
        <div className="sensor-popup__metric">
          <span className="sensor-popup__metric-label">Temperature</span>
          <div className="sensor-popup__metric-value-row">
            <span className="sensor-popup__metric-value">{formatCardValue(temperature)}</span>
            <span className="sensor-popup__metric-unit">{formatCardUnit(temperature.unit)}</span>
          </div>
        </div>
        <div className="sensor-popup__metric">
          <span className="sensor-popup__metric-label">Air quality</span>
          <div className="sensor-popup__metric-value-row">
            <span className="sensor-popup__metric-value">{formatCardValue(airQuality)}</span>
            <span className="sensor-popup__metric-unit">{formatCardUnit(airQuality.unit)}</span>
          </div>
        </div>
      </div>
    );
  }, [activeSensorPopup, homeSummary.cards]);

  // Handlers

  const toggleFloor = useCallback((floor: string) => {
    setHiddenFloors((prev) => {
      const next = new Set(prev);
      if (next.has(floor)) next.delete(floor); else next.add(floor);
      return next;
    });
  }, []);

  const handleSensorClick = useCallback((sensor: SensorDef) => {
    setActiveSensorPopup((prev) =>
      prev?.sensor.id === sensor.id ? null : { sensor }
    );
  }, []);

  const handleCloseSensorPopup = useCallback(() => setActiveSensorPopup(null), []);

  const handleCaptureScreenshot = () => console.log("Capturing screenshot…");
  const handleExportState       = () => console.log("Exporting state…");

  // Render

  return (
    <div className="home-tab-container">
      <Topbar
        variant="home"
        title="Home"
        subtitle="Real-time Building Visualisation & Telemetry"
        rightContent={
          <>
            <div className="topbar-status">
              <span className={topbarIndicator.dotClassName} style={topbarIndicator.style} />
              <span>{topbarIndicator.label}</span>
            </div>
            <button className="topbar-btn" onClick={handleCaptureScreenshot}>
              <CameraIcon />
              Capture
            </button>
            <button className="topbar-btn primary" onClick={handleExportState}>
              <DownloadIcon />
              Export
            </button>
          </>
        }
      />

      <MainContent
        sidebar={
          <RightSidebar width="360px">

            <SidebarSection title="Floor Filter" defaultExpanded={true}>
              <div className="folder-toggle-grid">
                {(["level4", "level3"] as const).map((floor) => {
                  const visible = !hiddenFloors.has(floor);
                  return (
                    <button
                      key={floor}
                      className={`folder-toggle-btn ${visible ? "active" : ""}`}
                      onClick={() => toggleFloor(floor)}
                    >
                      <div className="folder-icon">
                        {visible ? <EyeIcon /> : <EyeOffIcon />}
                      </div>
                      <div className="folder-info">
                        <span className="folder-name">
                          {floor === "level4" ? "Level 4" : "Level 3"}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </SidebarSection>

            <SidebarSection title="Environment" defaultExpanded={true}>
              <div className="sensor-grid">
                <div className="sensor-card weather">
                  <div className="icon-box"><SunIcon /></div>
                  <div className="label">Weather</div>
                  <span className="status-badge external">external</span>
                  <div className="value-group">
                    <span className="val">{weatherCard.value}</span>
                    <span className="unit">{weatherCard.unit}</span>
                  </div>
                </div>
                <div className={`sensor-card temp ${homeSummary.cards.temperature.status}`}>
                  <div className="icon-box"><TemperatureIcon /></div>
                  <div className="label">Temperature</div>
                  <span className={`status-badge ${homeSummary.cards.temperature.status}`}>
                    {homeSummary.cards.temperature.status}
                  </span>
                  <div className="value-group">
                    <span className="val">{formatCardValue(homeSummary.cards.temperature)}</span>
                    <span className="unit">{formatCardUnit(homeSummary.cards.temperature.unit)}</span>
                  </div>
                </div>
                <div className={`sensor-card air ${homeSummary.cards.airQuality.status}`}>
                  <div className="icon-box"><AirQualityIcon /></div>
                  <div className="label">Air Quality</div>
                  <span className={`status-badge ${homeSummary.cards.airQuality.status}`}>
                    {homeSummary.cards.airQuality.status}
                  </span>
                  <div className="value-group">
                    <span className="val">{formatCardValue(homeSummary.cards.airQuality)}</span>
                    <span className="unit">{formatCardUnit(homeSummary.cards.airQuality.unit)}</span>
                  </div>
                </div>
                <div className={`sensor-card occupancy ${homeSummary.cards.occupancy.status}`}>
                  <div className="icon-box"><OccupancyIcon /></div>
                  <div className="label">Occupancy</div>
                  <span className={`status-badge ${homeSummary.cards.occupancy.status}`}>
                    {homeSummary.cards.occupancy.status}
                  </span>
                  <div className="value-group">
                    <span className="val">{formatCardValue(homeSummary.cards.occupancy)}</span>
                    <span className="unit">{formatCardUnit(homeSummary.cards.occupancy.unit)}</span>
                  </div>
                </div>
              </div>
            </SidebarSection>

            <SidebarSection title="System Vitals" defaultExpanded={true}>
              <div className={`summary-card ${energyCard.deviation_status === "warning" || energyCard.deviation_status === "critical" ? "alert" : "normal"} ${energyCard.status}`}>
                <div className="icon-box"><EnergyIcon /></div>
                <div className="content">
                  <div className="label">Energy Load</div>
                  <span className={`status-badge ${energyCard.status}`}>{energyCard.status}</span>
                  <div>
                    <span className="val">{formatCardValue(energyCard)}</span>
                    <span className="unit">{formatCardUnit(energyCard.unit)}</span>
                  </div>
                </div>
              </div>
              <div className={`summary-card ${deviationCard.status === "warning" || deviationCard.status === "critical" ? "alert" : "normal"} ${deviationCard.status}`}>
                <div className="icon-box"><DeviationIcon /></div>
                <div className="content">
                  <div className="label">Deviation</div>
                  <span className={`status-badge ${deviationCard.status}`}>{deviationCard.status}</span>
                  <div>
                    <span className="val">{formatCardValue(deviationCard)}</span>
                    <span className="unit">{formatCardUnit(deviationCard.unit)}</span>
                  </div>
                </div>
              </div>
            </SidebarSection>

          </RightSidebar>
        }
        sidebarWidth="360px"
      >
        <div className="viewer-wrapper">

          <ThreeViewer
            modelUrls={MODEL_URLS}
            sensors={DEFAULT_SENSORS}
            hiddenFloors={hiddenFloors}
            onSensorClick={handleSensorClick}
          />

          {activeSensorPopup && (
            <div className={`sensor-popup sensor-popup--${activeSensorPopup.sensor.kind}`}>
              <div className="sensor-popup__glow" />
              <div className="sensor-popup__header">
                <div className="sensor-popup__title-group">
                  <span className="sensor-popup__eyebrow">Selected sensor</span>
                  <h3>
                    {activeSensorPopup.sensor.kind === "occupancy"
                      ? "Occupancy Sensor"
                      : "Room Sensor"}
                  </h3>
                </div>
                <button
                  className="sensor-popup__close"
                  type="button"
                  onClick={handleCloseSensorPopup}
                  aria-label="Close sensor popup"
                >
                  ×
                </button>
              </div>
              {activeSensorContent}
              <div className="sensor-popup__footer">
                {activeSensorPopup.sensor.label}
              </div>
            </div>
          )}

        </div>
      </MainContent>
    </div>
  );
};

export default HomeTab;
