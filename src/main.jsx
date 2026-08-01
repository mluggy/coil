import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Bundle loaded fine — re-arm the reload-once guard (see vite.config.js).
try { sessionStorage.removeItem("assetReload"); } catch { /* private mode */ }

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
