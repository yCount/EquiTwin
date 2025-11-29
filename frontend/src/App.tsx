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

  /** NOTE: This function will execute the "Fit View" tool after the iModel is loaded into the Viewer.
   * This will provide an "optimal" view of the model. However, it will override any default views that are
   * stored in the iModel. Delete this function and the prop that it is passed to if you prefer
   * to honor default views when they are present instead (the Viewer will still apply a similar function to iModels that do not have a default view).
   */
  const viewConfiguration = useCallback((viewPort: ScreenViewport) => {
    // default execute the fitview tool and use the iso standard view after tile trees are loaded
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
          // after 20 seconds, stop waiting and fit the view
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
    // iModel now initialized
    await TreeWidget.initialize();
    await PropertyGridManager.initialize();
    await MeasureTools.startup();
    MeasurementActionToolbar.setDefaultActionProvider();
  }, []);

  return (
    <div className="app-root">
      {/* Keep the original "Signing in..." indicator */}
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
          {activeTab === "home" && (
            <HomeTab
              iTwinId={iTwinId}
              iModelId={iModelId}
              changesetId={changesetId}
              authClient={authClient}
              viewCreatorOptions={viewCreatorOptions}
              onIModelAppInit={onIModelAppInit}
            />
          )}

          {activeTab === "dashboard" && <DashboardTab />}

          {activeTab === "forecast" && <ForecastTab />}

          {activeTab === "tuning" && <TuningTab />}
        </main>
      </div>
    </div>
  );
};

export default App;
