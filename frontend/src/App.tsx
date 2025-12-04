/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import "./App.scss";
import LeftNavBar from "./LeftNavBar";
import HomeTab from "./tabs/HomeTab";
import DashboardTab from "./tabs/DashboardTab";
import ForecastTab from "./tabs/ForecastTab";
import TuningTab from "./tabs/TuningTab";
import type { ScreenViewport } from "@itwin/core-frontend";
import { FitViewTool, IModelApp, StandardViewId } from "@itwin/core-frontend";
import { Flex, ProgressLinear } from "@itwin/itwinui-react";
import {
  MeasurementActionToolbar,
  MeasureTools,
} from "@itwin/measure-tools-react";
import {
  PropertyGridManager,
} from "@itwin/property-grid-react";
import {
  TreeWidget,
} from "@itwin/tree-widget-react";
import {
  useAccessToken,
  ViewerPerformance,
} from "@itwin/web-viewer-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Auth } from "./Auth";
import { history } from "./history";
import { unifiedSelectionStorage } from "./selectionStorage";

const App: React.FC = () => {
  const [iModelId, setIModelId] = useState(process.env.IMJS_IMODEL_ID);
  const [iTwinId, setITwinId] = useState(process.env.IMJS_ITWIN_ID);
  const [changesetId, setChangesetId] = useState(
    process.env.IMJS_AUTH_CLIENT_CHANGESET_ID
  );
  const accessToken = useAccessToken();
  const authClient = Auth.getClient();
  
  const [activeTab, setActiveTab] = useState<
    "home" | "dashboard" | "forecast" | "tuning"
  >("home");
  
  // Track which tabs have been visited to avoid initial render cost
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(new Set(["home"]));
  
  // Use ref to track the actual active tab for immediate DOM updates
  const activeTabRef = React.useRef<string>(activeTab);

  const login = useCallback(async () => {
    try {
      await authClient.signInSilent();
    } catch {
      await authClient.signIn();
    }
  }, [authClient]);

  useEffect(() => {
    void login();
  }, [login]);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has("iTwinId")) {
      setITwinId(urlParams.get("iTwinId") as string);
    }
    if (urlParams.has("iModelId")) {
      setIModelId(urlParams.get("iModelId") as string);
    }
    if (urlParams.has("changesetId")) {
      setChangesetId(urlParams.get("changesetId") as string);
    }
  }, []);

  useEffect(() => {
    let url = `viewer?iTwinId=${iTwinId}`;
    if (iModelId) {
      url = `${url}&iModelId=${iModelId}`;
    }
    if (changesetId) {
      url = `${url}&changesetId=${changesetId}`;
    }
    history.push(url);
  }, [iTwinId, iModelId, changesetId]);

  // Track visited tabs when active tab changes
  useEffect(() => {
    activeTabRef.current = activeTab;
    setVisitedTabs((prev) => new Set(prev).add(activeTab));
    
    // Force immediate style update on all tab elements
    const allTabs = document.querySelectorAll('.tab-content');
    allTabs.forEach((tab) => {
      const tabElement = tab as HTMLElement;
      if (tabElement.classList.contains('active')) {
        if (!tabElement.getAttribute('data-tab')?.includes(activeTab)) {
          tabElement.classList.remove('active');
          tabElement.classList.add('inactive');
        }
      }
    });
  }, [activeTab]);

  const viewConfiguration = useCallback((viewPort: ScreenViewport) => {
    const tileTreesLoaded = () => {
      return new Promise((resolve, reject) => {
        const start = new Date();
        const intvl = setInterval(() => {
          if (viewPort.areAllTileTreesLoaded) {
            ViewerPerformance.addMark("TilesLoaded");
            ViewerPerformance.addMeasure(
              "TileTreesLoaded",
              "ViewerStarting",
              "TilesLoaded"
            );
            clearInterval(intvl);
            resolve(true);
          }
          const now = new Date();
          if (now.getTime() - start.getTime() > 20000) {
            reject();
          }
        }, 100);
      });
    };
    tileTreesLoaded().finally(() => {
      void IModelApp.tools.run(FitViewTool.toolId, viewPort, true, false);
      viewPort.view.setStandardRotation(StandardViewId.Iso);
    });
  }, []);

  const viewCreatorOptions = useMemo(
    () => ({ viewportConfigurer: viewConfiguration }),
    [viewConfiguration]
  );

  const onIModelAppInit = useCallback(async () => {
    await TreeWidget.initialize();
    await PropertyGridManager.initialize();
    await MeasureTools.startup();
    MeasurementActionToolbar.setDefaultActionProvider();
  }, []);

  return (
    <div className="app-root">
      {!accessToken && (
        <Flex justifyContent="center" style={{ height: "100%" }}>
          <div className="signin-content">
            <ProgressLinear indeterminate={true} labels={["Signing in..."]} />
          </div>
        </Flex>
      )}
      <div className="app-shell">
        <LeftNavBar activeTab={activeTab} setActiveTab={setActiveTab} />
        <main className="app-main">
          <div className="tabs-container">
            {visitedTabs.has("home") && (
              <div 
                className={`tab-content ${activeTab === "home" ? "active" : "inactive"}`}
                data-tab="home"
              >
                <HomeTab
                  iTwinId={iTwinId}
                  iModelId={iModelId}
                  changesetId={changesetId}
                  authClient={authClient}
                  viewCreatorOptions={viewCreatorOptions}
                  onIModelAppInit={onIModelAppInit}
                />
              </div>
            )}
            
            {visitedTabs.has("dashboard") && (
              <div 
                className={`tab-content ${activeTab === "dashboard" ? "active" : "inactive"}`}
                data-tab="dashboard"
              >
                <DashboardTab />
              </div>
            )}
            
            {visitedTabs.has("forecast") && (
              <div 
                className={`tab-content ${activeTab === "forecast" ? "active" : "inactive"}`}
                data-tab="forecast"
              >
                <ForecastTab />
              </div>
            )}
            
            {visitedTabs.has("tuning") && (
              <div 
                className={`tab-content ${activeTab === "tuning" ? "active" : "inactive"}`}
                data-tab="tuning"
              >
                <TuningTab />
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
};

export default App;
