// MapLibre style helpers used during map setup.
//
// Why this exists: the MapTiler "backdrop" style auto-enables terrain on
// MapLibre v5+, which switches the renderer to a 3D draped pipeline that
// silently breaks 2d custom layers using the WebGPU texture-handoff
// pattern. We have to opt out explicitly *and* tear down the dependent
// hillshade layers + raster-DEM sources, otherwise MapLibre keeps loading
// DEM tiles in the background and re-applies terrain on style mutations.

// Disable terrain rendering on `map` and remove every hillshade layer +
// raster-DEM source declared by the active style. Each step is wrapped in
// its own try/catch so a partial style — e.g. a layer that's already been
// removed, or a source another layer still references — never aborts the
// rest of the cleanup.
export function disableTerrain(map) {
  try {
    map.setTerrain(null);
  } catch (_) {}

  let style;
  try {
    style = map.getStyle?.();
  } catch (_) {
    return;
  }
  if (!style) return;

  const layers = style.layers || [];
  for (const layer of layers) {
    if (layer && layer.type === "hillshade") {
      try {
        map.removeLayer(layer.id);
      } catch (_) {}
    }
  }

  const sources = style.sources || {};
  for (const [id, src] of Object.entries(sources)) {
    if (src && (src.type === "raster-dem" || src.type === "dem")) {
      try {
        map.removeSource(id);
      } catch (_) {
        // Some other layer still references this source; harmless.
      }
    }
  }
}

// First id from `candidates` that exists as a layer in `map`, or null.
// Used to insert a custom layer just before the basemap's water/labels so
// they composite on top of the heatmap.
export function findFirstExistingLayerId(map, candidates) {
  if (!map || typeof map.getLayer !== "function") return null;
  for (const id of candidates) {
    try {
      if (map.getLayer(id)) return id;
    } catch (_) {}
  }
  return null;
}

// Settlement labels (villes): white type + fine black outline for contrast on any land tint.
const CITY_PLACE_LABEL_LAYER_IDS = [
  "City labels",
  "Town labels",
  "Village labels",
  "Place labels",
];
const CITY_LABEL_TEXT_WHITE = "#ffffff";
const CITY_LABEL_HALO_BLACK = "#000000";
/** Halo stroke width in px — kept low for a thin crisp rim (blur stays 0). */
const CITY_LABEL_HALO_WIDTH = 1;
const CITY_LABEL_HALO_BLUR = 0;

export function brightenDatavizDarkSettlementLabels(map) {
  if (!map || typeof map.getLayer !== "function") return;
  for (const id of CITY_PLACE_LABEL_LAYER_IDS) {
    try {
      if (!map.getLayer(id)) continue;
      map.setPaintProperty(id, "text-color", CITY_LABEL_TEXT_WHITE);
      map.setPaintProperty(id, "text-halo-color", CITY_LABEL_HALO_BLACK);
      map.setPaintProperty(id, "text-halo-width", CITY_LABEL_HALO_WIDTH);
      map.setPaintProperty(id, "text-halo-blur", CITY_LABEL_HALO_BLUR);
    } catch (_) {}
  }
}

// MapTiler "dataviz-dark": lift road contrast a bit further + cool neutral that
// separates from land; road names match cities (white + black rim).
const DATAVIZ_DARK_ROAD_LINE_OVERRIDES = [
  ["Road network", "hsl(218, 14%, 66%)"],
  ["Road network outline", "hsl(218, 16%, 44%)"],
  ["Tunnel outline", "hsl(218, 12%, 42%)"],
  ["Tunnel", "hsl(218, 11%, 58%)"],
  ["Tunnel path", "hsl(218, 12%, 62%)"],
  ["Pier road", "hsl(218, 11%, 60%)"],
  ["Path", "hsl(218, 10%, 58%)"],
  ["Path minor", "hsl(218, 9%, 56%)"],
  ["Path outline", "hsl(218, 10%, 50%)"],
  ["Aeroway", "hsl(218, 10%, 60%)"],
  ["Railway", "hsl(218, 8%, 52%)"],
  ["Railway dash", "hsl(218, 9%, 60%)"],
  ["Railway tunnel", "hsl(218, 7%, 48%)"],
  ["Railway tunnel dash", "hsl(218, 8%, 56%)"],
];

export function lightenDatavizDarkRoads(map) {
  if (!map || typeof map.getLayer !== "function") return;
  for (const [id, color] of DATAVIZ_DARK_ROAD_LINE_OVERRIDES) {
    try {
      if (!map.getLayer(id)) continue;
      map.setPaintProperty(id, "line-color", color);
    } catch (_) {}
  }
  try {
    if (map.getLayer("Road labels")) {
      map.setPaintProperty("Road labels", "text-color", CITY_LABEL_TEXT_WHITE);
      map.setPaintProperty("Road labels", "text-halo-color", CITY_LABEL_HALO_BLACK);
      map.setPaintProperty("Road labels", "text-halo-width", CITY_LABEL_HALO_WIDTH);
      map.setPaintProperty("Road labels", "text-halo-blur", CITY_LABEL_HALO_BLUR);
    }
  } catch (_) {}
}

/** Eau en bleu‑gris plus clair et désaturé (cohérent avec le fond terrestre bleuté). */
const DATAVIZ_DARK_BG = "hsl(222, 14%, 13%)";
const DATAVIZ_DARK_WATER_FILL = "hsl(218, 10%, 27%)";
const DATAVIZ_DARK_WATER_SHADOW = "hsl(219, 10%, 11%)";
const DATAVIZ_DARK_RIVER_LINE = "hsl(217, 8%, 42%)";

/** Couleur du fond carte + masses d'eau. */
export function tuneDatavizDarkBackgroundAndWater(map) {
  if (!map || typeof map.getLayer !== "function") return;
  try {
    if (map.getLayer("Background")) {
      map.setPaintProperty("Background", "background-color", DATAVIZ_DARK_BG);
    }
  } catch (_) {}
  try {
    if (map.getLayer("Water")) {
      map.setPaintProperty("Water", "fill-color", DATAVIZ_DARK_WATER_FILL);
    }
  } catch (_) {}
  try {
    if (map.getLayer("Water shadow")) {
      map.setPaintProperty("Water shadow", "fill-color", DATAVIZ_DARK_WATER_SHADOW);
    }
  } catch (_) {}
  try {
    if (map.getLayer("River")) {
      map.setPaintProperty("River", "line-color", DATAVIZ_DARK_RIVER_LINE);
    }
  } catch (_) {}
}

const DATAVIZ_DARK_ADMIN_LABEL_IDS = ["Country labels", "State labels", "Continent labels"];

export function brightenDatavizDarkAdminLabels(map) {
  if (!map || typeof map.getLayer !== "function") return;
  for (const id of DATAVIZ_DARK_ADMIN_LABEL_IDS) {
    try {
      if (!map.getLayer(id)) continue;
      map.setPaintProperty(id, "text-color", CITY_LABEL_TEXT_WHITE);
      map.setPaintProperty(id, "text-halo-color", CITY_LABEL_HALO_BLACK);
      map.setPaintProperty(id, "text-halo-width", CITY_LABEL_HALO_WIDTH);
      map.setPaintProperty(id, "text-halo-blur", CITY_LABEL_HALO_BLUR);
    } catch (_) {}
  }
}

const DATAVIZ_DARK_WATER_LABEL_IDS = ["Ocean labels", "Sea labels", "Lakeline labels"];
const WATER_LABEL_TEXT = "hsl(218, 12%, 76%)";
const WATER_LABEL_HALO = "hsl(219, 10%, 14%)";

export function brightenDatavizDarkWaterLabels(map) {
  if (!map || typeof map.getLayer !== "function") return;
  for (const id of DATAVIZ_DARK_WATER_LABEL_IDS) {
    try {
      if (!map.getLayer(id)) continue;
      map.setPaintProperty(id, "text-color", WATER_LABEL_TEXT);
      map.setPaintProperty(id, "text-halo-color", WATER_LABEL_HALO);
      map.setPaintProperty(id, "text-halo-width", CITY_LABEL_HALO_WIDTH);
      map.setPaintProperty(id, "text-halo-blur", CITY_LABEL_HALO_BLUR);
    } catch (_) {}
  }
}

// Dark footprints: stay below landuse/light roads after road brightening.
const DATAVIZ_DARK_BUILDING_FILL = [
  "interpolate",
  ["linear"],
  ["zoom"],
  13,
  "hsl(220, 5%, 9%)",
  16,
  "hsl(220, 4%, 8%)",
];
const DATAVIZ_DARK_BUILDING_TOP_FILL = "hsl(220, 4%, 9%)";
const DATAVIZ_DARK_BUILDING_TOP_OUTLINE = [
  "interpolate",
  ["linear"],
  ["zoom"],
  12,
  "hsl(220, 6%, 8%)",
  14,
  "hsl(220, 5%, 8%)",
  18,
  "hsl(220, 5%, 7%)",
];

export function darkenDatavizDarkBuildings(map) {
  if (!map || typeof map.getLayer !== "function") return;
  try {
    if (map.getLayer("Building")) {
      map.setPaintProperty("Building", "fill-color", DATAVIZ_DARK_BUILDING_FILL);
    }
  } catch (_) {}
  try {
    if (map.getLayer("Building top")) {
      map.setPaintProperty("Building top", "fill-color", DATAVIZ_DARK_BUILDING_TOP_FILL);
      map.setPaintProperty("Building top", "fill-outline-color", DATAVIZ_DARK_BUILDING_TOP_OUTLINE);
    }
  } catch (_) {}
}

// MapTiler "backdrop" (light basemap) ramps building fills toward black at high zoom.
// Ease to softer grays so façades stay clearly "light mode".
const LIGHT_BACKDROP_BUILDING_FILL = [
  "interpolate",
  ["linear"],
  ["zoom"],
  13,
  "hsl(0, 0%, 93%)",
  15,
  "hsl(0, 0%, 88%)",
  18,
  "hsl(0, 0%, 80%)",
];
const LIGHT_BACKDROP_BUILDING_TOP_FILL = [
  "interpolate",
  ["linear"],
  ["zoom"],
  13,
  "hsl(220, 5%, 94%)",
  15,
  "hsl(220, 4%, 90%)",
  18,
  "hsl(220, 3%, 84%)",
];
const LIGHT_BACKDROP_BUILDING_TOP_OUTLINE = "hsl(220, 4%, 72%)";

export function lightenBackdropBuildings(map) {
  if (!map || typeof map.getLayer !== "function") return;
  try {
    if (map.getLayer("Building")) {
      map.setPaintProperty("Building", "fill-color", LIGHT_BACKDROP_BUILDING_FILL);
    }
  } catch (_) {}
  try {
    if (map.getLayer("Building top")) {
      map.setPaintProperty("Building top", "fill-color", LIGHT_BACKDROP_BUILDING_TOP_FILL);
      map.setPaintProperty(
        "Building top",
        "fill-outline-color",
        LIGHT_BACKDROP_BUILDING_TOP_OUTLINE
      );
    }
  } catch (_) {}
}

// Light basemap: villes en blanc + bordure noire fine (lisibles sur routes / fond clair).
// Pays / régions restent en noir sans halo pour ne pas « buller » sur les grandes étiquettes.
const LIGHT_BACKDROP_COUNTRY_STYLE_LAYER_IDS = [
  "Country labels",
  "State labels",
  "Continent labels",
];
const LIGHT_BACKDROP_ADMIN_LABEL_TEXT = "hsl(0, 0%, 8%)";

export function blackenBackdropSettlementLabels(map) {
  if (!map || typeof map.getLayer !== "function") return;
  for (const id of CITY_PLACE_LABEL_LAYER_IDS) {
    try {
      if (!map.getLayer(id)) continue;
      map.setPaintProperty(id, "text-color", CITY_LABEL_TEXT_WHITE);
      map.setPaintProperty(id, "text-halo-color", CITY_LABEL_HALO_BLACK);
      map.setPaintProperty(id, "text-halo-width", CITY_LABEL_HALO_WIDTH);
      map.setPaintProperty(id, "text-halo-blur", CITY_LABEL_HALO_BLUR);
    } catch (_) {}
  }
  for (const id of LIGHT_BACKDROP_COUNTRY_STYLE_LAYER_IDS) {
    try {
      if (!map.getLayer(id)) continue;
      map.setPaintProperty(id, "text-color", LIGHT_BACKDROP_ADMIN_LABEL_TEXT);
      map.setPaintProperty(id, "text-halo-width", 0);
      map.setPaintProperty(id, "text-halo-blur", 0);
      map.setPaintProperty(id, "text-halo-color", "rgba(0, 0, 0, 0)");
    } catch (_) {}
  }
}

// Main road strokes default to ~90% gray — same as residential landuse; darken so
// the street grid stays legible when the heatmap layer is hidden.
const LIGHT_BACKDROP_ROAD_LINE_OVERRIDES = [
  ["Road network", "hsl(222, 9%, 45%)"],
  ["Road network outline", "hsl(222, 7%, 33%)"],
  ["Tunnel", "hsl(222, 5%, 54%)"],
  ["Pier road", "hsl(222, 6%, 46%)"],
];

export function darkenBackdropMajorRoads(map) {
  if (!map || typeof map.getLayer !== "function") return;
  for (const [id, color] of LIGHT_BACKDROP_ROAD_LINE_OVERRIDES) {
    try {
      if (!map.getLayer(id)) continue;
      map.setPaintProperty(id, "line-color", color);
    } catch (_) {}
  }
}

// With darker road casings in light mode, draw street names in white + dark halo
// so they stay legible on both gray pavement and pale landuse.
const LIGHT_BACKDROP_ROAD_LABEL_IDS = ["Road labels"];

export function whitenBackdropRoadLabels(map) {
  if (!map || typeof map.getLayer !== "function") return;
  for (const id of LIGHT_BACKDROP_ROAD_LABEL_IDS) {
    try {
      if (!map.getLayer(id)) continue;
      map.setPaintProperty(id, "text-color", "hsl(0, 0%, 100%)");
      map.setPaintProperty(id, "text-halo-color", "hsl(222, 14%, 16%)");
      map.setPaintProperty(id, "text-halo-width", 0.85);
      map.setPaintProperty(id, "text-halo-blur", 0.25);
    } catch (_) {}
  }
}
