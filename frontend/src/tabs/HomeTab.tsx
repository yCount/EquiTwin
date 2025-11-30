import React from "react";
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

  // Mock sensor data - To be deleted when integrated with real data source
  const sensorData = {
    weatherForecast: { value: "Sunny", unit: "25°C" },
    occupancy: { value: "22", unit: "people" },
    airQuality: { value: "45", unit: "AQI" },
    temperature: { value: "22.5", unit: "°C" },
    deviation: { value: "2.3", unit: "% deviation" },
    energyUsage: { value: "1,247", unit: "kWh" },
  };
  return (
    <div className="home-tab-wrapper">
      <div className="viewer-container">
        <Viewer
          iTwinId={iTwinId ?? ""}
          iModelId={iModelId ?? ""}
          changeSetId={changesetId}
          authClient={authClient}
          viewCreatorOptions={viewCreatorOptions}
          enablePerformanceMonitors={true}
          onIModelAppInit={onIModelAppInit}
          mapLayerOptions={{
            BingMaps: { key: "key", value: process.env.IMJS_BING_MAPS_KEY ?? "" },
          }}
          backendConfiguration={{
            defaultBackend: { rpcInterfaces: [ECSchemaRpcInterface] },
          }}
          uiProviders={[
            new ViewerNavigationToolsProvider(),
            new ViewerContentToolsProvider({
              vertical: { measureGroup: false },
            }),
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
                  ancestorsNavigationControls: (props) => (
                    <AncestorsNavigationControls {...props} />
                  ),
                  contextMenuItems: [
                    (props) => <CopyPropertyTextContextMenuItem {...props} />,
                  ],
                  settingsMenuItems: [
                    (props) => (
                      <ShowHideNullValuesSettingsMenuItem
                        {...props}
                        persist={true}
                      />
                    ),
                  ],
                }),
              ],
            },
            new MeasureToolsUiItemsProvider(),
          ]}
          selectionStorage={unifiedSelectionStorage}
        />
      </div>

      <div className="sensor-sidebar-panel">
        <div className="sensor-sidebar-content">
          <h2 className="sidebar-heading">Current Sensor Readings</h2>

          {/* Sensor Cards Grid */}
          <div className="sensors-grid">
            {/* Weather Card */}
            <div className="sensor-card card-weather">
              <div className="card-icon">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="4"></circle>
                  <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path>
                </svg>
              </div>
              <div className="card-label">Weather</div>
              <div className="card-value">{sensorData.weatherForecast.value}</div>
              <div className="card-unit">{sensorData.weatherForecast.unit}</div>
            </div>

            {/* Occupancy Card */}
            <div className="sensor-card card-occupancy">
              <div className="card-icon">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
                  <circle cx="9" cy="7" r="4"></circle>
                  <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"></path>
                </svg>
              </div>
              <div className="card-label">Occupancy</div>
              <div className="card-value">{sensorData.occupancy.value}</div>
              <div className="card-unit">{sensorData.occupancy.unit}</div>
            </div>

            {/* AQ Card */}
            <div className="sensor-card card-air">
              <div className="card-icon">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"></path>
                </svg>
              </div>
              <div className="card-label">Air Quality</div>
              <div className="card-value">{sensorData.airQuality.value}</div>
              <div className="card-unit">{sensorData.airQuality.unit}</div>
            </div>

            {/* Temperature Card */}
            <div className="sensor-card card-temperature">
              <div className="card-icon">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"></path>
                </svg>
              </div>
              <div className="card-label">Temperature</div>
              <div className="card-value">{sensorData.temperature.value}</div>
              <div className="card-unit">{sensorData.temperature.unit}</div>
            </div>
          </div>

          {/* Summary Cards */}
          <div className="summary-cards-container">
            {/* Deviation Card */}
            <div className="summary-card status-warning">
              <div className="summary-icon-box">
                <svg
                  width="26"
                  height="26"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>
                </svg>
              </div>
              <div className="summary-text">
                <div className="summary-title">Deviation from Ideal</div>
                <div className="summary-reading">
                  {sensorData.deviation.value}
                  <span className="reading-unit">{sensorData.deviation.unit}</span>
                </div>
              </div>
            </div>

            {/* Energy Usage Card */}
            <div className="summary-card status-normal">
              <div className="summary-icon-box">
                <svg
                  width="26"
                  height="26"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path>
                </svg>
              </div>
              <div className="summary-text">
                <div className="summary-title">Current Energy Usage</div>
                <div className="summary-reading">
                  {sensorData.energyUsage.value}
                  <span className="reading-unit">{sensorData.energyUsage.unit}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HomeTab;
