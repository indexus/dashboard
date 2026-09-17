import { useEffect, useMemo, useRef, useState } from "react";
import {
  clearSnapshots,
  deleteCollection,
  flushSnapshots,
  getDvfStatus,
  getMeshConfig,
  getPreferNear,
  getRemeshStatus,
  loadDvf,
  pauseDvf,
  remesh,
  resumeDvf,
  saveMeshConfig,
  spawn,
  stopDvf,
  terminate,
} from "../lib/api.js";
import { COLLECTION_PRESETS } from "../lib/sdk.js";
import { useOverlayScroll } from "../lib/overlayScroll.js";
import {
  MESH_CONFIG_DEFAULTS,
  meshConfigEqual,
  meshConfigFromNode,
  normalizeMeshConfig,
} from "../lib/meshConfig.js";
import SnapshotsBrowser from "./SnapshotsBrowser.jsx";
import NodeConfigView from "./NodeConfigView.jsx";

const fmt = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + "k";
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 10) / 10);
};

/** Seconds before eternal joining/leaving is labeled stuck in Ops. */
const STUCK_JOIN_S = 90;
const STUCK_LEAVE_S = 120;

/**
 * PreferNear from last load-split decision (weighted zone dichotomy).
 */
function preferNearFromNode(n) {
  if (!n) return "";
  if (n.prefer_near_key) return n.prefer_near_key;
  const a = n.autoscale || {};
  return a.last_prefer_near || n.prefer_near || "";
}

function barClass(pct) {
  if (pct == null) return "";
  if (pct >= 80) return "crit";
  if (pct >= 60) return "warn";
  return "";
}

function nodePhase(n, leaveAgeS = 0) {
  if (!n?.up) return "down";
  if (n.leaving) {
    if (leaveAgeS >= STUCK_LEAVE_S && (n.zones ?? 0) > 0) {
      return "stuck_leaving";
    }
    return "leaving";
  }
  if (n.write_ready === false) {
    // PreferNear ignored by sticky cert → 0 zones forever, never write_ready.
    // Or inbound snapshot handoff stuck (CaughtUp / SwitchAck never finished).
    if (
      (n.uptime_s ?? 0) >= STUCK_JOIN_S &&
      ((n.zones ?? 0) === 0 || (n.deleg_in ?? 0) > 0)
    ) {
      return "stuck_joining";
    }
    return "joining";
  }
  if (
    n.transferring ||
    n.rebalancing ||
    (n.deleg_in ?? 0) > 0 ||
    (n.deleg_out ?? 0) > 0
  ) {
    return "transferring";
  }
  return "ready";
}

function phaseLabel(phase, n) {
  if (phase === "down") return "down";
  if (phase === "stuck_leaving") {
    return `stuck leaving · z${n.zones ?? 0} · ${fmt(n.items)}`;
  }
  if (phase === "leaving") {
    return `leaving · z${n.zones ?? 0}`;
  }
  if (phase === "stuck_joining") {
    return (n.deleg_in ?? 0) > 0
      ? `stuck joining · deleg_in`
      : "stuck joining · 0 zones";
  }
  if (phase === "joining") {
    return prep > 0 ? `joining · prep ${fmt(prep)}` : "joining";
  }
  if (phase === "transferring") {
    const parts = [];
    if (n.rebalancing) parts.push("rebalancing");
    if ((n.deleg_in ?? 0) > 0) parts.push(`in:${n.deleg_in}`);
    if ((n.deleg_out ?? 0) > 0) parts.push(`out:${n.deleg_out}`);
    return parts.length ? parts.join(" · ") : "transferring";
  }
  return n.hot_signal || n.last_reason || "ready";
}

function isStuckPhase(phase) {
  return phase === "stuck_joining" || phase === "stuck_leaving";
}

/** @param {{ max?: number, limit?: number|null }} [opts] */
function drawChart(canvas, series, color, opts = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(200,220,230,0.08)";
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    const y = (h * i) / 4;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  const vals = series.filter((v) => v != null && Number.isFinite(v));
  const max =
    opts.max != null && opts.max > 0
      ? opts.max
      : Math.max(1, ...(vals.length ? vals : [1]));
  const limit = opts.limit;

  if (limit != null && limit > 0) {
    const y = h - (Math.min(max, Math.max(0, limit)) / max) * h;
    ctx.strokeStyle = "rgba(232,155,60,0.55)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (vals.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  series.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) return;
    const x = (i / Math.max(1, series.length - 1)) * w;
    const y = h - (Math.min(max, Math.max(0, v)) / max) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function progressLabel(progress) {
  if (!progress) return "—";
  if (typeof progress === "string") return progress;
  const phase = progress.phase || progress.file || "…";
  const posted = progress.posted ?? progress.added;
  const file = progress.file;
  const parts = [phase];
  if (file) parts.push(file);
  if (posted != null) parts.push(`${fmt(posted)} posted`);
  return parts.join(" · ");
}

function mean(nums) {
  const vals = nums.filter((v) => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function sum(nums) {
  const vals = nums.filter((v) => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0);
}

function nodeStats(n) {
  if (!n) return null;
  const delegIn = n.deleg_in ?? 0;
  const delegOut = n.deleg_out ?? 0;
  return {
    answering: n.up ? 1 : 0,
    items: n.items ?? null,
    held: n.held ?? null,
    queue: n.queue ?? null,
    scale_ups: n.scale_ups_done ?? null,
    mem_pct: n.mem_pct ?? null,
    cpu_pct: n.cpu_pct ?? null,
    disk_free_pct: n.disk_free_pct ?? null,
    inserts_window: n.inserts_window ?? null,
    zones: n.zones ?? null,
    peers: n.peers ?? null,
    delegations: delegIn + delegOut,
    deleg_in: delegIn,
    deleg_out: delegOut,
    snap_dirty: n.snap_dirty ?? null,
    wal_segments: n.wal_segments ?? null,
    admit_blocked: n.admit_blocked ? 1 : 0,
    rising_fast: n.rising_fast ? 1 : 0,
    transferring: n.transferring || n.rebalancing ? 1 : 0,
    rebalancing: n.rebalancing ? 1 : 0,
    leaving: n.leaving ? 1 : 0,
    not_ready: n.up && n.write_ready === false ? 1 : 0,
  };
}

/** All-nodes rollup: sum counters, average percentages, count flags. */
function meshNodeStats(nodes) {
  const up = nodes.filter((n) => n?.up);
  const pool = up.length ? up : nodes;
  if (!pool.length) {
    return {
      answering: 0,
      items: null,
      held: null,
      queue: null,
      scale_ups: null,
      mem_pct: null,
      cpu_pct: null,
      disk_free_pct: null,
      inserts_window: null,
      zones: null,
      peers: null,
      delegations: null,
      deleg_in: null,
      deleg_out: null,
      snap_dirty: null,
      wal_segments: null,
      admit_blocked: null,
      rising_fast: null,
      transferring: null,
      rebalancing: null,
      leaving: null,
      not_ready: null,
    };
  }
  return {
    answering: up.length,
    items: sum(pool.map((n) => n.items)),
    held: sum(pool.map((n) => n.held)),
    queue: sum(pool.map((n) => n.queue)),
    scale_ups: sum(pool.map((n) => n.scale_ups_done)),
    mem_pct: mean(pool.map((n) => n.mem_pct)),
    cpu_pct: mean(pool.map((n) => n.cpu_pct)),
    disk_free_pct: mean(pool.map((n) => n.disk_free_pct)),
    inserts_window: sum(pool.map((n) => n.inserts_window)),
    zones: sum(pool.map((n) => n.zones)),
    peers: mean(pool.map((n) => n.peers)),
    delegations: sum(
      pool.map((n) => (n.deleg_in ?? 0) + (n.deleg_out ?? 0)),
    ),
    deleg_in: sum(pool.map((n) => n.deleg_in)),
    deleg_out: sum(pool.map((n) => n.deleg_out)),
    snap_dirty: sum(pool.map((n) => n.snap_dirty)),
    wal_segments: sum(pool.map((n) => n.wal_segments)),
    admit_blocked: sum(pool.map((n) => (n.admit_blocked ? 1 : 0))),
    rising_fast: sum(pool.map((n) => (n.rising_fast ? 1 : 0))),
    transferring: sum(
      pool.map((n) => (n.transferring || n.rebalancing ? 1 : 0)),
    ),
    rebalancing: sum(pool.map((n) => (n.rebalancing ? 1 : 0))),
    leaving: sum(pool.map((n) => (n.leaving ? 1 : 0))),
    not_ready: sum(
      pool.map((n) => (n.up && n.write_ready === false ? 1 : 0)),
    ),
  };
}

/** Chart families: resource pressure · write/capacity · protocol health. */
const CHART_GROUPS = {
  resource: {
    title: "resource",
    metrics: [
      {
        id: "mem_pct",
        label: "memory",
        color: "#5eb8e8",
        unit: "%",
        fixedMax: 100,
        limitKey: "mem_limit_pct",
        rollup: "avg",
      },
      {
        id: "cpu_pct",
        label: "cpu",
        color: "#2ec4a8",
        unit: "%",
        fixedMax: 100,
        limitKey: "cpu_limit_pct",
        rollup: "avg",
      },
      {
        id: "disk_free_pct",
        label: "disk free",
        color: "#c4a06a",
        unit: "%",
        fixedMax: 100,
        limitKey: "disk_min_free",
        rollup: "avg",
      },
    ],
  },
  perf: {
    title: "performance",
    metrics: [
      {
        id: "inserts_window",
        label: "write rate · window",
        color: "#e87a5e",
        unit: "",
        rollup: "sum",
      },
      {
        id: "items_rate",
        label: "items / s",
        color: "#f0b060",
        unit: "/s",
        rollup: "sum",
      },
      {
        id: "items",
        label: "items",
        color: "#e89b3c",
        unit: "",
        limitKey: "items_limit",
        rollup: "sum",
      },
      {
        id: "held",
        label: "items prep",
        color: "#d4a574",
        unit: "",
        rollup: "sum",
      },
      {
        id: "answering",
        label: "nodes up",
        color: "#7ec8a8",
        unit: "",
        rollup: "sum",
      },
      {
        id: "zones",
        label: "zones",
        color: "#9bb8d4",
        unit: "",
        rollup: "sum",
      },
      {
        id: "peers",
        label: "peers",
        color: "#8aa4b8",
        unit: "",
        rollup: "avg",
      },
    ],
  },
  health: {
    title: "protocol",
    metrics: [
      {
        id: "queue",
        label: "queue",
        color: "#c47a9a",
        unit: "",
        limitKey: "queue_abs",
        rollup: "sum",
      },
      {
        id: "delegations",
        label: "delegations · in+out",
        color: "#a87ab8",
        unit: "",
        rollup: "sum",
      },
      {
        id: "deleg_in",
        label: "deleg in",
        color: "#9a7ab8",
        unit: "",
        rollup: "sum",
      },
      {
        id: "deleg_out",
        label: "deleg out",
        color: "#b88aa0",
        unit: "",
        rollup: "sum",
      },
      {
        id: "transferring",
        label: "transferring",
        color: "#b88a6a",
        unit: "",
        rollup: "sum",
      },
      {
        id: "rebalancing",
        label: "rebalancing",
        color: "#b8a06a",
        unit: "",
        rollup: "sum",
      },
      {
        id: "leaving",
        label: "leaving",
        color: "#c09070",
        unit: "",
        rollup: "sum",
      },
      {
        id: "not_ready",
        label: "not client-ready",
        color: "#e07060",
        unit: "",
        rollup: "sum",
      },
      {
        id: "admit_blocked",
        label: "admit blocked",
        color: "#e06070",
        unit: "",
        rollup: "sum",
      },
      {
        id: "rising_fast",
        label: "rising fast",
        color: "#e08050",
        unit: "",
        rollup: "sum",
      },
      {
        id: "snap_dirty",
        label: "snap dirty",
        color: "#7a9ab8",
        unit: "",
        rollup: "sum",
      },
      {
        id: "wal_segments",
        label: "wal segments",
        color: "#6a8aa0",
        unit: "",
        rollup: "sum",
      },
      {
        id: "scale_ups",
        label: "scale ups done",
        color: "#6aa890",
        unit: "",
        rollup: "sum",
      },
    ],
  },
};

function metricById(groupId, metricId) {
  const group = CHART_GROUPS[groupId];
  return group?.metrics.find((m) => m.id === metricId) || group?.metrics[0];
}

function formatMetricNow(metric, value) {
  if (value == null || Number.isNaN(value)) return "—";
  if (metric.unit === "%") return `${fmt(value)}%`;
  if (metric.unit === "/s") return `${fmt(value)}/s`;
  return fmt(value);
}

export default function OpsPanel({
  mesh,
  collection,
  onSelectCollection,
  onCollectionDeleted,
  activeNetwork = null,
  onNetworkLifecycle,
  networkActionBusy = false,
}) {
  const chart1Ref = useRef(null);
  const chart2Ref = useRef(null);
  const chart3Ref = useRef(null);
  const chartHistRef = useRef([]);
  const chartScopeRef = useRef(null);
  const chartTsRef = useRef(0);
  const [chartResource, setChartResource] = useState("mem_pct");
  const [chartPerf, setChartPerf] = useState("inserts_window");
  const [chartHealth, setChartHealth] = useState("queue");
  const [selectedKey, setSelectedKey] = useState(null);
  const [spawnCount, setSpawnCount] = useState(1);
  const [preferNear, setPreferNear] = useState("");
  const [spawnStatus, setSpawnStatus] = useState("");
  const [snapStatus, setSnapStatus] = useState("—");
  const [snapshotPrefix, setSnapshotPrefix] = useState("");
  const [busy, setBusy] = useState(false);
  const [sideTab, setSideTab] = useState("data");
  /** @type {React.MutableRefObject<Map<string, number>>} */
  const leavingSinceRef = useRef(new Map());
  const [, setLeaveTick] = useState(0);

  const [dvfCollection, setDvfCollection] = useState(
    COLLECTION_PRESETS[0]?.id || "DvFMV2020idx0001",
  );
  const [dvfYear, setDvfYear] = useState("2020");
  const [dvfRoute, setDvfRoute] = useState("xor");
  const [dvfStatus, setDvfStatus] = useState(null);
  const [dvfMsg, setDvfMsg] = useState("");

  useEffect(() => {
    if (collection) setDvfCollection(collection);
  }, [collection]);

  const [configDraft, setConfigDraft] = useState(null);
  const [configDirty, setConfigDirty] = useState(false);
  const [keepSnapshots, setKeepSnapshots] = useState(false);
  const [remeshBusy, setRemeshBusy] = useState(false);
  const [remeshMsg, setRemeshMsg] = useState("");
  const configBaselineRef = useRef(null);
  const savedConfigRef = useRef(null);
  const [savedTick, setSavedTick] = useState(0);

  // Down / unreachable hosts stay out of the Ops table — mesh poll still
  // carries them briefly after terminate, but they must not linger in the UI.
  const nodes = useMemo(
    () => (mesh?.nodes || []).filter((n) => n?.up),
    [mesh?.nodes],
  );
  const snaps = mesh?.snapshots || {};
  const lim = mesh?.autoscale || {};

  const objs = snaps.objects || [];
  const loadRunning = !!dvfStatus?.running;
  const loadPaused = !!dvfStatus?.paused;
  const nodesScrollRef = useOverlayScroll([nodes.length]);
  const snapsScrollRef = useOverlayScroll([objs.length, sideTab]);

  const selected = useMemo(
    () => nodes.find((n) => `${n.ip}:${n.mon}` === selectedKey) || null,
    [nodes, selectedKey],
  );

  useEffect(() => {
    if (selectedKey && !selected) setSelectedKey(null);
  }, [selectedKey, selected]);

  const liveNode = useMemo(() => {
    if (selected) return selected;
    return (
      nodes.find((n) => n.up && n.role === "bootstrap") ||
      nodes.find((n) => n.up) ||
      null
    );
  }, [selected, nodes]);

  /** Config tab: network launch knobs — prefer bootstrap (shared mesh settings). */
  const configNode = useMemo(() => {
    return (
      nodes.find((n) => n.up && n.role === "bootstrap") ||
      selected ||
      nodes.find((n) => n.up) ||
      null
    );
  }, [selected, nodes]);

  const liveConfig = useMemo(
    () => (configNode ? meshConfigFromNode(configNode) : null),
    [configNode],
  );

  // Load persisted mesh-config.env once (preferred draft / remesh target).
  useEffect(() => {
    let cancelled = false;
    getMeshConfig()
      .then((out) => {
        if (cancelled) return;
        if (out?.saved) {
          savedConfigRef.current = normalizeMeshConfig(out.saved);
        }
        setSavedTick((n) => n + 1);
      })
      .catch(() => {
        setSavedTick((n) => n + 1);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Seed / refresh draft from saved file or live pulse while no pending edits.
  useEffect(() => {
    if (!liveConfig) return;
    if (configDirty) return;
    if (remeshBusy) return;
    const saved = savedConfigRef.current;
    let next;
    if (saved) {
      next = saved;
    } else {
      // Lab default: zone size 5k even if the running mesh still has a legacy 100k.
      next = normalizeMeshConfig({
        ...liveConfig,
        delegation: MESH_CONFIG_DEFAULTS.delegation,
      });
    }
    setConfigDraft(next);
    configBaselineRef.current = liveConfig;
    setConfigDirty(!meshConfigEqual(next, liveConfig));
  }, [liveConfig, configDirty, remeshBusy, savedTick]);

  // Live only while a node row is selected; otherwise Data / Network / Snapshots.
  useEffect(() => {
    if (selected) {
      setSideTab("live");
      return;
    }
    setSideTab((t) => (t === "live" ? "data" : t));
  }, [selected]);

  // Drop selection if the node left the mesh.
  useEffect(() => {
    if (selectedKey && !selected) setSelectedKey(null);
  }, [selectedKey, selected]);

  const stats = useMemo(
    () => (selected ? nodeStats(selected) : meshNodeStats(nodes)),
    [selected, nodes],
  );
  const statsScope = selectedKey || "__mesh__";
  const statsHint = selected
    ? selected.name || selected.instance_id || `${selected.ip}:${selected.mon}`
    : "sum · all nodes";

  useEffect(() => {
    if (!stats) return;
    if (chartScopeRef.current !== statsScope) {
      chartHistRef.current = [];
      chartScopeRef.current = statsScope;
      chartTsRef.current = 0;
    }

    const now = Date.now();
    const prev = chartHistRef.current[chartHistRef.current.length - 1];
    let itemsRate = null;
    if (prev && chartTsRef.current > 0 && stats.items != null && prev.items != null) {
      const dt = (now - chartTsRef.current) / 1000;
      if (dt > 0) {
        itemsRate = Math.max(0, (stats.items - prev.items) / dt);
      }
    }
    chartTsRef.current = now;

    chartHistRef.current.push({
      ...stats,
      items_rate: itemsRate,
    });
    const maxPts = 240;
    while (chartHistRef.current.length > maxPts) chartHistRef.current.shift();

    const hist = chartHistRef.current;
    const paint = (canvas, groupId, metricId) => {
      const metric = metricById(groupId, metricId);
      if (!metric || !canvas) return;
      const series = hist.map((h) => h[metric.id]);
      const vals = series.filter((v) => v != null && Number.isFinite(v));
      const peak = vals.length ? Math.max(...vals) : 0;
      const max =
        metric.fixedMax != null
          ? metric.fixedMax
          : Math.max(peak * 1.1, metric.id === "queue" ? 10 : 1);
      const limit =
        metric.limitKey != null ? (lim[metric.limitKey] ?? null) : null;
      drawChart(canvas, series, metric.color, { max, limit });
    };

    paint(chart1Ref.current, "resource", chartResource);
    paint(chart2Ref.current, "perf", chartPerf);
    paint(chart3Ref.current, "health", chartHealth);
  }, [
    mesh,
    stats,
    statsScope,
    chartResource,
    chartPerf,
    chartHealth,
    lim.mem_limit_pct,
    lim.cpu_limit_pct,
    lim.items_limit,
    lim.queue_abs,
    lim.disk_min_free,
  ]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await getDvfStatus();
        if (!alive) return;
        setDvfStatus(s);
        if (s.running) {
          const base = progressLabel(s.progress);
          setDvfMsg(s.paused ? `paused · ${base}` : base);
        } else if (s.error) {
          setDvfMsg(`error · ${s.error}`);
        } else if (s.result) {
          const added = s.result.added ?? s.result.posted;
          setDvfMsg(added != null ? `done · ${fmt(added)} items` : "done");
        }
      } catch (_) {}
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const map = leavingSinceRef.current;
    const now = Date.now();
    const alive = new Set();
    for (const n of nodes) {
      const key = `${n.ip}:${n.mon}`;
      alive.add(key);
      if (n.leaving) {
        if (!map.has(key)) map.set(key, now);
      } else {
        map.delete(key);
      }
    }
    for (const key of [...map.keys()]) {
      if (!alive.has(key)) map.delete(key);
    }
  }, [nodes]);

  // Keep prefer_near aligned with the selected peer’s content key as pulse updates.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const local = preferNearFromNode(selected);
    if (local) setPreferNear(local);
    getPreferNear({
      ip: selected.ip,
      mon: selected.mon,
      name: selected.name || "",
    })
      .then((out) => {
        if (cancelled) return;
        if (out?.prefer_near && out.source !== "name") {
          setPreferNear(out.prefer_near);
        } else if (out?.prefer_near && !local) {
          setPreferNear(out.prefer_near);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    selectedKey,
    selected?.ip,
    selected?.mon,
    selected?.prefer_near_key,
    selected?.autoscale?.last_prefer_near,
  ]);

  useEffect(() => {
    const id = setInterval(() => setLeaveTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  function leaveAgeS(n) {
    const since = leavingSinceRef.current.get(`${n.ip}:${n.mon}`);
    if (since == null) return 0;
    return (Date.now() - since) / 1000;
  }

  async function onSpawn() {
    setBusy(true);
    setSpawnStatus("spawning…");
    try {
      const near =
        preferNear.trim() ||
        preferNearFromNode(selected) ||
        "";
      const out = await spawn({
        spawn_count: spawnCount,
        prefer_near: near,
      });
      const ids = out.instance_ids || (out.instance_id ? [out.instance_id] : []);
      setSpawnStatus(
        near
          ? `spawned near ${near.slice(0, 12)}… · ${ids.join(", ") || "ok"}`
          : `spawned ${ids.join(", ") || "ok"}`,
      );
    } catch (e) {
      setSpawnStatus(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function onRemove() {
    const id = selected?.instance_id || selected?.ip;
    if (!id) return;
    if (
      !confirm(
        `Remove ${id}? This permanently terminates the instance without Drain.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setSpawnStatus(`removing ${id}…`);
    try {
      await terminate({
        instance_id: selected.instance_id || undefined,
        ip: selected.ip || undefined,
      });
      setSpawnStatus(`terminated ${id}`);
      setSelectedKey(null);
    } catch (e) {
      setSpawnStatus(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function onFlush() {
    setBusy(true);
    setSnapStatus("saving all…");
    try {
      const out = await flushSnapshots(true);
      const ok = (out.results || []).filter((r) => r.ok).length;
      setSnapStatus(`saved ${ok}/${(out.results || []).length}`);
    } catch (e) {
      setSnapStatus(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function onClear() {
    const target = snapshotPrefix || "zones/, nodes/, snapshots/";
    if (!confirm(`Permanently clear ${target}?`)) return;
    setBusy(true);
    setSnapStatus(snapshotPrefix ? `clearing ${snapshotPrefix}…` : "clearing all…");
    try {
      const out = await clearSnapshots(snapshotPrefix);
      setSnapStatus(
        out.available === false
          ? "store not attached"
          : `cleared ${out.cleared ?? 0}${
              out.prefix
                ? ` under ${String(out.prefix).replace(/\/$/, "")}`
                : ""
            }`,
      );
    } catch (e) {
      setSnapStatus(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteCollection() {
    const name = dvfCollection.trim();
    if (!name) return;
    if (
      !confirm(
        `Permanently delete collection "${name}" from every live node and its zone snapshots?`,
      )
    ) {
      return;
    }
    setBusy(true);
    setDvfMsg(`deleting ${name}…`);
    try {
      const out = await deleteCollection(name);
      const results = out.results || [];
      const ok = results.filter((result) => result.ok).length;
      const removed = results.reduce(
        (sum, result) => sum + (Number(result.removed_zones) || 0),
        0,
      );
      setDvfMsg(
        out.ok
          ? `deleted ${name} · ${removed} zones on ${ok}/${results.length} nodes`
          : `partial delete ${name} · ${ok}/${results.length} nodes`,
      );
      if (out.ok) onCollectionDeleted?.(name);
    } catch (e) {
      setDvfMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  function onConfigChange(next) {
    const normalized = normalizeMeshConfig(next);
    setConfigDraft(normalized);
    const baseline = configBaselineRef.current || liveConfig;
    setConfigDirty(baseline ? !meshConfigEqual(normalized, baseline) : true);
  }

  function onConfigReset() {
    const baseline = liveConfig || configBaselineRef.current;
    if (!baseline) return;
    setConfigDraft(baseline);
    configBaselineRef.current = baseline;
    setConfigDirty(false);
    setRemeshMsg("");
  }

  async function onRemesh({ keep_snapshots = true } = {}) {
    const wipeSnaps = !keep_snapshots;
    const confirmMsg = wipeSnaps
      ? "Clean & restart the local mesh?\n\nStops issuer + bootstrap + spawned, wipes .data-local/snapshots and node data, then runs mesh_up.sh."
      : "Restart the local mesh?\n\nThis stops issuer + bootstrap + spawned nodes, then runs mesh_up with your Config. Node data under .data-local/nodes is wiped (snapshots kept).";
    if (!confirm(confirmMsg)) {
      return;
    }
    setRemeshBusy(true);
    setRemeshMsg(
      wipeSnaps
        ? "stopping · wiping snapshots · restarting…"
        : "writing config · restarting mesh…",
    );
    try {
      const body = { keep_snapshots: !!keep_snapshots };
      if (configDraft) {
        await saveMeshConfig(configDraft);
        body.config = configDraft;
      }
      await remesh(body);
      // Poll remesh until mesh_up finishes (build + boot).
      const started = Date.now();
      while (Date.now() - started < 180000) {
        await new Promise((r) => setTimeout(r, 1500));
        const st = await getRemeshStatus();
        if (st.running) {
          const tail = (st.log_tail || "").trim().split("\n").slice(-1)[0];
          setRemeshMsg(tail || "restarting…");
          continue;
        }
        if (st.ok) {
          setRemeshMsg(
            wipeSnaps ? "mesh cleaned & restarted" : "mesh restarted",
          );
          if (configDraft) {
            setConfigDirty(false);
            configBaselineRef.current = configDraft;
            savedConfigRef.current = configDraft;
          }
          break;
        }
        setRemeshMsg(st.error || "remesh failed");
        break;
      }
    } catch (e) {
      setRemeshMsg(e.message || String(e));
    } finally {
      setRemeshBusy(false);
    }
  }

  async function onLoadDvf() {
    const collection = dvfCollection.trim();
    if (!collection) {
      setDvfMsg("collection required (≤16 chars)");
      return;
    }
    if (collection.length > 16) {
      setDvfMsg("collection id must be ≤16 chars");
      return;
    }
    setBusy(true);
    setDvfMsg("starting…");
    try {
      const body = {
        collection,
        year: dvfYear,
        route: dvfRoute,
        full: true,
      };
      const out = await loadDvf(body);
      setDvfMsg(out.message || `started · ${collection}`);
      onSelectCollection?.(collection);
    } catch (e) {
      setDvfMsg(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onPauseResumeDvf() {
    setBusy(true);
    try {
      if (loadPaused) {
        await resumeDvf();
        setDvfMsg("resumed");
      } else {
        await pauseDvf();
        setDvfMsg("paused · insertions held");
      }
      const s = await getDvfStatus();
      setDvfStatus(s);
    } catch (e) {
      setDvfMsg(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onStopDvf() {
    setBusy(true);
    try {
      await stopDvf();
      setDvfMsg("stopping…");
      const s = await getDvfStatus();
      setDvfStatus(s);
    } catch (e) {
      setDvfMsg(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ops-shell">
      <div className="ops-section ops-section--head">
        <div className="pulse">
          <div className="metric">
            <div className="label">
              answering
              <span className="metric-scope">{statsHint}</span>
            </div>
            <div className="value">{fmt(stats.answering)}</div>
          </div>
          <div className="metric">
            <div className="label">
              items{selected ? "" : " · sum"}
            </div>
            <div className="value">{fmt(stats.items)}</div>
          </div>
          <div className="metric">
            <div className="label">
              queue{selected ? "" : " · sum"}
            </div>
            <div className="value">{fmt(stats.queue)}</div>
          </div>
          <div className="metric">
            <div className="label">
              scale ups{selected ? "" : " · sum"}
            </div>
            <div className="value">{fmt(stats.scale_ups)}</div>
          </div>
        </div>
        <div className="charts charts--3">
          {[
            {
              groupId: "resource",
              value: chartResource,
              set: setChartResource,
              canvasRef: chart1Ref,
              histKey: chartResource,
            },
            {
              groupId: "perf",
              value: chartPerf,
              set: setChartPerf,
              canvasRef: chart2Ref,
              histKey: chartPerf === "items_rate" ? "items_rate" : chartPerf,
            },
            {
              groupId: "health",
              value: chartHealth,
              set: setChartHealth,
              canvasRef: chart3Ref,
              histKey: chartHealth,
            },
          ].map((slot) => {
            const group = CHART_GROUPS[slot.groupId];
            const metric = metricById(slot.groupId, slot.value);
            const latest = chartHistRef.current[chartHistRef.current.length - 1];
            const nowVal =
              slot.histKey === "items_rate"
                ? (latest?.items_rate ?? null)
                : (stats?.[slot.histKey] ?? null);
            return (
              <div className="chart-panel" key={slot.groupId}>
                <div className="chart-label">
                  <label className="chart-metric">
                    <select
                      value={metric?.id}
                      onChange={(e) => slot.set(e.target.value)}
                      aria-label={`${group.title} metric`}
                    >
                      {group.metrics.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                          {selected
                            ? ""
                            : m.rollup === "avg"
                              ? " · avg"
                              : " · sum"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span className="now">{formatMetricNow(metric, nowVal)}</span>
                </div>
                <canvas
                  className="chart"
                  ref={slot.canvasRef}
                  width={320}
                  height={88}
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="ops-nodes-layout">
        <div className="ops-nodes-col">
          <div className="section-head">
            <h2>nodes</h2>
            <span className="hint">
              {remeshBusy || remeshMsg ? remeshMsg : spawnStatus}
            </span>
          </div>

          <div className="ops-nodes-actions">
            <label className="field">
              count
              <input
                type="number"
                min={1}
                max={3}
                value={spawnCount}
                onChange={(e) =>
                  setSpawnCount(parseInt(e.target.value, 10) || 1)
                }
              />
            </label>
            <label
              className="field"
              title="PreferNear from weighted zone dichotomy (SplitLoadTargets ≈½ items). Spawned peer joins XOR-near this key."
            >
              prefer_near
              <input
                value={preferNear}
                onChange={(e) => setPreferNear(e.target.value)}
                placeholder={
                  selected
                    ? preferNearFromNode(selected) || "resolving split…"
                    : "select a node"
                }
                spellCheck={false}
                style={{ minWidth: "10rem", fontFamily: "var(--mono)" }}
              />
            </label>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={onSpawn}
            >
              + Spawn
            </button>
            <button
              type="button"
              className="danger"
              disabled={
                busy ||
                (!selected?.instance_id && !selected?.ip) ||
                selected.role === "bootstrap"
              }
              onClick={onRemove}
              title={
                selected?.instance_id || selected?.ip
                  ? `Permanently terminate ${
                      selected.instance_id || selected.ip
                    } (no Drain)`
                  : "Select a spawned node"
              }
            >
              − Remove
            </button>
            <button
              type="button"
              className="primary ops-nodes-lifecycle"
              disabled={busy || networkActionBusy || !activeNetwork}
              onClick={() =>
                onNetworkLifecycle?.(
                  activeNetwork?.state === "asleep" ? "wake" : "sleep",
                )
              }
              title={
                activeNetwork?.state === "asleep"
                  ? "Wake network nodes"
                  : "Checkpoint then sleep network nodes"
              }
            >
              {networkActionBusy
                ? "Working…"
                : activeNetwork?.state === "asleep"
                  ? "Wake"
                  : "Sleep"}
            </button>
          </div>

          <div className="cols-head">
            <span>host</span>
            <span>role</span>
            <span>peers</span>
            <span>items</span>
            <span>queue</span>
            <span>mem</span>
            <span>cpu</span>
            <span>signal</span>
          </div>
          <div className="nodes scroll-fade" ref={nodesScrollRef}>
            {!nodes.length && (
              <div className="node down">
                <span className="sub">no nodes</span>
              </div>
            )}
            {nodes.map((n) => {
              const key = `${n.ip}:${n.mon}`;
              const phase = nodePhase(n, leaveAgeS(n));
              const preparing =
                phase === "joining" ||
                phase === "transferring" ||
                phase === "stuck_joining";
              const stuck = isStuckPhase(phase);
              const signal = phaseLabel(phase, n);
              return (
                <div
                  key={key}
                  className={`node${selectedKey === key ? " selected" : ""}${
                    n.up ? "" : " down"
                  }${preparing ? " preparing" : ""}${
                    phase === "leaving" || phase === "stuck_leaving"
                      ? " leaving"
                      : ""
                  }${stuck ? " stuck" : ""}${
                    phase === "ready" ? " ready" : ""
                  }`}
                  onClick={() => {
                    if (selectedKey === key) {
                      setSelectedKey(null);
                      setPreferNear("");
                      return;
                    }
                    setSelectedKey(key);
                    const local = preferNearFromNode(n);
                    if (local) setPreferNear(local);
                    else setPreferNear("");
                    getPreferNear({
                      ip: n.ip,
                      mon: n.mon,
                      name: n.name || "",
                    })
                      .then((out) => {
                        if (out?.prefer_near && out.source !== "name") {
                          setPreferNear(out.prefer_near);
                        } else if (out?.prefer_near && !local) {
                          setPreferNear(out.prefer_near);
                        }
                      })
                      .catch(() => {});
                  }}
                  title={
                    selectedKey === key
                      ? "Click again to deselect (show mesh sums)"
                      : stuck
                      ? phase === "stuck_joining"
                        ? "No zones after join — often sticky local-N.cert.json ignored PreferNear. Remove or remesh."
                        : "Drain not finishing (large-zone /transfer timeout). Remove or remesh."
                      : `Select · PreferNear from load-split (${
                          preferNearFromNode(n) || "…"
                        })`
                  }
                >
                  <div>
                    <div className="name">{n.name || n.ip}</div>
                    <div className="sub">
                      {n.ip}:{n.mon}
                      {n.instance_id ? ` · ${n.instance_id}` : ""}
                    </div>
                  </div>
                  <div>{n.role || (n.up ? "—" : "down")}</div>
                  <div title="registered peers this node knows">
                    {fmt(n.peers)}
                  </div>
                  <div title="official items · preparing (inbound snap)">
                    {fmt(n.items)}
                    {(n.held ?? 0) > 0 ? (
                      <div className="sub">+{fmt(n.held)} held</div>
                    ) : null}
                  </div>
                  <div>{fmt(n.queue)}</div>
                  <div>
                    {fmt(n.mem_pct)}%
                    <div className={`bar ${barClass(n.mem_pct)}`}>
                      <span
                        style={{ width: `${Math.min(100, n.mem_pct || 0)}%` }}
                      />
                    </div>
                  </div>
                  <div>
                    {fmt(n.cpu_pct)}%
                    <div className={`bar ${barClass(n.cpu_pct)}`}>
                      <span
                        style={{ width: `${Math.min(100, n.cpu_pct || 0)}%` }}
                      />
                    </div>
                  </div>
                  <div className="sub">{signal}</div>
                </div>
              );
            })}
          </div>
        </div>

        <aside className="ops-snaps-col" aria-label="ops side panel">
          <div className="ops-side-head">
            <div className="data-side-tabs" role="tablist">
              {selected ? (
                <button
                  type="button"
                  role="tab"
                  aria-selected={sideTab === "live"}
                  className={sideTab === "live" ? "active" : ""}
                  onClick={() => setSideTab("live")}
                  title="Per-node identity, capacity, and live signals"
                >
                  Live
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={sideTab === "data"}
                    className={sideTab === "data" ? "active" : ""}
                    onClick={() => setSideTab("data")}
                  >
                    Data
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={sideTab === "config"}
                    className={sideTab === "config" ? "active" : ""}
                    onClick={() => setSideTab("config")}
                    title="Network launch knobs — restart required to apply"
                  >
                    Network
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={sideTab === "snapshots"}
                    className={sideTab === "snapshots" ? "active" : ""}
                    onClick={() => setSideTab("snapshots")}
                  >
                    Snapshots
                  </button>
                </>
              )}
            </div>
          </div>

          {selected || sideTab === "live" ? (
            <div className="ops-side-body ops-side-body--kv">
              <NodeConfigView mode="live" node={selected || liveNode} />
            </div>
          ) : sideTab === "config" ? (
            <>
              <div className="ops-side-body ops-side-body--kv">
                <NodeConfigView
                  mode="config"
                  configProps={{
                    draft: configDraft,
                    live: liveConfig,
                    onChange: onConfigChange,
                    onReset: onConfigReset,
                    onRemesh,
                    remeshBusy,
                    remeshMsg,
                    keepSnapshots,
                    onKeepSnapshots: setKeepSnapshots,
                  }}
                />
              </div>
              <div className="ops-side-foot">
                <button
                  type="button"
                  disabled={!configDirty || remeshBusy}
                  onClick={onConfigReset}
                  title="Revert draft to live running values"
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={remeshBusy}
                  onClick={() => onRemesh({ keep_snapshots: keepSnapshots })}
                  title="Write mesh-config.env and run mesh_up.sh"
                >
                  {remeshBusy ? "Restarting…" : "Restart"}
                </button>
              </div>
            </>
          ) : sideTab === "data" ? (
            <>
              <div className="ops-side-body">
                <label className="field field--emphasis">
                  collection
                  <input
                    list="ops-dvf-collections"
                    value={dvfCollection}
                    onChange={(e) => setDvfCollection(e.target.value)}
                    spellCheck={false}
                  />
                  <datalist id="ops-dvf-collections">
                    {COLLECTION_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </datalist>
                </label>
                <div className="ops-data-grid">
                  <label className="field">
                    year
                    <select
                      value={dvfYear}
                      onChange={(e) => setDvfYear(e.target.value)}
                    >
                      {["2019", "2020", "2021", "2022", "2023", "2024", "2025"].map(
                        (y) => (
                          <option key={y} value={y}>
                            {y}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label className="field">
                    route
                    <select
                      value={dvfRoute}
                      onChange={(e) => setDvfRoute(e.target.value)}
                    >
                      <option value="xor">xor</option>
                      <option value="rr">rr</option>
                    </select>
                  </label>
                </div>
                {dvfMsg ? <div className="status-line">{dvfMsg}</div> : null}
              </div>
              <div className="ops-side-foot">
                <button
                  type="button"
                  className="primary"
                  disabled={busy || loadRunning}
                  onClick={onLoadDvf}
                  title="Load DVF into this collection (created on first write)"
                >
                  {loadRunning ? "Loading…" : "Load Collection"}
                </button>
                {!loadRunning ? (
                  <button
                    type="button"
                    className="danger"
                    disabled={busy || !dvfCollection.trim()}
                    onClick={onDeleteCollection}
                    title="Delete this collection from every live node and S3"
                  >
                    Delete collection
                  </button>
                ) : null}
                {loadRunning ? (
                  <>
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      onClick={onPauseResumeDvf}
                      title={
                        loadPaused
                          ? "Resume insertions"
                          : "Pause insertions (mesh keeps running)"
                      }
                    >
                      {loadPaused ? "Resume" : "Pause"}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      onClick={onStopDvf}
                      title="Abort load (cannot resume)"
                    >
                      Stop
                    </button>
                  </>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="ops-side-body">
                <div className="status-line">
                  {snaps.available === false
                    ? snaps.error
                      ? `store · ${snaps.error}`
                      : "store · not attached"
                    : snapStatus === "—"
                      ? `${objs.length} object${objs.length === 1 ? "" : "s"}`
                      : snapStatus}
                </div>
                <div className="snap-list-wrap scroll-fade" ref={snapsScrollRef}>
                  {snaps.available === false ? (
                    <div className="snap-row snap-row--empty">
                      <span>no object store</span>
                    </div>
                  ) : (
                    <SnapshotsBrowser
                      objects={objs}
                      onPathChange={setSnapshotPrefix}
                    />
                  )}
                </div>
              </div>
              <div className="ops-side-foot">
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={onFlush}
                  title="Save snapshots for every live node"
                >
                  Save all
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={onClear}
                  title={
                    snapshotPrefix
                      ? `Delete objects under ${snapshotPrefix}/`
                      : "Delete all snapshot objects"
                  }
                >
                  {snapshotPrefix ? "Delete folder" : "Delete all"}
                </button>
              </div>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
