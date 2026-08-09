import * as d3 from "d3";
import { COLLECTION_DEFAULTS } from "./heatmapConfig.js";

export * from "./heatmapConfig.js";

export const HEATMAP_COLOR_SCALE_WHITE = d3
  .scaleLinear()
  .domain([0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.65, 0.9])
  .range([
    "rgb(255,255,224)",
    "rgb(253,227,178)",
    "rgb(248,199,135)",
    "rgb(240,146,94)",
    "rgb(230,81,56)",
    "rgb(204,33,46)",
    "rgb(157,32,68)",
    "rgb(32,23,115)",
    "rgb(33,33,33)",
  ])
  .interpolate(d3.interpolateRgb);

// Dark basemap: bas en ardoise bleutée résolu ; haut en blanc cassé / blanc bleuté plutôt
// que jaune, tout en gardant une courte montée corail avant les tons très clairs.
export const HEATMAP_COLOR_SCALE_DARK = d3
  .scaleLinear()
  .clamp(true)
  .domain([0.1, 0.125, 0.15, 0.175, 0.2, 0.225, 0.25, 0.3, 0.35, 0.4, 0.52, 0.68, 0.9])
  .range([
    "rgb(10, 14, 26)",
    "rgb(15, 19, 34)",
    "rgb(21, 25, 44)",
    "rgb(27, 29, 54)",
    "rgb(33, 33, 64)",
    "rgb(38, 36, 74)",
    "rgb(76, 44, 66)",
    "rgb(118, 50, 70)",
    "rgb(142, 54, 74)",
    "rgb(156, 62, 76)",
    "rgb(172, 88, 74)",
    "rgb(208, 188, 186)",
    "rgb(246, 245, 248)",
  ])
  .interpolate(d3.interpolateRgb);

export const DEFAULT_HEATMAP_VISUAL = {
  multiplier: COLLECTION_DEFAULTS.heatmapVisualMultiplier,
  areaMode: COLLECTION_DEFAULTS.heatmapVisualAreaMode,
  centroidSnap: COLLECTION_DEFAULTS.heatmapVisualCentroidSnap,
};
