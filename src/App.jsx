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
import {
  CollectionCreateModal,
  NetworkCreateModal,
} from "./components/ResourceModals.jsx";
import {
  createCollection,
  createNetwork,
  deleteCollection,
  getCollections,
  getHealth,
  getMesh,
  getNetworks,
  networkLifecycle,
  selectNetwork,
} from "./lib/api.js";
import { bootLog } from "./lib/bootLog.js";
import { clearSeedPeers } from "./lib/indexus/peerStore.js";
import {
  addGeoItem,
  bootstrapHost,
  COLLECTION_PRESETS,
  DEFAULT_READ_OPTIONS,
  DETAIL_LIMIT,
  ensureToken,
  formatDistanceKm,
  hostsFromMesh,
  resetToken,
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
  const [tab, setTab] = useState("network");
  const [mesh, setMesh] = useState(null);
  const [health, setHealth] = useState(null);
  const [networks, setNetworks] = useState([]);
  const [activeNetworkId, setActiveNetworkId] = useState("");
  const [collections, setCollections] = useState([]);
  const [pollErr, setPollErr] = useState(null);
  const [theme, setTheme] = useState(readStoredTheme);

  const [collection, setCollection] = useState(COLLECTION_PRESETS[0].id);
  const [mode, setMode] = useState("aggregate");
  const [sideView, setSideView] = useState("controls");
  const [sideCollapsed, setSideCollapsed] = useState(false);
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
  const [networkCreateOpen, setNetworkCreateOpen] = useState(false);
  const [collectionCreateOpen, setCollectionCreateOpen] = useState(false);
  const [resourceBusy, setResourceBusy] = useState(false);
  const [resourceError, setResourceError] = useState("");
  const [networkActionBusy, setNetworkActionBusy] = useState(false);
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
  /** Aggregate worker API for Clear cache (no remount). */
  const aggregateCacheApiRef = useRef(null);
  const activeNetworkRef = useRef("");

  const adoptNetworkClient = useCallback((networkId) => {
    if (!networkId || activeNetworkRef.current === networkId) return;
    const previous = activeNetworkRef.current;
    if (previous) clearSeedPeers(previous);
    activeNetworkRef.current = networkId;
    setActiveNetworkId(networkId);
    resetToken(networkId);
    dataHostsReady.current = false;
    dataHostsRef.current = [];
    setDataHosts([]);
    sessionRef.current = null;
    cumulativeRef.current = [];
    setHits([]);
    setAllHits([]);
    setCanNext(false);
    setSelectedCell(null);
    nearbyNetDisposeRef.current?.();
    nearbyNetDisposeRef.current = null;
    setNearbyController(null);
    setDataEpoch((epoch) => epoch + 1);
  }, []);

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
      const [m, h, registry, collectionList] = await Promise.all([
        getMesh(),
        getHealth().catch(() => null),
        getNetworks(),
        getCollections().catch(() => ({ collections: [] })),
      ]);
      if (registry?.active) adoptNetworkClient(registry.active);
      setNetworks(registry?.networks || []);
      setCollections(collectionList?.collections || []);
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
        bootLog("dataHosts.freeze", {
          count: nextHosts.length,
          hosts: nextHosts,
          answering: m?.totals?.answering ?? null,
        });
      } else if (dataHostsReady.current && nextHosts.length) {
        const live = new Set(nextHosts);
        const frozen = dataHostsRef.current;
        // Remesh / restart: every frozen host is gone — hard remount.
        const stale = frozen.length > 0 && frozen.every((h) => !live.has(h));
        // First mesh poll often only has bootstrap; later polls grow. Adopt
        // the richer set so Aggregate/Nearby bootstrap from a full table
        // (discovery alone is not enough when the first drill soft-missed).
        const grew = nextHosts.some((h) => !frozen.includes(h));
        if (stale || grew) {
          bootLog(stale ? "dataHosts.stale-remount" : "dataHosts.grow", {
            from: frozen.length,
            to: nextHosts.length,
            added: nextHosts.filter((h) => !frozen.includes(h)),
            hosts: nextHosts,
          });
          dataHostsRef.current = nextHosts;
          setDataHosts(nextHosts);
          sessionRef.current = null;
          if (stale) setDataEpoch((epoch) => epoch + 1);
        }
      } else if (!nextHosts.length) {
        bootLog("dataHosts.empty-mesh-poll", {
          ready: dataHostsReady.current,
          frozen: dataHostsRef.current.length,
          meshError: m?.error || null,
        });
      }
    } catch (e) {
      setPollErr(e.message);
    }
  }, [adoptNetworkClient]);

  // Keep mesh fresh on both tabs — Ops every 3s, Data every 5s (nodes looked
  // stale when Data only polled health).
  useEffect(() => {
    tick();
    const ms = tab === "network" ? 3000 : 5000;
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
      // Drop the persisted peer trace so Aggregate/Nearby remount cold —
      // otherwise seedPeers resurrect terminated EC2s as ghost nodes.
      const networkId = activeNetworkId || activeNetworkRef.current || "";
      clearSeedPeers(networkId);
      nearbyNetDisposeRef.current?.();
      nearbyNetDisposeRef.current = null;
      setNearbyController(null);
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
      bootLog("refresh.click", {
        networkId,
        hosts: nextHosts,
        answering: m?.totals?.answering ?? null,
      });
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
  }, [activeNetworkId]);

  const refreshNetworkContext = useCallback(async () => {
    const [registry, collectionList] = await Promise.all([
      getNetworks(),
      getCollections().catch(() => ({ collections: [] })),
    ]);
    setNetworks(registry?.networks || []);
    setCollections(collectionList?.collections || []);
    if (registry?.active) adoptNetworkClient(registry.active);
    return registry;
  }, [adoptNetworkClient]);

  const handleSelectNetwork = useCallback(
    async (networkId) => {
      if (!networkId || networkId === activeNetworkRef.current) return;
      await selectNetwork(networkId);
      adoptNetworkClient(networkId);
      setBearer("");
      await Promise.all([
        resetData(),
        refreshNetworkContext(),
        ensureToken(networkId).then(setBearer),
      ]);
    },
    [adoptNetworkClient, refreshNetworkContext, resetData],
  );

  const handleNetworkLifecycle = useCallback(
    async (networkId, action) => {
      const out = await networkLifecycle(networkId, action);
      adoptNetworkClient(networkId);
      setBearer("");
      await Promise.all([
        resetData(),
        refreshNetworkContext(),
        action === "wake"
          ? ensureToken(networkId).then(setBearer)
          : Promise.resolve(),
      ]);
      return out;
    },
    [adoptNetworkClient, refreshNetworkContext, resetData],
  );

  const handleTopNetworkLifecycle = useCallback(
    async (action) => {
      const target = networks.find((network) => network.id === activeNetworkId);
      if (!target) return;
      if (
        action === "sleep" &&
        !confirm(
          `Save and sleep ${target.label || target.id}? Data stays in the object store.`,
        )
      ) {
        return;
      }
      setNetworkActionBusy(true);
      try {
        await handleNetworkLifecycle(target.id, action);
      } catch (error) {
        alert(error.message || String(error));
      } finally {
        setNetworkActionBusy(false);
      }
    },
    [activeNetworkId, handleNetworkLifecycle, networks],
  );

  const handleCreateNetwork = useCallback(
    async (input) => {
      const out = await createNetwork(input);
      const networkId = out?.network?.id;
      if (networkId) adoptNetworkClient(networkId);
      setBearer("");
      await Promise.all([
        resetData(),
        refreshNetworkContext(),
        networkId ? ensureToken(networkId).then(setBearer) : Promise.resolve(),
      ]);
      return out;
    },
    [adoptNetworkClient, refreshNetworkContext, resetData],
  );

  const submitNetworkCreate = useCallback(
    async (input) => {
      setResourceBusy(true);
      setResourceError("");
      try {
        await handleCreateNetwork(input);
        setNetworkCreateOpen(false);
      } catch (error) {
        setResourceError(error.message || String(error));
      } finally {
        setResourceBusy(false);
      }
    },
    [handleCreateNetwork],
  );

  const handleDeleteNetwork = useCallback(
    async (networkId) => {
      const target = networks.find((network) => network.id === networkId);
      if (!target) return;
      if (target.state !== "asleep") {
        alert("Sleep this network before removing it from the dashboard.");
        return;
      }
      if (
        !confirm(
          `Remove "${target.label || target.id}" from the dashboard?\n\nCompute and object-store data are not destroyed.`,
        )
      ) {
        return;
      }
      try {
        await networkLifecycle(networkId, "delete");
        const registry = await refreshNetworkContext();
        if (registry?.active) {
          adoptNetworkClient(registry.active);
          await resetData();
        } else {
          setActiveNetworkId("");
          setBearer("");
          await resetData();
        }
      } catch (error) {
        alert(error.message || String(error));
      }
    },
    [adoptNetworkClient, networks, refreshNetworkContext, resetData],
  );

  const submitCollectionCreate = useCallback(async (name) => {
    setResourceBusy(true);
    setResourceError("");
    try {
      const out = await createCollection(name);
      const created = out?.collection || name;
      setCollections(out?.collections || ((current) => [...new Set([...current, created])]));
      setCollection(created);
      setCollectionCreateOpen(false);
    } catch (error) {
      setResourceError(error.message || String(error));
    } finally {
      setResourceBusy(false);
    }
  }, []);

  /** Wipe client /sets cache (owners too) and force wire re-fetch — no remount. */
  const clearDataCache = useCallback(() => {
    setDataStatus("cache cleared · refetching…");
    aggregateCacheApiRef.current?.clearSetsCache?.({ owners: true });
  }, []);

  const handleDeleteCollection = useCallback(
    async (name) => {
      if (!name) return;
      if (
        !confirm(
          `Permanently delete collection "${name}" and its zone snapshots from the active network?`,
        )
      ) {
        return;
      }
      try {
        const out = await deleteCollection(name);
        if (!out?.ok) throw new Error(`Collection delete was partial for ${name}`);
        setCollections((current) => current.filter((item) => item !== name));
        if (collection === name) {
          setCollection(
            collections.find((item) => item !== name) || COLLECTION_PRESETS[0].id,
          );
        }
        clearDataCache();
      } catch (error) {
        alert(error.message || String(error));
      }
    },
    [clearDataCache, collection, collections],
  );

  useEffect(() => {
    if (!activeNetworkId) return undefined;
    let cancelled = false;
    ensureToken(activeNetworkId)
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
  }, [activeNetworkId]);

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

  // Nearby Nodes/Metrics ride the shared Aggregate worker Network (no second
  // main-thread Network). Wait until AggregateHeatmap fills cacheApiRef.
  useEffect(() => {
    if (mode !== "nearby" || !hosts.length || tab !== "client") {
      nearbyNetDisposeRef.current?.();
      nearbyNetDisposeRef.current = null;
      setNearbyController(null);
      setNearbyNodeCount(0);
      setNearbyMetricsHint(null);
      return undefined;
    }

    let cancelled = false;
    const attach = () => {
      const api = aggregateCacheApiRef.current;
      if (!api?.subscribeNetwork) return false;
      nearbyNetDisposeRef.current?.();
      setNearbyController({
        subscribeNetwork: api.subscribeNetwork,
        forgetPeer: api.forgetPeer,
      });
      nearbyNetDisposeRef.current = () => {
        setNearbyController(null);
      };
      return true;
    };

    if (attach()) return () => {
      cancelled = true;
      nearbyNetDisposeRef.current?.();
      nearbyNetDisposeRef.current = null;
    };

    const timer = setInterval(() => {
      if (cancelled) return;
      if (attach()) clearInterval(timer);
    }, 200);

    return () => {
      cancelled = true;
      clearInterval(timer);
      nearbyNetDisposeRef.current?.();
      nearbyNetDisposeRef.current = null;
    };
  }, [mode, tab, hosts, collection, dataEpoch, bearer]);

  useEffect(() => {
    aggregateCacheApiRef.current?.setSurface?.(
      mode === "nearby" ? "nearby" : "aggregate",
    );
  }, [mode]);

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
            workerSearch: (opts) => {
              const api = aggregateCacheApiRef.current;
              if (!api?.searchNearby) {
                throw new Error(
                  "mesh worker not ready — wait for Aggregate INIT",
                );
              }
              return api.searchNearby(opts);
            },
          });
        } else {
          sessionRef.current.lat = origin.lat;
          sessionRef.current.lng = origin.lng;
          sessionRef.current.step = step;
          sessionRef.current.hosts = hosts;
          sessionRef.current.collectionName = collection;
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
    if (!auto || mode !== "nearby" || !hosts.length || tab !== "client") return;
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
    if (mode !== "nearby" || tab !== "client" || !hosts.length) return;
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
        networks={networks}
        activeNetworkId={activeNetworkId}
        onNetwork={handleSelectNetwork}
        onCreateNetwork={() => {
          setResourceError("");
          setNetworkCreateOpen(true);
        }}
        onDeleteNetwork={handleDeleteNetwork}
        collections={collections}
        collection={collection}
        onCollection={setCollection}
        onCreateCollection={() => {
          setResourceError("");
          setCollectionCreateOpen(true);
        }}
        onDeleteCollection={handleDeleteCollection}
        peerHint={peerHint}
        onReset={resetData}
        busy={busy || resourceBusy || networkActionBusy}
      />

      {pollErr && <div className="err-banner">{pollErr}</div>}

      <div
        className={tab === "network" ? "tab-panel" : "tab-panel hidden"}
        hidden={tab !== "network"}
      >
        <OpsPanel
          mesh={mesh}
          collection={collection}
          onSelectCollection={setCollection}
          onCollectionDeleted={(name) => {
            clearDataCache();
            setCollections((current) => current.filter((item) => item !== name));
            if (collection === name) setCollection(COLLECTION_PRESETS[0].id);
          }}
          activeNetwork={
            networks.find((network) => network.id === activeNetworkId) || null
          }
          onNetworkLifecycle={handleTopNetworkLifecycle}
          networkActionBusy={networkActionBusy}
        />
      </div>

      <div
        className={tab === "client" ? "tab-panel" : "tab-panel hidden"}
        hidden={tab !== "client"}
      >
        <section className="data-section">
          <div className="data-layout">
            {hosts.length > 0 ? (
              <div
                className={mode === "aggregate" ? undefined : "hidden"}
                hidden={mode !== "aggregate"}
              >
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
                  sideCollapsed={sideCollapsed}
                  onToggleSideCollapsed={() => setSideCollapsed((v) => !v)}
                  onViewportChange={onAggregateViewport}
                  readOptions={readOptions}
                  cacheApiRef={aggregateCacheApiRef}
                  onMode={onMode}
                  readNavigation={readNavigation}
                  onReadNavigation={onReadNavigation}
                  readMethod={readMethod}
                  onReadMethod={onReadMethod}
                  onClearCache={clearDataCache}
                  busy={busy}
                  surface={mode === "nearby" ? "nearby" : "aggregate"}
                />
              </div>
            ) : null}
            {mode === "nearby" ? (
              <>
                <MapPanel
                  key={`near-${dataEpoch}`}
                  center={mapViewportRef.current.nearby.center}
                  zoom={mapViewportRef.current.nearby.zoom}
                  origin={origin}
                  hits={displayHits}
                  onMapClick={onMapClick}
                  onHitFocus={onHitFocus}
                  active={tab === "client"}
                  fitNonce={fitNonce}
                  theme={theme}
                  normalizer={normalizer}
                  hoverHit={hoveredHit}
                  onViewportChange={onNearbyViewport}
                  onMode={onMode}
                  waiting={!hosts.length || !bearer}
                  waitingMessage={
                    !hosts.length
                      ? "waiting for mesh hosts…"
                      : "issuing bearer for heatmap worker…"
                  }
                />
                <DataSidePanel
                  view={sideView}
                  onView={setSideView}
                  collapsed={sideCollapsed}
                  onToggleCollapsed={() => setSideCollapsed((v) => !v)}
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
                      readNavigation={readNavigation}
                      onReadNavigation={onReadNavigation}
                      readMethod={readMethod}
                      onReadMethod={onReadMethod}
                      onClearCache={clearDataCache}
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
            ) : null}
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

      <NetworkCreateModal
        open={networkCreateOpen}
        busy={resourceBusy}
        error={resourceError}
        onClose={() => setNetworkCreateOpen(false)}
        onCreate={submitNetworkCreate}
      />
      <CollectionCreateModal
        open={collectionCreateOpen}
        busy={resourceBusy}
        error={resourceError}
        networkLabel={
          networks.find((network) => network.id === activeNetworkId)?.label ||
          activeNetworkId
        }
        onClose={() => setCollectionCreateOpen(false)}
        onCreate={submitCollectionCreate}
      />

      <footer className="app-foot">
        {tab === "network"
          ? "network · mesh · spawn · snapshots · data load"
          : mode === "nearby"
            ? "client · nearby · Local.search · auto query / Next N"
            : "client · aggregate · €/m² · WebGPU"}
      </footer>
    </div>
  );
}
