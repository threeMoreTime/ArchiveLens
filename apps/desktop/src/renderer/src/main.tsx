import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { FluentProvider } from "@fluentui/react-components";
import App from "./App";
import { archiveLensTheme } from "./theme";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("找不到 #root 挂载点");
}

createRoot(container).render(
  <React.StrictMode>
    <FluentProvider theme={archiveLensTheme}>
      <HashRouter>
        <App />
      </HashRouter>
    </FluentProvider>
  </React.StrictMode>,
);
