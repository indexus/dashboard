import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Header from "./components/Header.jsx";
import MapPanel from "./components/MapPanel.jsx";
import AggregateHeatmap from "./components/AggregateHeatmap.jsx";
import { AddItemModal } from "./components/AddItemForm.jsx";
import OpsPanel from "./components/OpsPanel.jsx";
import DataSidePanel, {
  HitsList,
  NearbyControls,
} from "./components/DataSidePanel.jsx";
import NodesList from "./components/NodesList.jsx";
import ClientMetrics from "./components/ClientMetrics.jsx";
import { getHealth, getMesh } from "./lib/api.js";
import { attachNetworkController } from "./lib/networkController.js";
import {
  addGeoItem,
  bootstrapHost,
  COLLECTION_PRESETS,
  DEFAULT_READ_OPTIONS,
  DETAIL_LIMIT,
  ensureToken,
  formatDistanceKm,
  hostsFromMesh,
  SearchSession,
} from "./lib/sdk.js";

function prefersDarkColorScheme() {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return true;
  }
}

function readStoredTheme() {
  try {
    const v = localStorage.getItem("mesh-dash-theme");
    if (v === "white" || v === "dark") return v;
  } catch (_) {}
  return prefersDarkColorScheme() ? "dark" : "white";
}

export default function App() {
  const [tab, setTab] = useState("ops");
  const [mesh, setMesh] = useState(null);
  const [health, setHealth] = useState(null);
  const [pollErr, setPollErr] = useState(null);
  const [theme, setTheme] = useState(readStoredTheme);

  const [collection, setCollection] = useState(COLLECTION_PRESETS[0].id);
  const [mode, setMode] = useState("aggregate");
  const [sideView, setSideView] = useState("controls");
  // Off by default — auto Nearby re-queries pollute network/metrics vs Aggregate.
  const [auto, setAuto] = useState(false);
  const [step, setStep] = useState(10);
  const [normalizer, setNormalizer] = useState(10000);
  /** Shared Nearby + Aggregate `/sets` navigation and batching. */
  const [readNavigation, setReadNavigation] = useState(
    DEFAULT_READ_OPTIONS.navigation,
  );
  const [readMethod, setReadMethod] = useState(DEFAULT_READ_OPTIONS.method);
  const detailLimit = DETAIL_LIMIT;
  const [origin, setOrigin] = useState({ lat: 48.8566, lng: 2.3522 });
  const [itemId, setItemId] = useState("");
  const [hits, setHits] = useState([]);
  const [allHits, setAllHits] = useState([]);
  const [selectedCell, setSelectedCell] = useState(null);
  const [hoveredHit, setHoveredHit] = useState(null);
  const [fitNonce, setFitNonce] = useState(0);
  const [dataStatus, setDataStatus] = useState(
    "aggregate · WebGPU heatmap · pan / zoom",
  );
  const [dataErr, setDataErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [canNext, setCanNext] = useState(false);
  const [bearer, setBearer] = useState(() => globalThis.__INDEXUS_BEARER__ || "");
  const [addOpen, setAddOpen] = useState(false);
  /** Frozen peer list for Data — mesh polls must not remount Aggregate/Nearby. */
  const [dataHosts, setDataHosts] = useState([]);
  const [dataEpoch, setDataEpoch] = useState(0);
  const dataHostsReady = useRef(false);
  const dataHostsRef = useRef([]);

  const sessionRef = useRef(null);
  const cumulativeRef = useRef([]);
  const originKeyRef = useRef("");
  const autoTimerRef = useRef(null);
  const searchGenRef = useRef(0);
  const nearbyNetDisposeRef = useRef(null);
  /** One-shot: run first Nearby Query after picking the mode. */
  const nearbyBootRef = useRef(false);
  const [nearbyController, setNearbyController] = useState(null);
  const [nearbyNodeCount, setNearbyNodeCount] = useState(0);
  const [nearbyMetricsHint, setNearbyMetricsHint] = useState(null);
  /** Last Aggregate / Nearby camera — Refresh remounts without jumping to default. */
  const mapViewportRef = useRef({
    aggregate: { center: [2.3522, 48.8566], zoom: 6 },
    nearby: { center: [2.3522, 48.8566], zoom: 11 },
  });

  const boot = health?.boot || mesh?.boot || null;
  const bootHost = useMemo(
    () => mesh?.bootstrap || bootstrapHost(boot, health?.p2p_port || 21000),
    [mesh?.bootstrap, boot, health?.p2p_port],
  );
  const liveHosts = useMemo(
    () => hostsFromMesh(mesh, bootHost),
    [mesh, bootHost],
  );
  /** Data view uses a snapshot; Ops uses liveHosts via mesh prop. */
  const hosts = dataHosts.length ? dataHosts : liveHosts;

  const tick = useCallback(async () => {
    try {
      const [m, h] = await Promise.all([
        getMesh(),
        getHealth().catch(() => null),
      ]);
      setMesh(m);
      if (h) setHealth(h);
      setPollErr(m?.error || null);
      const nextBoot =
        h?.boot ||
        m?.boot ||
        null;
      const nextHost =
        m?.bootstrap ||
        bootstrapHost(nextBoot, h?.p2p_port || 21000);
      const nextHosts = hostsFromMesh(m, nextHost);
      if (!dataHostsReady.current && nextHosts.length) {
        dataHostsReady.current = true;
        dataHostsRef.current = nextHosts;
        setDataHosts(nextHosts);
      } else if (dataHostsReady.current && nextHosts.length) {
        // Remesh / restart: frozen peers no longer exist — adopt live set.
        const live = new Set(nextHosts);
        const stale = dataHostsRef.current.every((h) => !live.has(h));
        if (stale) {
          dataHostsRef.current = nextHosts;
          setDataHosts(nextHosts);
          sessionRef.current = null;
        }
      }
    } catch (e) {
      setPollErr(e.message);
    }
  }, []);

  // Keep mesh fresh on both tabs — Ops every 3s, Data every 5s (nodes looked
  // stale when Data only polled health).
  useEffect(() => {
    tick();
    const ms = tab === "ops" ? 3000 : 5000;
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  }, [tick, tab]);

  const onAggregateViewport = useCallback((center, zoom) => {
    if (!Array.isArray(center) || center.length < 2) return;
    if (!Number.isFinite(zoom)) return;
    mapViewportRef.current.aggregate = {
      center: [center[0], center[1]],
      zoom,
    };
  }, []);

  const onNearbyViewport = useCallback((center, zoom) => {
    if (!Array.isArray(center) || center.length < 2) return;
    if (!Number.isFinite(zoom)) return;
    mapViewportRef.current.nearby = {
      center: [center[0], center[1]],
      zoom,
    };
  }, []);

  const readOptions = useMemo(
    () => ({
      navigation: readNavigation,
      method: readMethod,
      refreshTtlMs: DEFAULT_READ_OPTIONS.refreshTtlMs,
    }),
    [readNavigation, readMethod],
  );

  const onReadNavigation = useCallback((value) => {
    setReadNavigation(value === "direct" ? "direct" : "ingress");
    sessionRef.current = null;
    cumulativeRef.current = [];
    setHits([]);
    setAllHits([]);
    setCanNext(false);
    setDataEpoch((e) => e + 1);
  }, []);

  const onReadMethod = useCallback((value) => {
    setReadMethod(value === "getSet" ? "getSet" : "getSets");
    sessionRef.current = null;
    cumulativeRef.current = [];
    setHits([]);
    setAllHits([]);
    setCanNext(false);
    setDataEpoch((e) => e + 1);
  }, []);

  const resetData = useCallback(async () => {
    setBusy(true);
    setDataErr(false);
    setDataStatus("reset · refreshing peers…");
    try {
      const [m, h] = await Promise.all([
        getMesh(),
        getHealth().catch(() => null),
      ]);
      setMesh(m);
      if (h) setHealth(h);
      const nextBoot = h?.boot || m?.boot || null;
      const nextHost =
        m?.bootstrap || bootstrapHost(nextBoot, h?.p2p_port || 21000);
      const nextHosts = hostsFromMesh(m, nextHost);
      dataHostsReady.current = nextHosts.length > 0;
      dataHostsRef.current = nextHosts;
      setDataHosts(nextHosts);
      sessionRef.current = null;
      cumulativeRef.current = [];
      setHits([]);
      setAllHits([]);
      setCanNext(false);
      setSelectedCell(null);
      setDataEpoch((e) => e + 1);
      setDataStatus(
        nextHosts.length
          ? `reset · ${nextHosts.length} peer(s)`
          : "reset · no peers yet",
      );
    } catch (e) {
      setDataErr(true);
      setDataStatus(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    ensureToken()
      .then((tok) => {
        if (!cancelled) setBearer(tok);
      })
      .catch((e) => {
        if (!cancelled) {
          setDataErr(true);
          setDataStatus(e.message || String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const key = `${collection}|${origin.lat.toFixed(6)}|${origin.lng.toFixed(6)}`;
    if (key === originKeyRef.current && sessionRef.current) return;
    originKeyRef.current = key;
    sessionRef.current = null;
    cumulativeRef.current = [];
    setCanNext(false);
    if (mode === "nearby") {
      setHits([]);
      setAllHits([]);
    }
  }, [collection, origin.lat, origin.lng, mode]);

  // Eager Nearby Network so Nodes / Metrics match Aggregate before first Query.
  useEffect(() => {
    if (mode !== "nearby" || !hosts.length || tab !== "data") {
      nearbyNetDisposeRef.current?.();
      nearbyNetDisposeRef.current = null;
      setNearbyController(null);
      setNearbyNodeCount(0);
      setNearbyMetricsHint(null);
      return undefined;
    }

    let cancelled = false;

    (async () => {
      try {
        if (!sessionRef.current) {
          sessionRef.current = new SearchSession({
            collectionName: collection,
            hosts,
            lat: origin.lat,
            lng: origin.lng,
            step,
            readOptions,
          });
        }
        await sessionRef.current.ensure();
        if (cancelled) return;
        const net = sessionRef.current.network;
        if (!net) return;
        nearbyNetDisposeRef.current?.();
        const ctrl = attachNetworkController(net);
        nearbyNetDisposeRef.current = () => ctrl.dispose();
        setNearbyController(ctrl);
      } catch (e) {
        if (cancelled) return;
        setNearbyController(null);
        setNearbyNodeCount(0);
        setNearbyMetricsHint(null);
        setDataErr(true);
        setDataStatus(e.message || String(e));
      }
    })();

    return () => {
      cancelled = true;
      nearbyNetDisposeRef.current?.();
      nearbyNetDisposeRef.current = null;
    };
  }, [
    mode,
    tab,
    hosts,
    collection,
    origin.lat,
    origin.lng,
    readOptions,
    dataEpoch,
  ]);

  useEffect(() => {
    if (!nearbyController?.subscribeNetwork) return undefined;
    return nearbyController.subscribeNetwork((snap) => {
      setNearbyNodeCount(Array.isArray(snap?.peers) ? snap.peers.length : 0);
      const cached = snap?.metrics?.cacheSize;
      setNearbyMetricsHint(
        Number.isFinite(cached) && cached > 0 ? String(cached) : null,
      );
    });
  }, [nearbyController]);

  const onAggStatus = useCallback((msg) => {
    setDataStatus(msg);
    setDataErr(false);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("mesh-dash-theme", theme);
    } catch (_) {}
  }, [theme]);

  const runSearch = useCallback(
    async (next) => {
      if (!hosts.length) {
        setDataErr(true);
        setDataStatus("no mesh hosts — wait for Ops nodes or set BOOT_IP");
        return;
      }
      const gen = ++searchGenRef.current;
      setBusy(true);
      setDataErr(false);
      setDataStatus(
        next
          ? `next ${step} via ${hosts.length} host(s)…`
          : `query ${step} nearest via ${hosts.length} host(s)…`,
      );
      try {
        if (!sessionRef.current) {
          sessionRef.current = new SearchSession({
            collectionName: collection,
            hosts,
            lat: origin.lat,
            lng: origin.lng,
            step,
            readOptions,
          });
        }
        if (!next) cumulativeRef.current = [];
        const { items, peers } = await sessionRef.current.search(step, {
          fresh: !next,
        });
        if (gen !== searchGenRef.current) return;
        setCanNext(items.length > 0);
        const ranked = items.map((it, i) => ({
          ...it,
          rank: cumulativeRef.current.length + i + 1,
        }));
        cumulativeRef.current = [...cumulativeRef.current, ...ranked];
        setHits(ranked);
        setAllHits([...cumulativeRef.current]);
        if (ranked.length) setFitNonce((n) => n + 1);
        setDataStatus(
          ranked.length
            ? `got ${ranked.length} · total ${cumulativeRef.current.length} · peers ${peers}`
            : "no more results",
        );
        if (!ranked.length) setCanNext(false);
      } catch (e) {
        if (gen !== searchGenRef.current) return;
        setDataErr(true);
        setDataStatus(e.message || String(e));
        if (!next) {
          sessionRef.current = null;
          nearbyNetDisposeRef.current?.();
          nearbyNetDisposeRef.current = null;
          setNearbyController(null);
        }
      } finally {
        if (gen === searchGenRef.current) setBusy(false);
      }
    },
    [hosts, collection, origin.lat, origin.lng, step, readOptions],
  );

  const loadNextHits = useCallback(() => {
    if (busy || !canNext) return;
    runSearch(true);
  }, [busy, canNext, runSearch]);

  useEffect(() => {
    if (!auto || mode !== "nearby" || !hosts.length || tab !== "data") return;
    if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
    autoTimerRef.current = setTimeout(() => {
      runSearch(false);
    }, 450);
    return () => {
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
    };
  }, [
    auto,
    mode,
    hosts,
    collection,
    origin.lat,
    origin.lng,
    step,
    tab,
    runSearch,
  ]);

  // First Nearby round as soon as the mode is picked (hosts + Data tab ready).
  useEffect(() => {
    if (!nearbyBootRef.current) return;
    if (mode !== "nearby" || tab !== "data" || !hosts.length) return;
    nearbyBootRef.current = false;
    if (auto) return; // auto effect already queries on entry
    const t = setTimeout(() => {
      runSearch(false);
    }, 50);
    return () => clearTimeout(t);
  }, [mode, tab, hosts, auto, runSearch]);

  async function onAdd() {
    if (!hosts.length) {
      setDataErr(true);
      setDataStatus("no mesh hosts");
      return;
    }
    setBusy(true);
    setDataErr(false);
    setDataStatus("adding…");
    try {
      const out = await addGeoItem({
        collectionName: collection,
        hosts,
        lat: origin.lat,
        lng: origin.lng,
        id: itemId.trim() || undefined,
      });
      setItemId("");
      setAddOpen(false);
      setDataStatus(`added ${out.id} · peers ${out.peers}`);
      sessionRef.current = null;
      cumulativeRef.current = [];
      setCanNext(false);
      if (mode === "nearby" && auto) runSearch(false);
    } catch (e) {
      setDataErr(true);
      setDataStatus(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  function onMapClick({ lat, lng }) {
    setOrigin({ lat, lng });
    setDataStatus(`origin ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
    setDataErr(false);
  }

  function onHitFocus(h) {
    if (h?.lat == null || h?.lng == null) return;
    setSelectedCell(h);
    setDataStatus(
      `#${h.rank ?? ""} ${h.id || h.kind || "cell"}` +
        (h.distance != null
          ? ` · ${formatDistanceKm(h.distance) || ""}`
          : h.value != null
            ? ` · v=${Number(h.value).toFixed(2)}`
            : "") +
        ` · ${h.lat.toFixed(4)}, ${h.lng.toFixed(4)}`,
    );
  }

  function onMode(next) {
    setMode(next);
    setHits([]);
    setAllHits([]);
    setCanNext(false);
    sessionRef.current = null;
    cumulativeRef.current = [];
    setSelectedCell(null);
    setHoveredHit(null);
    setSideView(next === "nearby" ? "items" : "controls");
    nearbyBootRef.current = next === "nearby";
    setDataStatus(
      next === "nearby"
        ? auto
          ? "auto nearby · querying…"
          : "nearby · querying…"
        : "aggregate · WebGPU heatmap · pan / zoom",
    );
  }

  const displayHits = allHits.length ? allHits : hits;

  const peerHint = hosts.length
    ? `${hosts.length} peer(s)${mode === "nearby" && auto ? " · auto" : ""}`
    : "waiting for mesh…";

  return (
    <div className={`app theme-${theme}`}>
      <Header
        error={pollErr}
        theme={theme}
        onTheme={setTheme}
        tab={tab}
        onTab={setTab}
        collection={collection}
        onCollection={setCollection}
        mode={mode}
        onMode={onMode}
        readNavigation={readNavigation}
        onReadNavigation={onReadNavigation}
        readMethod={readMethod}
        onReadMethod={onReadMethod}
        peerHint={peerHint}
        onReset={resetData}
        busy={busy}
      />

      {pollErr && <div className="err-banner">{pollErr}</div>}

      <div
        className={tab === "ops" ? "tab-panel" : "tab-panel hidden"}
        hidden={tab !== "ops"}
      >
        <OpsPanel mesh={mesh} onSelectCollection={setCollection} />
      </div>

      <div
        className={tab === "data" ? "tab-panel" : "tab-panel hidden"}
        hidden={tab !== "data"}
      >
        <section className="data-section">
          <div className="data-layout">
            {mode === "aggregate" ? (
              <AggregateHeatmap
                key={`agg-${dataEpoch}-${collection}-${readNavigation}-${readMethod}`}
                collection={collection}
                hosts={hosts}
                bearer={bearer}
                detailLimit={detailLimit}
                center={mapViewportRef.current.aggregate.center}
                zoom={mapViewportRef.current.aggregate.zoom}
                theme={theme}
                onStatus={onAggStatus}
                onAddClick={() => setAddOpen(true)}
                sideView={sideView}
                onSideView={setSideView}
                onViewportChange={onAggregateViewport}
                readOptions={readOptions}
              />
            ) : (
              <>
                <MapPanel
                  key={`near-${dataEpoch}`}
                  center={mapViewportRef.current.nearby.center}
                  zoom={mapViewportRef.current.nearby.zoom}
                  origin={origin}
                  hits={displayHits}
                  onMapClick={onMapClick}
                  onHitFocus={onHitFocus}
                  active={tab === "data"}
                  fitNonce={fitNonce}
                  theme={theme}
                  normalizer={normalizer}
                  hoverHit={hoveredHit}
                  onViewportChange={onNearbyViewport}
                />
                <DataSidePanel
                  view={sideView}
                  onView={setSideView}
                  onAddClick={() => setAddOpen(true)}
                  itemCount={displayHits.length}
                  nodeCount={nearbyNodeCount}
                  metricsHint={nearbyMetricsHint}
                  controls={
                    <NearbyControls
                      origin={origin}
                      step={step}
                      onStep={setStep}
                      normalizer={normalizer}
                      onNormalizer={setNormalizer}
                      auto={auto}
                      onAuto={setAuto}
                      onQuery={() => runSearch(false)}
                      onNext={loadNextHits}
                      canNext={canNext}
                      busy={busy}
                    />
                  }
                  items={
                    <HitsList
                      hits={displayHits}
                      selected={selectedCell}
                      onFocus={onHitFocus}
                      onHover={setHoveredHit}
                      empty={auto ? "auto-querying…" : "click map, then Query / Next"}
                      onLoadMore={loadNextHits}
                      hasMore={canNext}
                      loadingMore={busy}
                    />
                  }
                  nodes={<NodesList controller={nearbyController} />}
                  metrics={<ClientMetrics controller={nearbyController} />}
                />
              </>
            )}
          </div>

          <AddItemModal
            open={addOpen}
            onClose={() => setAddOpen(false)}
            lat={origin.lat}
            lng={origin.lng}
            id={itemId}
            onLat={(v) =>
              setOrigin((o) => ({ ...o, lat: Number.isFinite(v) ? v : o.lat }))
            }
            onLng={(v) =>
              setOrigin((o) => ({ ...o, lng: Number.isFinite(v) ? v : o.lng }))
            }
            onId={setItemId}
            onAdd={onAdd}
            busy={busy}
          />
          <div className={`status-line${dataErr ? " err" : ""}`}>{dataStatus}</div>
        </section>
      </div>

      <footer className="app-foot">
        {tab === "ops"
          ? "ops · mesh · spawn · snapshots · data load"
          : mode === "nearby"
            ? "nearby · Local.search · auto query / Next N"
            : "aggregate · €/m² · WebGPU"}
      </footer>
    </div>
  );
}
