import { Buffer } from "buffer";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import "maplibre-gl/dist/maplibre-gl.css";

if (!globalThis.Buffer) globalThis.Buffer = Buffer;

try {
  const stored = localStorage.getItem("mesh-dash-theme");
  if (stored === "white" || stored === "dark") {
    document.documentElement.setAttribute("data-theme", stored);
  } else {
    document.documentElement.setAttribute("data-theme", "dark");
  }
} catch {
  document.documentElement.setAttribute("data-theme", "dark");
}

createRoot(document.getElementById("root")).render(<App />);

