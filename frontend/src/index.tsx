import "./index.scss";

import React from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { ThemeProvider } from "./ThemeContext";
import * as serviceWorker from "./serviceWorker";

window.addEventListener("unhandledrejection", (event) => {
  if (!event.reason) { event.preventDefault(); return; }
  console.groupCollapsed("UNHANDLED PROMISE REJECTION");
  console.error("reason:", event.reason);
  if (event.reason?.stack) console.error("stack:", event.reason.stack);
  console.groupEnd();
});

window.addEventListener("error", (event) => {
  console.error("UNCAUGHT ERROR:", event.error ?? event.message);
});

const container = document.getElementById("root");
const root = createRoot(container!);

root.render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);

serviceWorker.unregister();
