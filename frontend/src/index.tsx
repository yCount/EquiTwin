/*---------------------------------------------------------------------------------------------
 * Copyright (c) Bentley Systems, Incorporated. All rights reserved.
 * See LICENSE.md in the project root for license terms and full copyright notice.
 *--------------------------------------------------------------------------------------------*/

import "./index.scss";

import React from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { Auth } from "./Auth";
import * as serviceWorker from "./serviceWorker";

// Debugging: catch unhandled promise rejections and log them into the debugger
window.addEventListener("unhandledrejection", (event) => {
  try {
    console.groupCollapsed("🔥 UNHANDLED PROMISE REJECTION");
    console.error("event.reason (raw):", event.reason);

    // If it's an Error object, print stack
    if (event.reason && event.reason.stack) {
      console.error("stack:", event.reason.stack);
    }

    // If it's an object, turn it into a string
    try {
      console.log("stringified reason:", JSON.stringify(event.reason, getCircularReplacer(), 2));
    } catch (e) {
      console.log("could not stringify reason:", e);
    }

    // log the full event
    console.log("full event:", event);

    console.groupEnd();
  } catch (e) {
    console.error("error while logging unhandledrejection:", e);
  }

  // Stop here so DevTools will break — useful to inspect call stack & scope.
  debugger;
});

// catch synchronous errors
window.addEventListener("error", (event) => {
  console.error("UNCAUGHT ERROR:", event.error ?? event.message, event);
  debugger;
});

// helper to avoid JSON.stringify circular reference errors
function getCircularReplacer() {
  const seen = new WeakSet();
  return (key: string, value: any) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  };
}

if (!process.env.IMJS_AUTH_CLIENT_CLIENT_ID) {
  throw new Error(
    "Please add a valid OIDC client id to the .env file and restart the application. See the README for more information."
  );
}
if (!process.env.IMJS_AUTH_CLIENT_SCOPES) {
  throw new Error(
    "Please add valid scopes for your OIDC client to the .env file and restart the application. See the README for more information."
  );
}
if (!process.env.IMJS_AUTH_CLIENT_REDIRECT_URI) {
  throw new Error(
    "Please add a valid redirect URI to the .env file and restart the application. See the README for more information."
  );
}

Auth.initialize({
  scope: process.env.IMJS_AUTH_CLIENT_SCOPES,
  clientId: process.env.IMJS_AUTH_CLIENT_CLIENT_ID,
  redirectUri: process.env.IMJS_AUTH_CLIENT_REDIRECT_URI,
  postSignoutRedirectUri: process.env.IMJS_AUTH_CLIENT_LOGOUT_URI,
  responseType: "code",
  authority: process.env.IMJS_AUTH_AUTHORITY,
});

const container = document.getElementById("root");
const root = createRoot(container!);

const redirectUrl = new URL(process.env.IMJS_AUTH_CLIENT_REDIRECT_URI);
if (redirectUrl.pathname === window.location.pathname) {
  Auth.handleSigninCallback().catch(console.error);
} else {
  root.render(<App />);
}

// If you want your app to work offline and load faster, you can change
// unregister() to register() below. Note this comes with some pitfalls.
// Learn more about service workers: https://bit.ly/CRA-PWA
serviceWorker.unregister();
