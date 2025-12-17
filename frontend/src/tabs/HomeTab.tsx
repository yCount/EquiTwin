import React, { useState, useCallback, useEffect } from "react";
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

  const sensorData = {
    weatherForecast: { value: "Sunny", unit: "25°C" },
    occupancy: { value: "22", unit: "ppl" },
    airQuality: { value: "45", unit: "AQI" },
    temperature: { value: "22.5", unit: "°C" },
    deviation: { value: "2.3", unit: "%" },
    energyUsage: { value: "1,247", unit: "kWh" },
  };

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

  return (
    <div className="home-tab-container">
      <Topbar
        title="Building Model"
        subtitle="Real-time Building Visualization & Telemetry"
        rightContent={
          <>
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
                  <div className="value-group">
                    <span className="val">{sensorData.weatherForecast.value}</span>
                  </div>
                </div>
                <div className="sensor-card temp">
                  <div className="icon-box">
                    <TemperatureIcon />
                  </div>
                  <div className="label">Temperature</div>
                  <div className="value-group">
                    <span className="val">{sensorData.temperature.value}</span>
                    <span className="unit">{sensorData.temperature.unit}</span>
                  </div>
                </div>
                <div className="sensor-card air">
                  <div className="icon-box">
                    <AirQualityIcon />
                  </div>
                  <div className="label">Air Quality</div>
                  <div className="value-group">
                    <span className="val">{sensorData.airQuality.value}</span>
                    <span className="unit">{sensorData.airQuality.unit}</span>
                  </div>
                </div>
                <div className="sensor-card occupancy">
                  <div className="icon-box">
                    <OccupancyIcon />
                  </div>
                  <div className="label">Occupancy</div>
                  <div className="value-group">
                    <span className="val">{sensorData.occupancy.value}</span>
                    <span className="unit">{sensorData.occupancy.unit}</span>
                  </div>
                </div>
              </div>
            </SidebarSection>

            <SidebarSection title="System Vitals" defaultExpanded={true}>
              <div className="summary-card normal">
                <div className="icon-box">
                  <EnergyIcon />
                </div>
                <div className="content">
                  <div className="label">Energy Load</div>
                  <span className="val">{sensorData.energyUsage.value}</span>
                  <span className="unit">{sensorData.energyUsage.unit}</span>
                </div>
              </div>
              <div className="summary-card alert">
                <div className="icon-box">
                  <DeviationIcon />
                </div>
                <div className="content">
                  <div className="label">Deviation</div>
                  <span className="val">{sensorData.deviation.value}</span>
                  <span className="unit">{sensorData.deviation.unit}</span>
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
            uiProviders={[
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
            ]}
            selectionStorage={unifiedSelectionStorage}
          />
        </div>
      </MainContent>
    </div>
  );
};

export default HomeTab;
