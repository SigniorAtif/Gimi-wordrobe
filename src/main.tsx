import React from "react";
import ReactDOM from "react-dom/client";
// Base styles first so component stylesheets (imported by App) override them.
import "./styles/global.css";
import "./styles/components.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
