import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import {
  blackenBackdropSettlementLabels,
  brightenDatavizDarkAdminLabels,
  brightenDatavizDarkSettlementLabels,
  brightenDatavizDarkWaterLabels,
  darkenBackdropMajorRoads,
  darkenDatavizDarkBuildings,
  disableTerrain,
  lightenBackdropBuildings,
  lightenDatavizDarkRoads,
  tuneDatavizDarkBackgroundAndWater,
  whitenBackdropRoadLabels,
} from "@indexus/rendering-map";
import { COLLECTION_DEFAULTS } from "@indexus/rendering-map";
import {
  POINT_LAYER_ID,
  applyHitsOverlay,
  applyPointPaint,
  getColoredPointPaint,
  hitHoverKey,
} from "../lib/pointOverlay.js";
import MapModeSwitch from "./MapModeSwitch.jsx";

/** Same MapTiler basemaps as AggregateHeatmap. */
const MAP_STYLES = {
  dark: {
    url: "https://api.maptiler.com/maps/dataviz-dark/style.json?key=6TL2ju3sEJfZ6Ns5kv7T",
  },
  white: {
    url: "https://api.maptiler.com/maps/backdrop/style.json?key=6TL2ju3sEJfZ6Ns5kv7T",
  },
};

const MAUVE = "#708cd0";
const PAPER = "#f4f2f5";
const DEFAULT_NORMALIZER = COLLECTION_DEFAULTS.normalizer;

function mapStyleMode(theme) {
  return theme === "white" ? "white" : "dark";
}

function hydrateBasemap(map, mode) {
  disableTerrain(map);
  if (mode === "white") {
    lightenBackdropBuildings(map);
    blackenBackdropSettlementLabels(map);
    darkenBackdropMajorRoads(map);
    whitenBackdropRoadLabels(map);
  } else {
    tuneDatavizDarkBackgroundAndWater(map);
    brightenDatavizDarkSettlementLabels(map);
    brightenDatavizDarkAdminLabels(map);
    brightenDatavizDarkWaterLabels(map);
    lightenDatavizDarkRoads(map);
    darkenDatavizDarkBuildings(map);
  }
}

/**
 * Nearby-only map. Same MapTiler style + €/m² point ramp + legend as Aggregate.
 * Fits to points when fitNonce bumps (first query / load-more); then unlocked
 * so the user can pan & zoom freely until the next bump.
 */
export default function MapPanel({
  center,
  origin,
  hits,
  onMapClick,
  onHitFocus,
  active = true,
  fitNonce = 0,
  theme = "dark",
  normalizer = DEFAULT_NORMALIZER,
  hoverHit = null,
  zoom: zoomProp,
  onViewportChange,
  onMode,
  /** Mirror Aggregate: badge/overlay while mesh or bearer is not ready. */
  waiting = false,
  waitingMessage = "waiting for mesh hosts…",
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const themeRef = useRef(theme);
  const loadedModeRef = useRef(null);
  const originMarker = useRef(null);
  const hoverMarker = useRef(null);
  const hitsRef = useRef(hits);
  const originRef = useRef(origin);
  const normalizerRef = useRef(normalizer);
  const hoverKeyRef = useRef(hitHoverKey(hoverHit));
  const fittingRef = useRef(false);
  const onMapClickRef = useRef(onMapClick);
  const onHitFocusRef = useRef(onHitFocus);
  const onViewportChangeRef = useRef(onViewportChange);
  hitsRef.current = hits;
  originRef.current = origin;
  normalizerRef.current = normalizer;
  hoverKeyRef.current = hitHoverKey(hoverHit);
  onMapClickRef.current = onMapClick;
  onHitFocusRef.current = onHitFocus;
  onViewportChangeRef.current = onViewportChange;

  const paintHits = (map, mode) => {
    applyHitsOverlay(
      map,
      hitsRef.current,
      mode,
      normalizerRef.current,
      hoverKeyRef.current,
    );
  };

  const fitToHits = (map) => {
    const list = hitsRef.current || [];
    const org = originRef.current;
    if (!list.length) return;
    const bounds = new maplibregl.LngLatBounds();
    let n = 0;
    if (org?.lat != null && org?.lng != null) {
      bounds.extend([org.lng, org.lat]);
      n++;
    }
    for (const h of list) {
      if (h.lat == null || h.lng == null) continue;
      bounds.extend([h.lng, h.lat]);
      n++;
    }
    if (n < 1) return;
    fittingRef.current = true;
    try {
      map.fitBounds(bounds, { padding: 56, maxZoom: 15, duration: 500 });
    } catch {
      fittingRef.current = false;
      return;
    }
    map.once("moveend", () => {
      fittingRef.current = false;
    });
  };

  useEffect(() => {
    if (!active || mapRef.current || !containerRef.current) return;

    const mode = mapStyleMode(themeRef.current);
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLES[mode].url,
      center: center || [2.3522, 48.8566],
      zoom: Number.isFinite(zoomProp) ? zoomProp : 11,
      projection: "mercator",
    });
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right",
    );

    const emitViewport = () => {
      const cb = onViewportChangeRef.current;
      if (!cb) return;
      const c = map.getCenter();
      cb([c.lng, c.lat], map.getZoom());
    };
    map.on("moveend", emitViewport);

    map.on("click", (e) => {
      const feats = map.queryRenderedFeatures(e.point, {
        layers: map.getLayer(POINT_LAYER_ID) ? [POINT_LAYER_ID] : [],
      });
      if (feats.length) {
        const f = feats[0];
        const p = f.properties || {};
        const [lng, lat] = f.geometry?.coordinates || [
          e.lngLat.lng,
          e.lngLat.lat,
        ];
        onHitFocusRef.current?.({
          id: p.id || "",
          rank: p.rank,
          lat,
          lng,
          value: Number(p.v) || 0,
        });
        return;
      }
      onMapClickRef.current?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });

    map.once("load", () => {
      hydrateBasemap(map, mode);
      loadedModeRef.current = mode;
      paintHits(map, mode);
      map.resize();
      emitViewport();
    });
    mapRef.current = map;

    return () => {
      hoverMarker.current?.remove();
      hoverMarker.current = null;
      originMarker.current?.remove();
      originMarker.current = null;
      map.remove();
      mapRef.current = null;
      loadedModeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    themeRef.current = theme;
    const map = mapRef.current;
    if (!map || !active) return;
    const mode = mapStyleMode(theme);
    if (loadedModeRef.current === mode) return;
    map.setStyle(MAP_STYLES[mode].url);
    map.once("style.load", () => {
      hydrateBasemap(map, mode);
      loadedModeRef.current = mode;
      paintHits(map, mode);
    });
  }, [theme, active]);

  useEffect(() => {
    if (!active || !mapRef.current) return;
    const map = mapRef.current;
    const id = requestAnimationFrame(() => map.resize());
    const t = setTimeout(() => map.resize(), 80);
    return () => {
      cancelAnimationFrame(id);
      clearTimeout(t);
    };
  }, [active]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !origin) return;
    if (!originMarker.current) {
      const el = document.createElement("div");
      el.className = "map-origin";
      el.style.cssText =
        `width:18px;height:18px;border-radius:50%;background:${MAUVE};border:2.5px solid ${PAPER};box-shadow:0 0 0 4px rgba(112,140,208,0.4)`;
      originMarker.current = new maplibregl.Marker({ element: el })
        .setLngLat([origin.lng, origin.lat])
        .addTo(map);
    } else {
      originMarker.current.setLngLat([origin.lng, origin.lat]);
    }
  }, [origin]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const key = hitHoverKey(hoverHit);
    hoverKeyRef.current = key;
    const mode = loadedModeRef.current || mapStyleMode(theme);
    if (map.isStyleLoaded() && map.getLayer(POINT_LAYER_ID)) {
      applyPointPaint(
        map,
        getColoredPointPaint(mode, normalizerRef.current, key),
      );
    }

    if (!hoverHit || hoverHit.lat == null || hoverHit.lng == null) {
      hoverMarker.current?.remove();
      hoverMarker.current = null;
      return;
    }

    const lngLat = [hoverHit.lng, hoverHit.lat];
    if (!hoverMarker.current) {
      const el = document.createElement("div");
      el.className = "map-hit-hl";
      el.setAttribute("aria-hidden", "true");
      hoverMarker.current = new maplibregl.Marker({
        element: el,
        pitchAlignment: "map",
        rotationAlignment: "map",
      })
        .setLngLat(lngLat)
        .addTo(map);
    } else {
      const el = hoverMarker.current.getElement();
      el.classList.remove("map-hit-hl");
      void el.offsetWidth;
      el.classList.add("map-hit-hl");
      hoverMarker.current.setLngLat(lngLat);
    }
  }, [hoverHit, theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const mode = loadedModeRef.current || mapStyleMode(theme);
    if (!map.isStyleLoaded()) {
      map.once("idle", () => paintHits(map, mode));
      return;
    }
    paintHits(map, mode);
  }, [hits, normalizer, theme]);

  useEffect(() => {
    if (!fitNonce) return;
    const map = mapRef.current;
    if (!map) return;
    const run = () => fitToHits(map);
    if (!map.isStyleLoaded()) {
      map.once("idle", run);
      return;
    }
    // Let the circle layer paint before framing
    requestAnimationFrame(run);
  }, [fitNonce]);

  const mode = mapStyleMode(theme);
  return (
    <div className={`map-wrap map-wrap--${mode}`}>
      <div className="map-el" ref={containerRef} />
      <MapModeSwitch
        mode="nearby"
        onMode={onMode}
        detail={waiting ? "waiting" : ""}
      />
      {waiting ? (
        <div className="map-waiting-msg">{waitingMessage}</div>
      ) : null}
      <div
        className="heatmap-legend"
        title={`prix/m² · normalizer ${normalizer}`}
      >
        <span>0</span>
        <div
          className={`heatmap-legend-bar heatmap-legend-bar--${mode}`}
          aria-hidden="true"
        />
        <span>
          {normalizer >= 1000
            ? `${Math.round(normalizer / 1000)}k`
            : normalizer}{" "}
          €/m²
        </span>
      </div>
    </div>
  );
}
