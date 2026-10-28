import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./style.css";
import "./themes.css";
import "./ui/performance.css";
// Use the inexpensive material for the first frame, before settings arrive.
document.documentElement.dataset.performance = "efficient";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
