import React, { useState, useCallback, useEffect, useMemo } from "react";
import {
  Viewer,
  ViewerNavigationToolsProvider,
  ViewerContentToolsProvider,
  ViewerStatusbarItemsProvider,
} from "@itwin/web-viewer-react";
import { ECSchemaRpcInterface } from "@itwin/ecschema-rpcinterface-common";
import {
  AncestorsNavigationControls,
  CopyPropertyTextContextMenuItem,
  createPropertyGrid,
  ShowHideNullValuesSettingsMenuItem,
} from "@itwin/property-grid-react";
import { MeasureToolsUiItemsProvider } from "@itwin/measure-tools-react";
import { IModelApp, IModelConnection, ScreenViewport } from "@itwin/core-frontend";
import { Presentation } from "@itwin/presentation-frontend";
import { QueryRowFormat, ColorDef } from "@itwin/core-common";
import { unifiedSelectionStorage } from "../selectionStorage";
import "./HomeTab.scss";
import Topbar from "./components/Topbar";
import "./components/RightSidebar.scss";
import "./components/MainContent.scss";
import RightSidebar, { SidebarSection } from "./components/RightSidebar";
import MainContent from "./components/MainContent";
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

type LiveCardStatus = "active" | "pending" | "inactive";

interface LiveCardData {
  label: string;
  status: LiveCardStatus | "good" | "warning" | "critical";
  value: number | null;
  unit: string;
  deviation?: number | null;
  deviation_status?: "pending" | "good" | "warning" | "critical";
}

interface HomeSummaryResponse {
  state: LiveCardStatus;
  polling_enabled: boolean;
  last_update: string | null;
  pending_reason: string | null;
  cards: {
    temperature: LiveCardData;
    airQuality: LiveCardData;
    occupancy: LiveCardData;
    energyLoad: LiveCardData;
    deviation: LiveCardData;
  };
}

interface HomeTabProps {
  iTwinId: string | undefined;
  iModelId: string | undefined;
  changesetId: string | undefined;
  authClient: any;
  viewCreatorOptions: any;
  onIModelAppInit: any;
}

const MODEL_ID_1 = "0x200000001c0";
const MODEL_ID_2 = "0x3000000008b";
const HOME_SUMMARY_URL = "http://localhost:8000/api/home/summary";
const HOME_POLL_MS = 5000;

const inactiveSnapshot: HomeSummaryResponse = {
  state: "inactive",
  polling_enabled: false,
  last_update: null,
  pending_reason: "Ingestion polling is inactive.",
  cards: {
    temperature: { label: "Temperature", status: "inactive", value: null, unit: "degC" },
    airQuality: { label: "Air Quality", status: "inactive", value: null, unit: "ppm" },
    occupancy: { label: "Occupancy", status: "inactive", value: null, unit: "ppl" },
    energyLoad: { label: "Energy Load", status: "inactive", value: null, unit: "kW" },
    deviation: { label: "Deviation", status: "inactive", value: null, unit: "%" },
  },
};

const weatherCard = {
  value: "External",
  unit: "feed",
};

const HomeTab: React.FC<HomeTabProps> = ({
  iTwinId,
  iModelId,
  changesetId,
  authClient,
  viewCreatorOptions,
  onIModelAppInit,
}) => {
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [iModelConnection, setIModelConnection] = useState<IModelConnection | null>(null);
  const [category1Visible, setCategory1Visible] = useState(true);
  const [category2Visible, setCategory2Visible] = useState(true);
  const [homeSummary, setHomeSummary] = useState<HomeSummaryResponse>(inactiveSnapshot);

  const formatCardValue = (card: LiveCardData) => {
    if (card.value == null) return "--";
    if (card.unit === "degC") return card.value.toFixed(1);
    if (card.unit === "kW") return card.value.toFixed(2);
    if (card.unit === "%") return card.value.toFixed(1);
    return Math.round(card.value).toString();
  };

  const formatCardUnit = (unit: string) => {
    if (unit === "degC") return "°C";
    return unit;
  };

  useEffect(() => {
    let cancelled = false;

    const loadHomeSummary = async () => {
      try {
        const response = await fetch(HOME_SUMMARY_URL);
        if (!response.ok) {
          if (response.status === 503) {
            if (!cancelled) setHomeSummary(inactiveSnapshot);
            return;
          }
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = (await response.json()) as HomeSummaryResponse;
        if (!cancelled) {
          setHomeSummary(payload);
        }
      } catch (_error) {
        if (!cancelled) {
          setHomeSummary(inactiveSnapshot);
        }
      }
    };

    loadHomeSummary();
    const timer = window.setInterval(loadHomeSummary, HOME_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const energyCard = homeSummary.cards.energyLoad;
  const deviationCard = homeSummary.cards.deviation;
  const topbarIndicator =
    homeSummary.state === "active"
      ? { label: "Real-time ingestion active", dotClassName: "status-dot online", style: undefined }
      : homeSummary.state === "pending"
        ? { label: "Ingestion pending", dotClassName: "status-dot", style: { background: "#f59e0b" } }
        : { label: "Ingestion inactive", dotClassName: "status-dot", style: { background: "#ef4444" } };

  const handleCaptureScreenshot = () => { console.log("Capturing screenshot..."); };
  const handleExportState = () => { console.log("Exporting current state..."); };
  const handleRefreshView = () => { 
    console.log("Refreshing view..."); 
    if (IModelApp.viewManager.selectedView) {
      IModelApp.viewManager.selectedView.invalidateScene();
    }
  };
  const toggleTheme = () => { setIsDarkMode((prev) => !prev); };

  useEffect(() => {
    if (!iModelConnection) return;

    const changeBackground = (vp: ScreenViewport) => {
      const bgColor = ColorDef.fromString("#1A1D21");
      vp.displayStyle.backgroundColor = bgColor;
      vp.invalidateScene();
    };

    if (IModelApp.viewManager.selectedView) {
      changeBackground(IModelApp.viewManager.selectedView);
    }

    const removeListener = IModelApp.viewManager.onViewOpen.addListener((vp: ScreenViewport) => {
      changeBackground(vp);
    });

    return () => {
      removeListener();
    };
  }, [iModelConnection]);

  useEffect(() => {
    if (!iModelConnection) return;

    const disposable =
      Presentation.selection.suspendIModelToolSelectionSync(iModelConnection);

    return () => {
      disposable.dispose();
    };
  }, [iModelConnection]);

  const getElementIdsByCategory = useCallback(async (categoryId: string): Promise<string[]> => {
    if (!iModelConnection) return [];

    const query = `
      SELECT Model.id
      FROM bis.GeometricElement3d mesh
      WHERE mesh.Model.Id = ${categoryId}
    `;

    const elementIds: string[] = [];
    
    try {
      const result = iModelConnection.createQueryReader(query, undefined, { rowFormat: QueryRowFormat.UseJsPropertyNames });
      console.log(result)
      while (await result.step()) {
        const row = result.current.toRow();
        if (row.id) {
          elementIds.push(row.id);
        }
      }
    } catch (error) {
      console.error(`Error querying elements for category ${categoryId}:`, error);
    }

    console.log("Found element IDs for category", categoryId, ":", elementIds);
    return elementIds;
  }, [iModelConnection]);

  const setElementsVisibility = useCallback(async (modelId: string, visible: boolean) => {
    const vp = IModelApp.viewManager.selectedView;
    if (!vp || !iModelConnection) return;

    const elementIds = await getElementIdsByCategory(modelId);
    
    if (elementIds.length === 0) {
      console.warn(`No elements found for Model ${modelId}`);
      return;
    }

    const neverDrawn = new Set(vp.neverDrawn);

    if (!visible) {
      elementIds.forEach(id => neverDrawn.add(id));
    } else {
      elementIds.forEach(id => neverDrawn.delete(id));
    }

    vp.setNeverDrawn(neverDrawn);
    console.log(`Updated visibility for Model ${modelId}: ${visible ? 'Shown' : 'Hidden'} (${elementIds.length} elements)`);
  }, [iModelConnection, getElementIdsByCategory]);

  const toggleCategory1Visibility = useCallback(async () => {
    const vp = IModelApp.viewManager.selectedView;
    if (!vp || !iModelConnection) {
      console.warn("Viewport or iModel connection not available");
      return;
    }

    const newVisibility = !category1Visible;
    setCategory1Visible(newVisibility);
    setElementsVisibility(MODEL_ID_1, newVisibility);

    try {
      vp.changeModelDisplay([MODEL_ID_1], newVisibility);
      vp.invalidateScene();
      console.log(`Model ${MODEL_ID_1} is now ${newVisibility ? 'visible' : 'hidden'}`);
    } catch (error) {
      console.error("Error toggling category 1 visibility:", error);
    }
  }, [category1Visible, iModelConnection, setElementsVisibility]);

  const toggleCategory2Visibility = useCallback(async () => {
    const vp = IModelApp.viewManager.selectedView;
    if (!vp || !iModelConnection) {
      console.warn("Viewport or iModel connection not available");
      return;
    }

    const newVisibility = !category2Visible;
    setCategory2Visible(newVisibility);
    setElementsVisibility(MODEL_ID_2, newVisibility);

    try {
      vp.changeModelDisplay([MODEL_ID_2], newVisibility);
      vp.invalidateScene();
      console.log(`Model ${MODEL_ID_2} is now ${newVisibility ? 'visible' : 'hidden'}`);
    } catch (error) {
      console.error("Error toggling category 2 visibility:", error);
    }
  }, [category2Visible, iModelConnection, setElementsVisibility]);

  const handleIModelConnected = useCallback((connection: IModelConnection) => {
    setIModelConnection(connection);
    console.log("iModel connected:", connection.iModelId);
  }, []);

  const uiProviders = useMemo(
    () => [
      new ViewerNavigationToolsProvider(),
      new ViewerContentToolsProvider({ vertical: { measureGroup: false } }),
      new ViewerStatusbarItemsProvider(),
      {
        id: "PropertyGridUIProvider",
        getWidgets: () => [
          createPropertyGrid({
            autoExpandChildCategories: true,
            ancestorsNavigationControls: (props) => <AncestorsNavigationControls {...props} />,
            contextMenuItems: [(props) => <CopyPropertyTextContextMenuItem {...props} />],
            settingsMenuItems: [(props) => <ShowHideNullValuesSettingsMenuItem {...props} persist={true} />],
          }),
        ],
      },
      new MeasureToolsUiItemsProvider(),
    ],
    []
  );

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
                <button 
                  className={`folder-toggle-btn ${category2Visible ? 'active' : ''}`}
                  onClick={toggleCategory2Visibility}
                  disabled={!iModelConnection}
                >
                  <div className="folder-icon">
                    {category2Visible ? <EyeIcon /> : <EyeOffIcon />}
                  </div>
                  <div className="folder-info">
                    <span className="folder-name">Level 4</span>
                  </div>
                </button>
                <button 
                  className={`folder-toggle-btn ${category1Visible ? 'active' : ''}`}
                  onClick={toggleCategory1Visibility}
                  disabled={!iModelConnection}
                >
                  <div className="folder-icon">
                    {category1Visible ? <EyeIcon /> : <EyeOffIcon />}
                  </div>
                  <div className="folder-info">
                    <span className="folder-name">Level 3</span>
                  </div>
                </button>
              </div>
            </SidebarSection>

            <SidebarSection title="Environment" defaultExpanded={true}>
              <div className="sensor-grid">
                <div className="sensor-card weather">
                  <div className="icon-box">
                    <SunIcon />
                  </div>
                  <div className="label">Weather</div>
                  <span className="status-badge external">external</span>
                  <div className="value-group">
                    <span className="val">{weatherCard.value}</span>
                    <span className="unit">{weatherCard.unit}</span>
                  </div>
                </div>
                <div className={`sensor-card temp ${homeSummary.cards.temperature.status}`}>
                  <div className="icon-box">
                    <TemperatureIcon />
                  </div>
                  <div className="label">Temperature</div>
                  <span className={`status-badge ${homeSummary.cards.temperature.status}`}>{homeSummary.cards.temperature.status}</span>
                  <div className="value-group">
                    <span className="val">{formatCardValue(homeSummary.cards.temperature)}</span>
                    <span className="unit">{formatCardUnit(homeSummary.cards.temperature.unit)}</span>
                  </div>
                </div>
                <div className={`sensor-card air ${homeSummary.cards.airQuality.status}`}>
                  <div className="icon-box">
                    <AirQualityIcon />
                  </div>
                  <div className="label">Air Quality</div>
                  <span className={`status-badge ${homeSummary.cards.airQuality.status}`}>{homeSummary.cards.airQuality.status}</span>
                  <div className="value-group">
                    <span className="val">{formatCardValue(homeSummary.cards.airQuality)}</span>
                    <span className="unit">{formatCardUnit(homeSummary.cards.airQuality.unit)}</span>
                  </div>
                </div>
                <div className={`sensor-card occupancy ${homeSummary.cards.occupancy.status}`}>
                  <div className="icon-box">
                    <OccupancyIcon />
                  </div>
                  <div className="label">Occupancy</div>
                  <span className={`status-badge ${homeSummary.cards.occupancy.status}`}>{homeSummary.cards.occupancy.status}</span>
                  <div className="value-group">
                    <span className="val">{formatCardValue(homeSummary.cards.occupancy)}</span>
                    <span className="unit">{formatCardUnit(homeSummary.cards.occupancy.unit)}</span>
                  </div>
                </div>
              </div>
            </SidebarSection>

            <SidebarSection title="System Vitals" defaultExpanded={true}>
              <div className={`summary-card ${energyCard.deviation_status === "warning" || energyCard.deviation_status === "critical" ? "alert" : "normal"} ${energyCard.status}`}>
                <div className="icon-box">
                  <EnergyIcon />
                </div>
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
                <div className="icon-box">
                  <DeviationIcon />
                </div>
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
          <Viewer
            iTwinId={iTwinId ?? ""}
            iModelId={iModelId ?? ""}
            changeSetId={changesetId}
            authClient={authClient}
            viewCreatorOptions={viewCreatorOptions}
            enablePerformanceMonitors={true}
            onIModelAppInit={onIModelAppInit}
            onIModelConnected={handleIModelConnected}
            mapLayerOptions={{ BingMaps: { key: "key", value: process.env.IMJS_BING_MAPS_KEY ?? "" } }}
            backendConfiguration={{ defaultBackend: { rpcInterfaces: [ECSchemaRpcInterface] } }}
            uiProviders={uiProviders}
            selectionStorage={unifiedSelectionStorage}
          />
        </div>
      </MainContent>
    </div>
  );
};

export default HomeTab;
