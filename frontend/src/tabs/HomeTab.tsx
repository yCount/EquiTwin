import React, { useState } from "react";
import {
  Viewer,
  ViewerNavigationToolsProvider,
  ViewerContentToolsProvider,
  ViewerStatusbarItemsProvider,
} from "@itwin/web-viewer-react";
import { ECSchemaRpcInterface } from "@itwin/ecschema-rpcinterface-common";
import {
  CategoriesTreeComponent,
  createTreeWidget,
  ModelsTreeComponent,
} from "@itwin/tree-widget-react";
import {
  AncestorsNavigationControls,
  CopyPropertyTextContextMenuItem,
  createPropertyGrid,
  ShowHideNullValuesSettingsMenuItem,
} from "@itwin/property-grid-react";
import { MeasureToolsUiItemsProvider } from "@itwin/measure-tools-react";
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

const HomeTab: React.FC<HomeTabProps> = ({
  iTwinId,
  iModelId,
  changesetId,
  authClient,
  viewCreatorOptions,
  onIModelAppInit,
}) => {
  const [isDarkMode, setIsDarkMode] = useState(true);

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
            <div className="topbar-status" style={{
              // display: 'flex', alignItems: 'center', gap: '8px',
              // fontSize: '12px', color: isDarkMode ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)',
              // padding: '6px 12px', background: 'var(--card-bg)',
              // borderRadius: '20px', border: '1px solid var(--panel-border)'
            }}>
              <span className="status-dot online" />
               <span>System Online</span>
            </div>

            {/* <button className="theme-toggle-btn" onClick={toggleTheme} title={isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}>
              {isDarkMode ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
              )}
            </button> */}

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
            mapLayerOptions={{ BingMaps: { key: "key", value: process.env.IMJS_BING_MAPS_KEY ?? "" } }}
            backendConfiguration={{ defaultBackend: { rpcInterfaces: [ECSchemaRpcInterface] } }}
            uiProviders={[
              new ViewerNavigationToolsProvider(),
              new ViewerContentToolsProvider({ vertical: { measureGroup: false } }),
              new ViewerStatusbarItemsProvider(),
              {
                id: "TreeWidgetUIProvider",
                getWidgets: () => [
                  createTreeWidget({
                    trees: [
                      {
                        id: ModelsTreeComponent.id,
                        getLabel: () => ModelsTreeComponent.getLabel(),
                        render: (props) => (
                          <ModelsTreeComponent
                            getSchemaContext={(iModel) => iModel.schemaContext}
                            density={props.density}
                            selectionStorage={unifiedSelectionStorage}
                            selectionMode="extended"
                            onPerformanceMeasured={props.onPerformanceMeasured}
                            onFeatureUsed={props.onFeatureUsed}
                          />
                        ),
                      },
                      {
                        id: CategoriesTreeComponent.id,
                        getLabel: () => CategoriesTreeComponent.getLabel(),
                        render: (props) => (
                          <CategoriesTreeComponent
                            getSchemaContext={(iModel) => iModel.schemaContext}
                            density={props.density}
                            selectionStorage={unifiedSelectionStorage}
                            onPerformanceMeasured={props.onPerformanceMeasured}
                            onFeatureUsed={props.onFeatureUsed}
                          />
                        ),
                      },
                    ],
                  }),
                ],
              },
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

        {/* Updated Right Sidebar Implementation */}
        <RightSidebar width="360px">
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
