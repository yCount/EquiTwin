import React, { useState, useCallback } from "react";
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
import { IModelApp, IModelConnection, EmphasizeElements } from "@itwin/core-frontend";
import { QueryRowFormat } from "@itwin/core-common";
import { unifiedSelectionStorage } from "../selectionStorage";
import "./HomeTab.scss";
import Topbar from "./components/Topbar";
import RightSidebar, { SidebarSection } from "./components/RightSidebar";

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
  
  // State to track visibility of each category
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
  const toggleTheme = () => { setIsDarkMode((prev) => !prev); };

  // Query elements by category ID using the correct iTwin.js API
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

  // Helper to manage the "Hidden" list (NeverDrawn)
  const setElementsVisibility = useCallback(async (modelId: string, visible: boolean) => {
    const vp = IModelApp.viewManager.selectedView;
    if (!vp || !iModelConnection) return;

    // 1. Get the IDs from your working SQL query
    const elementIds = await getElementIdsByCategory(modelId);
    
    if (elementIds.length === 0) {
      console.warn(`No elements found for Model ${modelId}`);
      return;
    }

    // 2. specific 'Never Drawn' set manipulation
    const neverDrawn = new Set(vp.neverDrawn); // Copy current hidden list

    if (!visible) {
      // HIDE: Add these IDs to the neverDrawn set
      elementIds.forEach(id => neverDrawn.add(id));
    } else {
      // SHOW: Remove these IDs from the neverDrawn set
      elementIds.forEach(id => neverDrawn.delete(id));
    }

    // 3. Apply the new set and refresh
    vp.setNeverDrawn(neverDrawn);
    console.log(`Updated visibility for Model ${modelId}: ${visible ? 'Shown' : 'Hidden'} (${elementIds.length} elements)`);
    
  }, [iModelConnection, getElementIdsByCategory]);

// Toggle visibility for Model 1 (0x20000000074)
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
      // FIX: Use changeModelDisplay instead of changeCategoryDisplay
      // Note: changeModelDisplay does not require the 3rd 'overlay' argument
      vp.changeModelDisplay([MODEL_ID_1], newVisibility);
      
      console.log(`Model 1 (${MODEL_ID_1}) visibility: ${newVisibility}`);
    } catch (error) {
      console.error("Error toggling model 1 visibility:", error);
    }
  }, [category1Visible, iModelConnection]);

// Toggle visibility for Model 2 (0x3000000008b)
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
      // FIX: Use changeModelDisplay instead of changeCategoryDisplay
      vp.changeModelDisplay([MODEL_ID_2], newVisibility);
      
      console.log(`Model 2 (${MODEL_ID_2}) visibility: ${newVisibility}`);
    } catch (error) {
      console.error("Error toggling model 2 visibility:", error);
    }
  }, [category2Visible, iModelConnection]);

  // Alternative method: Hide/show individual elements using EmphasizeElements
  // Use this if changeCategoryDisplay doesn't work for your use case
  const toggleElementsVisibilityByCategory = useCallback(async (categoryId: string, visible: boolean) => {
    const vp = IModelApp.viewManager.selectedView;
    if (!vp || !iModelConnection) return;

    const elementIds = await getElementIdsByCategory(categoryId);
    if (elementIds.length === 0) {
      console.warn(`No elements found for category ${categoryId}`);
      return;
    }

    const emphasize = EmphasizeElements.getOrCreate(vp);
    
    if (!visible) {
      // Hide elements
      emphasize.hideElements(elementIds, vp, false);
    } else {
      // Show elements (clear hide override for these elements)
      emphasize.clearHiddenElements(vp);
    }

    vp.invalidateScene();
    console.log(`Toggled ${elementIds.length} elements for category ${categoryId} to ${visible ? 'visible' : 'hidden'}`);
  }, [iModelConnection, getElementIdsByCategory]);

  // Handle iModel connection when viewer is ready
  const handleIModelConnected = useCallback((iModel: IModelConnection) => {
    setIModelConnection(iModel);
    console.log("iModel connected:", iModel.name);
  }, []);

  return (
    <div 
      className={`home-tab-container iui-root ${isDarkMode ? 'iui-theme-dark' : 'iui-theme-light'}`}
      data-theme={isDarkMode ? 'dark' : 'light'}
    >
      <Topbar 
        title="Digital Twin Explorer"
        subtitle="Real-time Building Visualization & Telemetry"
        rightContent={
          <>
            <div className="topbar-status" style={{}}>
              <span className="status-dot online" />
              <span>System Online</span>
            </div>
            <button className="topbar-btn" onClick={handleCaptureScreenshot}>Capture</button>
            <button className="topbar-btn primary" onClick={handleExportState} style={{background: '#224c91'}}>Export</button>
          </>
        }
      />
      <div className="home-content">
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

        <RightSidebar width="360px">
          {/* Folder Visibility Controls */}
          <SidebarSection title="Model Visibility" defaultExpanded={true}>
            <div className="folder-toggle-grid">
              <button 
                className={`folder-toggle-btn ${category2Visible ? 'active' : ''}`}
                onClick={toggleCategory2Visibility}
                disabled={!iModelConnection}
              >
                <div className="folder-icon">
                  {category2Visible ? (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                  ) : (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                      <line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                  )}
                </div>
                <div className="folder-info">
                  <span className="folder-name">Level 4</span>
                  <span className="folder-status">{category2Visible ? 'Visible' : 'Hidden'}</span>
                </div>
              </button>
              <button 
                className={`folder-toggle-btn ${category1Visible ? 'active' : ''}`}
                onClick={toggleCategory1Visibility}
                disabled={!iModelConnection}
              >
                <div className="folder-icon">
                  {category1Visible ? (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                  ) : (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                      <line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                  )}
                </div>
                <div className="folder-info">
                  <span className="folder-name">Level 3</span>
                  <span className="folder-status">{category1Visible ? 'Visible' : 'Hidden'}</span>
                </div>
              </button>
            </div>
          </SidebarSection>

          <SidebarSection title="Environment" defaultExpanded={true}>
            <div className="sensor-grid">
              <div className="sensor-card weather">
                <div className="icon-box">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
                </div>
                <div className="label">Weather</div>
                <div className="value-group">
                  <span className="val">{sensorData.weatherForecast.value}</span>
                </div>
              </div>
              <div className="sensor-card temp">
                <div className="icon-box">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg>
                </div>
                <div className="label">Temperature</div>
                <div className="value-group">
                  <span className="val">{sensorData.temperature.value}</span>
                  <span className="unit">{sensorData.temperature.unit}</span>
                </div>
              </div>
              <div className="sensor-card air">
                <div className="icon-box">
                  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 8h14.5a2.5 2.5 0 0 1 0 5H14" /><path d="M6 16h13.5a2.5 2.5 0 0 0 0-5H19" /><path d="M2 12h5" /><path d="M16 8V7" /></svg>
                </div>
                <div className="label">Air Quality</div>
                <div className="value-group">
                  <span className="val">{sensorData.airQuality.value}</span>
                  <span className="unit">{sensorData.airQuality.unit}</span>
                </div>
              </div>
              <div className="sensor-card occupancy">
                <div className="icon-box">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
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
            <div style={{display: 'flex', flexDirection: 'column', gap: '12px'}}>
              <div className="summary-card normal">
                <div className="icon-box">
                  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
                </div>
                <div className="content">
                  <div className="label">Energy Load</div>
                  <span className="val">{sensorData.energyUsage.value}</span>
                  <span className="unit">{sensorData.energyUsage.unit}</span>
                </div>
              </div>
              <div className="summary-card alert">
                <div className="icon-box">
                  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h18" strokeDasharray="4 2" opacity="0.5" /><path d="M3 12l4 0 4-4 4 8 5-6" /><circle cx="20" cy="10" r="2" fill="currentColor" stroke="none" /></svg>
                </div>
                <div className="content">
                  <div className="label">Deviation</div>
                  <span className="val">{sensorData.deviation.value}</span>
                  <span className="unit">{sensorData.deviation.unit}</span>
                </div>
              </div>
            </div>
          </SidebarSection>
        </RightSidebar>
      </div>
    </div>
  );
};

export default HomeTab;
