#!/usr/bin/env node
/**
 * Indexus mesh dashboard — protocol-only ops console.
 *
 * Talks to Indexus monitoring (:19000) and issuer (:22000). No AWS CLI.
 *
 *   BOOT_IP=127.0.0.1 node server.js
 *   open http://127.0.0.1:3847/
 *
 * Env:
 *   BOOT_IP       bootstrap IP (default: probe 127.0.0.1)
 *   ISSUER_URL    issuer base URL (default http://{BOOT_IP}:22000)
 *   MON_PORT      monitoring port, default 19000
 *   PORT          dashboard listen port, default 3847
 *   POLL_MS       server-side poll interval, default 3000
 *   HISTORY_MS    rolling sample window, default 12m
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn as spawnProc } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DVF_GEO_COLLECTION,
  DVF_PURCHASE_COLLECTION,
  defaultDvfDataDir,
  loadDvfPurchases,
} from "./lib/dvfLoader.js";
import {
  MESH_CONFIG_DEFAULTS,
  meshConfigEqual,
  meshConfigFromEnvText,
  meshConfigFromNode,
  meshConfigToEnv,
  normalizeMeshConfig,
} from "./lib/meshConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "dist");
const PUBLIC = path.join(__dirname, "public");
const CORE_ROOT = process.env.INDEXUS_CORE_ROOT
  ? path.resolve(process.env.INDEXUS_CORE_ROOT)
  : path.resolve(__dirname, "../core");
const LOCAL_SPAWNED_DIR = path.join(CORE_ROOT, ".data-local", "spawned");
const LOCAL_TERMINATE = path.join(CORE_ROOT, "scripts", "local", "terminate.sh");
const LOCAL_MESH_UP = path.join(CORE_ROOT, "scripts", "local", "mesh_up.sh");
const LOCAL_KEYS_DIR = path.join(CORE_ROOT, ".data-local", "keys");
const MESH_CONFIG_PATH = path.join(CORE_ROOT, ".data-local", "mesh-config.env");
const P2P_PORT = parseInt(process.env.P2P_PORT || "21000", 10);

/** @type {{ running: boolean, startedAt: number|null, log: string, error: string|null, ok: boolean|null }} */
const remeshJob = {
  running: false,
  startedAt: null,
  log: "",
  error: null,
  ok: null,
};

/** @type {{ running: boolean, abort: boolean, progress: object|null, result: object|null, error: string|null, startedAt: number|null }} */
const dvfJob = {
  running: false,
  abort: false,
  progress: null,
  result: null,
  error: null,
  startedAt: null,
};

function staticRoot() {
  if (process.env.NODE_ENV === "production") return DIST;
  if (fs.existsSync(path.join(DIST, "index.html"))) return DIST;
  return PUBLIC;
}

const MON_PORT = parseInt(process.env.MON_PORT || "19000", 10);
const PORT = parseInt(process.env.PORT || "3847", 10);
const POLL_MS = parseInt(process.env.POLL_MS || "3000", 10);
const HISTORY_MS = parseInt(process.env.HISTORY_MS || String(12 * 60 * 1000), 10);

let bootIp = process.env.BOOT_IP || "";
let issuerURL = (process.env.ISSUER_URL || "").replace(/\/$/, "");
let cache = null;
let pollError = null;
/** @type {Array<Record<string, unknown>>} */
const history = [];

function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "localhost" || ip === "::1";
}

function resolveIssuer() {
  if (issuerURL) return issuerURL;
  if (bootIp) return `http://${bootIp}:22000`;
  return "";
}

async function fetchJson(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(body?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

async function postJson(url, payload, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(body?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

/** Run scripts/local/terminate.sh with LEAVE=0 (no SoftLeave). */
function runLocalTerminate(instanceId) {
  return new Promise((resolve, reject) => {
    const child = spawnProc(LOCAL_TERMINATE, [instanceId], {
      env: { ...process.env, LEAVE: "0" },
      cwd: CORE_ROOT,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }
      reject(
        new Error(
          stderr.trim() || stdout.trim() || `terminate.sh exited ${code}`,
        ),
      );
    });
  });
}

function readMeshConfigFile() {
  try {
    if (!fs.existsSync(MESH_CONFIG_PATH)) return null;
    return meshConfigFromEnvText(fs.readFileSync(MESH_CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeMeshConfigFile(cfg) {
  const normalized = normalizeMeshConfig(cfg);
  fs.mkdirSync(path.dirname(MESH_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(MESH_CONFIG_PATH, meshConfigToEnv(normalized), "utf8");
  return normalized;
}

function liveMeshConfig() {
  const nodes = cache?.nodes || [];
  const boot =
    nodes.find((n) => n.up && n.role === "bootstrap") ||
    nodes.find((n) => n.up) ||
    null;
  return meshConfigFromNode(boot);
}

function startRemesh({ keepSnapshots = true } = {}) {
  if (remeshJob.running) {
    const err = new Error("remesh already running");
    err.status = 409;
    throw err;
  }
  if (!fs.existsSync(LOCAL_MESH_UP)) {
    const err = new Error("mesh_up.sh not found");
    err.status = 503;
    throw err;
  }
  remeshJob.running = true;
  remeshJob.startedAt = Date.now();
  remeshJob.log = "";
  remeshJob.error = null;
  remeshJob.ok = null;

  const child = spawnProc("bash", [LOCAL_MESH_UP], {
    cwd: CORE_ROOT,
    env: {
      ...process.env,
      KEEP_SNAPSHOTS: keepSnapshots ? "1" : "0",
      MESH_CONFIG: MESH_CONFIG_PATH,
    },
  });
  const append = (buf) => {
    remeshJob.log = (remeshJob.log + buf.toString()).slice(-24000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (e) => {
    remeshJob.running = false;
    remeshJob.ok = false;
    remeshJob.error = e.message || String(e);
  });
  child.on("close", (code) => {
    remeshJob.running = false;
    remeshJob.ok = code === 0;
    if (code !== 0) {
      remeshJob.error =
        remeshJob.error ||
        `mesh_up.sh exited ${code}`;
    }
  });
  return remeshJob;
}

async function probeLocalBoot() {
  try {
    await fetchJson(`http://127.0.0.1:${MON_PORT}/health`, 1500);
    return "127.0.0.1";
  } catch {
    return "";
  }
}

/** Optional local-lab mon port map from spawn metadata (not AWS). */
function localMonByIP() {
  /** @type {Map<string, { mon: number, id: string, prefer_near: string|null }>} */
  const map = new Map();
  try {
    if (!fs.existsSync(LOCAL_SPAWNED_DIR)) return map;
    for (const name of fs.readdirSync(LOCAL_SPAWNED_DIR)) {
      if (!name.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(LOCAL_SPAWNED_DIR, name), "utf8"));
        const ip = meta.ip || meta.public_ip || "127.0.0.1";
        const mon = parseInt(meta.mon || meta.mon_port || MON_PORT, 10);
        map.set(ip === "0.0.0.0" ? "127.0.0.1" : ip, {
          mon: Number.isFinite(mon) ? mon : MON_PORT,
          id: meta.id || meta.name || name.replace(/\.json$/, ""),
          prefer_near: meta.prefer_near || meta.PreferNear || null,
        });
        // Local spawned often share loopback with distinct mon ports — key by mon too.
        if (meta.mon || meta.mon_port) {
          map.set(`127.0.0.1:${mon}`, {
            mon,
            id: meta.id || meta.name || name.replace(/\.json$/, ""),
            prefer_near: meta.prefer_near || meta.PreferNear || null,
          });
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return map;
}

function parseHost(h) {
  if (typeof h !== "string") return null;
  const m = h.match(/^([^@]+)@([^|]+)\|(\d+)/);
  if (!m) return null;
  return { name: m[1], ip: m[2], p2p: parseInt(m[3], 10) };
}

/** Local convention: mon 19000 → p2p 21000 (offset +2000). */
function p2pFromMon(mon) {
  if (mon == null || Number.isNaN(Number(mon))) return P2P_PORT;
  return Number(mon) + 2000;
}

function round1(v) {
  if (v == null || Number.isNaN(Number(v))) return null;
  return Math.round(Number(v) * 10) / 10;
}

/** Matches core/encoding BASE64.IDLength() (NewBase(64, 96)). */
const BASE64_ID_LEN = 16;

/** Pad a zone location / PreferNear id to full BASE64 length. */
function locationToNearKey(location) {
  if (location == null || location === "" || location === "@") return "";
  let key = String(location);
  while (key.length < BASE64_ID_LEN) key += "0";
  if (key.length > BASE64_ID_LEN) key = key.slice(0, BASE64_ID_LEN);
  return key;
}

/**
 * PreferNear hint for manual spawn: last load-split decision → node name.
 */
async function resolvePreferNear(ip, mon, fallbackName = "") {
  try {
    const status = await fetchJson(`http://${ip}:${mon}/status`, 3500);
    const a = status?.autoscale || {};
    if (a.last_prefer_near) {
      return {
        prefer_near: a.last_prefer_near,
        source: "load_split",
      };
    }
  } catch (_) {
    /* fall through */
  }
  const nameKey = locationToNearKey(fallbackName) || fallbackName || "";
  return {
    prefer_near: nameKey,
    source: nameKey ? "name" : "empty",
  };
}

function nodeFromStatus(ip, status, monPort, extra = {}) {
  const p2p = extra.p2p || p2pFromMon(monPort);
  if (!status) {
    return {
      ip,
      mon: monPort,
      p2p,
      host: `${ip}|${p2p}`,
      up: false,
      name: extra.name || null,
      role: extra.role || null,
      instance_id: extra.instance_id || null,
      prefer_near: extra.prefer_near || null,
      prefer_near_key: null,
    };
  }
  const a = status.autoscale || {};
  const p = a.pressure || {};
  const snap = status.snapshot || {};
  const preferNearKey = a.last_prefer_near || null;
  return {
    ip,
    mon: monPort,
    p2p,
    host: `${ip}|${p2p}`,
    up: true,
    local: isLoopback(ip),
    name: status.name || extra.name || null,
    role: a.role || extra.role || null,
    version: status.version || null,
    collections: status.collections ?? null,
    items: status.items ?? null,
    items_prep: status.items_prep ?? 0,
    zones: status.zones ?? null,
    peers: status.peers ?? null,
    queue: p.queue ?? status.queue ?? null,
    hot_signal: p.hot_signal || "",
    /** Last load-split PreferNear (weighted zone dichotomy). */
    prefer_near_key: preferNearKey,
    cpu_pct: round1(p.cpu_pct),
    mem_pct: round1(p.mem_pct),
    mem_projected: round1(p.mem_projected),
    inserts_window: p.inserts_window ?? a.inserts_window ?? null,
    last_reason: a.last_reason || "",
    scale_ups_done: a.scale_ups_done ?? 0,
    up_in_flight: !!a.up_in_flight,
    down_in_flight: !!a.down_in_flight,
    leaving: !!status.leaving,
    client_ready: status.client_ready !== false,
    rebalancing: !!status.rebalancing,
    /** S3 / DirStore snapshot-delegation protocol enabled (bool). */
    delegation: snap.delegation ?? null,
    /** Soft item count before Own split (-delegation / INDEXUS_DELEGATION). */
    delegation_size: snap.delegation_size ?? null,
    /** Zones at/above this count use snapshot handoff (INDEXUS_TRANSFER_THRESHOLD). */
    transfer_threshold: snap.transfer_threshold ?? null,
    delegation_timeout: snap.delegation_timeout ?? null,
    transfer_timeout: snap.transfer_timeout ?? null,
    deleg_in: snap.deleg_in ?? 0,
    deleg_out: snap.deleg_out ?? 0,
    transferring:
      !!status.rebalancing ||
      (snap.deleg_in ?? 0) > 0 ||
      (snap.deleg_out ?? 0) > 0,
    store: !!snap.store,
    snap_dirty: snap.dirty ?? 0,
    snap_zones: snap.snapped ?? 0,
    wal_segments: snap.wal_segments ?? 0,
    uptime_s: status.uptime_s ?? null,
    instance_id: extra.instance_id || null,
    prefer_near: a.last_prefer_near || extra.prefer_near || null,
    mem_limit_pct: a.mem_limit_pct ?? null,
    cpu_limit_pct: a.cpu_limit_pct ?? null,
    // Full autoscale snapshot for the Node config tab (thresholds, holds, …).
    autoscale: a,
  };
}

async function discoverPeerTargets(boot) {
  /** @type {Array<{ ip: string, mon: number, p2p?: number, name?: string, instance_id?: string, prefer_near?: string|null, role?: string }>} */
  const targets = [
    { ip: boot, mon: MON_PORT, p2p: P2P_PORT, role: "bootstrap" },
  ];
  const local = localMonByIP();

  try {
    const reg = await fetchJson(`http://${boot}:${MON_PORT}/registered`, 3000);
    const hosts = Array.isArray(reg) ? reg : reg?.hosts || [];
    for (const h of hosts) {
      const parsed = parseHost(h);
      if (!parsed?.ip || !parsed.p2p) continue;
      const ip = isLoopback(parsed.ip) ? "127.0.0.1" : parsed.ip;
      const p2p = parsed.p2p;
      // Prefer p2p from /registered; mon = p2p - 2000 locally (or look up spawn meta by mon).
      const monFromP2p = p2p - 2000;
      const meta =
        local.get(`${ip}:${monFromP2p}`) ||
        (!isLoopback(ip) ? local.get(ip) : null);
      const mon = meta?.mon || monFromP2p;

      const existing = targets.find((t) => t.ip === ip && t.p2p === p2p);
      if (existing) {
        if (parsed.name && !existing.name) existing.name = parsed.name;
        if (meta?.id && !existing.instance_id) existing.instance_id = meta.id;
        continue;
      }
      // Same mon collision (should not happen) — skip only if identical
      if (targets.some((t) => t.ip === ip && t.mon === mon && t.p2p === p2p)) continue;

      targets.push({
        ip,
        mon,
        p2p,
        name: parsed.name,
        instance_id: meta?.id || null,
        prefer_near: meta?.prefer_near || null,
        role:
          mon === MON_PORT && (ip === boot || isLoopback(ip))
            ? "bootstrap"
            : "spawned",
      });
    }
  } catch {
    /* ignore */
  }

  // Local spawned not yet in /registered
  for (const [key, meta] of local) {
    if (!key.includes(":")) continue;
    const mon = meta.mon;
    const p2p = p2pFromMon(mon);
    if (targets.some((t) => t.ip === "127.0.0.1" && t.p2p === p2p)) continue;
    targets.push({
      ip: "127.0.0.1",
      mon,
      p2p,
      instance_id: meta.id,
      prefer_near: meta.prefer_near,
      role: "spawned",
    });
  }

  return targets;
}

async function sampleMesh() {
  if (!bootIp) {
    bootIp = await probeLocalBoot();
  }
  if (!bootIp) {
    pollError = "no bootstrap — set BOOT_IP or start a local mesh on :19000";
    cache = {
      ts: new Date().toISOString(),
      boot: null,
      issuer: resolveIssuer(),
      error: pollError,
      nodes: [],
      snapshots: { available: false, objects: [] },
      totals: { answering: 0, items: 0, queue: 0, scale_ups: 0 },
      history: [],
    };
    return cache;
  }

  const targets = await discoverPeerTargets(bootIp);
  const statuses = await Promise.all(
    targets.map(async (t) => {
      try {
        const status = await fetchJson(`http://${t.ip}:${t.mon}/status`, 3500);
        return { t, status, err: null };
      } catch (e) {
        return { t, status: null, err: String(e.message || e) };
      }
    }),
  );

  const nodes = statuses.map(({ t, status }) =>
    nodeFromStatus(t.ip, status, t.mon, {
      name: t.name,
      instance_id: t.instance_id,
      prefer_near: t.prefer_near,
      role: t.role,
      p2p: t.p2p || p2pFromMon(t.mon),
    }),
  );

  let answering = 0;
  let items = 0;
  let queue = 0;
  let scaleUps = 0;
  for (const n of nodes) {
    if (!n.up) continue;
    answering++;
    items += n.items || 0;
    queue += n.queue || 0;
    scaleUps += n.scale_ups_done || 0;
  }

  let issuerHealth = null;
  const issuer = resolveIssuer();
  if (issuer) {
    try {
      issuerHealth = await fetchJson(`${issuer}/health`, 2000);
    } catch (e) {
      issuerHealth = { error: String(e.message || e) };
    }
  }

  let snapshots = { available: false, objects: [] };
  try {
    snapshots = await fetchJson(`http://${bootIp}:${MON_PORT}/snapshots`, 5000);
  } catch (e) {
    snapshots = { available: false, error: String(e.message || e), objects: [] };
  }

  const bootNode = nodes.find((n) => n.ip === bootIp && n.mon === MON_PORT && n.up);
  const sample = {
    ts: Date.now(),
    answering,
    items,
    queue,
    scale_ups: scaleUps,
    mem_pct: bootNode?.mem_pct ?? null,
    cpu_pct: bootNode?.cpu_pct ?? null,
    mem_limit_pct: bootNode?.mem_limit_pct ?? null,
    cpu_limit_pct: bootNode?.cpu_limit_pct ?? null,
  };
  history.push(sample);
  const cutoff = Date.now() - HISTORY_MS;
  while (history.length && history[0].ts < cutoff) history.shift();

  pollError = answering === 0 ? "no nodes answering" : null;
  const hosts = [
    ...new Set(
      nodes
        .filter((n) => n.up && n.host)
        .map((n) => n.host),
    ),
  ];
  cache = {
    ts: new Date().toISOString(),
    boot: bootIp,
    issuer,
    issuer_health: issuerHealth,
    error: pollError,
    bootstrap: bootIp ? `${bootIp}|${P2P_PORT}` : null,
    hosts,
    nodes,
    snapshots,
    totals: { answering, items, queue, scale_ups: scaleUps },
    history: history.map((h) => ({ ...h })),
    autoscale: bootNode
      ? {
          mem_limit_pct: bootNode.mem_limit_pct,
          cpu_limit_pct: bootNode.cpu_limit_pct,
        }
      : null,
  };
  return cache;
}

async function pollLoop() {
  for (;;) {
    try {
      await sampleMesh();
    } catch (e) {
      pollError = String(e.message || e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJSON(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (url === "/api/mesh" && req.method === "GET") {
      if (!cache) await sampleMesh();
      return sendJSON(res, 200, cache || { error: "warming" });
    }

    if (url === "/api/health" && req.method === "GET") {
      return sendJSON(res, 200, {
        ok: true,
        boot: bootIp || null,
        issuer: resolveIssuer(),
        mon_port: MON_PORT,
        p2p_port: P2P_PORT,
        bootstrap: bootIp ? `${bootIp}|${P2P_PORT}` : null,
        poll_error: pollError,
        static_root: path.basename(staticRoot()),
      });
    }

    if (url === "/api/prefer-near" && req.method === "GET") {
      const q = new URL(req.url || "/", "http://local").searchParams;
      const ip = q.get("ip") || bootIp || "127.0.0.1";
      const mon = parseInt(q.get("mon") || String(MON_PORT), 10) || MON_PORT;
      const fallback =
        q.get("name") ||
        (cache?.nodes || []).find((n) => n.ip === ip && n.mon === mon)?.name ||
        "";
      try {
        const out = await resolvePreferNear(ip, mon, fallback);
        return sendJSON(res, 200, { ip, mon, ...out });
      } catch (e) {
        return sendJSON(res, 502, { error: e.message || String(e) });
      }
    }

    if (url === "/api/token" && req.method === "POST") {
      const issuer = resolveIssuer();
      if (!issuer) return sendJSON(res, 503, { error: "issuer unavailable" });
      const body = await readBody(req).catch(() => ({}));
      const scopes = Array.isArray(body.scopes) && body.scopes.length
        ? body.scopes
        : ["read", "write"];
      try {
        const out = await postJson(`${issuer}/v1/issue/token`, {
          client_id: body.client_id || `mesh-dash-${Date.now()}`,
          scopes,
        });
        return sendJSON(res, 200, out);
      } catch (e) {
        return sendJSON(res, e.status || 502, { error: e.message, detail: e.body || null });
      }
    }

    if (url === "/api/spawn" && req.method === "POST") {
      const body = await readBody(req);
      const issuer = resolveIssuer();
      if (!issuer) return sendJSON(res, 503, { error: "issuer unavailable — set ISSUER_URL or BOOT_IP" });
      const spawnCount = Math.max(1, Math.min(3, parseInt(body.spawn_count || 1, 10) || 1));
      const preferNear = body.prefer_near || "";
      const requester = body.requester_id || (cache?.nodes || []).find((n) => n.up)?.name || "dashboard";
      try {
        const out = await postJson(`${issuer}/v1/scale`, {
          requester_id: requester,
          spawn_count: spawnCount,
          prefer_near: preferNear || requester,
          reason: body.reason || "dashboard",
          local_inserts: 0,
          owned_zones: 0,
        });
        return sendJSON(res, 200, out);
      } catch (e) {
        return sendJSON(res, e.status || 502, { error: e.message, detail: e.body || null });
      }
    }

    if (url === "/api/mesh-config" && req.method === "GET") {
      const live = liveMeshConfig();
      const saved = readMeshConfigFile();
      const draft = saved || live;
      return sendJSON(res, 200, {
        live,
        saved,
        draft,
        defaults: MESH_CONFIG_DEFAULTS,
        dirty: !meshConfigEqual(draft, live),
        path: MESH_CONFIG_PATH,
        remesh: {
          running: remeshJob.running,
          startedAt: remeshJob.startedAt,
          ok: remeshJob.ok,
          error: remeshJob.error,
          log_tail: remeshJob.log.slice(-4000),
        },
      });
    }

    if (url === "/api/mesh-config" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      try {
        const saved = writeMeshConfigFile(body.config || body);
        const live = liveMeshConfig();
        return sendJSON(res, 200, {
          ok: true,
          saved,
          live,
          dirty: !meshConfigEqual(saved, live),
          path: MESH_CONFIG_PATH,
        });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message || String(e) });
      }
    }

    if (url === "/api/remesh" && req.method === "GET") {
      return sendJSON(res, 200, {
        running: remeshJob.running,
        startedAt: remeshJob.startedAt,
        ok: remeshJob.ok,
        error: remeshJob.error,
        log_tail: remeshJob.log.slice(-8000),
      });
    }

    if (url === "/api/remesh" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      try {
        if (body.config) writeMeshConfigFile(body.config);
        else if (!fs.existsSync(MESH_CONFIG_PATH)) {
          writeMeshConfigFile(liveMeshConfig());
        }
        startRemesh({ keepSnapshots: body.keep_snapshots !== false });
        return sendJSON(res, 202, {
          ok: true,
          started: true,
          keep_snapshots: body.keep_snapshots !== false,
          path: MESH_CONFIG_PATH,
          remesh: {
            running: remeshJob.running,
            startedAt: remeshJob.startedAt,
          },
        });
      } catch (e) {
        return sendJSON(res, e.status || 500, { error: e.message || String(e) });
      }
    }

    if (url === "/api/downscale" && req.method === "POST") {
      const body = await readBody(req);
      const issuer = resolveIssuer();
      if (!issuer) return sendJSON(res, 503, { error: "issuer unavailable" });
      if (!body.instance_id) return sendJSON(res, 400, { error: "instance_id required" });
      try {
        const out = await postJson(`${issuer}/v1/downscale`, {
          instance_id: body.instance_id,
          requester_id: body.requester_id || "dashboard",
          reason: body.reason || "dashboard",
        });
        return sendJSON(res, 200, out);
      } catch (e) {
        return sendJSON(res, e.status || 502, { error: e.message, detail: e.body || null });
      }
    }

    // Force-kill local spawned process (LEAVE=0). Use for stuck joining/leaving
    // ghosts when SoftLeave cannot finish. Also drops sticky slot cert/key.
    if (url === "/api/terminate" && req.method === "POST") {
      const body = await readBody(req);
      const id = body.instance_id;
      if (!id || !/^local-\d+$/.test(id)) {
        return sendJSON(res, 400, {
          error: "instance_id required (local-N only)",
        });
      }
      if (!fs.existsSync(LOCAL_TERMINATE)) {
        return sendJSON(res, 503, { error: "terminate.sh not found" });
      }
      try {
        const out = await runLocalTerminate(id);
        // Drop sticky identity so a later PreferNear spawn is not ignored.
        try {
          fs.unlinkSync(path.join(LOCAL_KEYS_DIR, `${id}.ed25519`));
        } catch (_) {}
        try {
          fs.unlinkSync(path.join(LOCAL_KEYS_DIR, `${id}.cert.json`));
        } catch (_) {}
        return sendJSON(res, 200, { ok: true, instance_id: id, ...out });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message || String(e) });
      }
    }

    if (url === "/api/snapshots" && req.method === "GET") {
      if (!bootIp) return sendJSON(res, 503, { error: "no bootstrap" });
      try {
        const out = await fetchJson(`http://${bootIp}:${MON_PORT}/snapshots`, 8000);
        return sendJSON(res, 200, out);
      } catch (e) {
        return sendJSON(res, e.status || 502, { error: e.message });
      }
    }

    if (url === "/api/snapshots/flush" && req.method === "POST") {
      if (!bootIp) return sendJSON(res, 503, { error: "no bootstrap" });
      const body = await readBody(req).catch(() => ({}));
      const all = !!body.all;
      const targets = all && cache?.nodes
        ? cache.nodes.filter((n) => n.up).map((n) => ({ ip: n.ip, mon: n.mon }))
        : [{ ip: bootIp, mon: MON_PORT }];
      const results = [];
      for (const t of targets) {
        try {
          const out = await postJson(`http://${t.ip}:${t.mon}/checkpoint`, {}, 60000);
          results.push({ ip: t.ip, mon: t.mon, ok: true, ...out });
        } catch (e) {
          results.push({ ip: t.ip, mon: t.mon, ok: false, error: e.message });
        }
      }
      return sendJSON(res, 200, { results });
    }

    if (url === "/api/snapshots/clear" && req.method === "POST") {
      if (!bootIp) return sendJSON(res, 503, { error: "no bootstrap" });
      try {
        const out = await postJson(`http://${bootIp}:${MON_PORT}/snapshots/clear`, {}, 60000);
        return sendJSON(res, 200, out);
      } catch (e) {
        return sendJSON(res, e.status || 502, { error: e.message, detail: e.body || null });
      }
    }

    if (url === "/api/dvf/status" && req.method === "GET") {
      return sendJSON(res, 200, {
        running: dvfJob.running,
        progress: dvfJob.progress,
        result: dvfJob.result,
        error: dvfJob.error,
        startedAt: dvfJob.startedAt,
        dataDir: defaultDvfDataDir(),
        collection: DVF_PURCHASE_COLLECTION,
        himoLegacyCollection: DVF_GEO_COLLECTION,
      });
    }

    if (url === "/api/dvf/load" && req.method === "POST") {
      if (dvfJob.running) {
        return sendJSON(res, 409, {
          error: "DVF load already running",
          progress: dvfJob.progress,
        });
      }
      if (!bootIp) return sendJSON(res, 503, { error: "no bootstrap" });
      const body = await readBody(req).catch(() => ({}));
      const full = body.full === true || body.limit === 0 || body.limit === "full";
      const limit = full
        ? null
        : Math.max(
            1,
            Math.min(2_000_000, parseInt(body.limit || 5000, 10) || 5000),
          );
      const collectionId = body.collection || DVF_PURCHASE_COLLECTION;
      const year = body.year ? String(body.year) : "2020";
      const route = body.route === "rr" ? "rr" : "xor";
      const host = body.host || bootIp;
      const ports =
        Array.isArray(body.ports) && body.ports.length
          ? body.ports.map((p) => parseInt(p, 10)).filter((n) => !Number.isNaN(n))
          : [
              ...new Set(
                (cache?.nodes || [])
                  .filter((n) => n.up && n.p2p)
                  .map((n) => n.p2p)
                  .concat([P2P_PORT]),
              ),
            ];
      const issuer = resolveIssuer();
      if (!issuer) return sendJSON(res, 503, { error: "issuer unavailable" });

      let bearer = body.bearer || "";
      if (!bearer) {
        try {
          const tok = await postJson(`${issuer}/v1/issue/token`, {
            client_id: `mesh-dash-dvf-${Date.now()}`,
            scopes: ["read", "write"],
          });
          bearer = tok.token || tok.access_token || tok.bearer || "";
        } catch (e) {
          return sendJSON(res, e.status || 502, {
            error: e.message,
            detail: e.body || null,
          });
        }
      }
      if (!bearer) return sendJSON(res, 502, { error: "no bearer from issuer" });

      dvfJob.running = true;
      dvfJob.abort = false;
      dvfJob.progress = {
        phase: "queued",
        limit: limit ?? "full",
        collectionId,
        year,
        route,
      };
      dvfJob.result = null;
      dvfJob.error = null;
      dvfJob.startedAt = Date.now();

      loadDvfPurchases({
        host,
        ports: ports.length ? ports : [P2P_PORT],
        bearer,
        collectionId,
        year,
        route,
        limit: limit ?? undefined,
        shouldAbort: () => dvfJob.abort,
        onProgress: (info) => {
          dvfJob.progress = info;
        },
      })
        .then((result) => {
          dvfJob.result = result;
          dvfJob.running = false;
        })
        .catch((e) => {
          dvfJob.error = String(e.message || e);
          dvfJob.running = false;
        });

      return sendJSON(res, 202, {
        ok: true,
        message: "DVF load started",
        limit: limit ?? "full",
        year,
        route,
        collectionId,
        host,
        ports,
      });
    }

    // Static files (Vite dist in production, public/ fallback)
    if (req.method === "GET" || req.method === "HEAD") {
      const root = staticRoot();
      let rel = url === "/" ? "/index.html" : url;
      let filePath = path.normalize(path.join(root, rel));
      if (!filePath.startsWith(root)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      // SPA fallback
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(root, "index.html");
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end(
          "UI not built — run: pnpm install && pnpm build  (or pnpm dev for Vite)"
        );
        return;
      }
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { "Content-Type": contentType(filePath) });
      res.end(req.method === "HEAD" ? undefined : data);
      return;
    }

    sendJSON(res, 404, { error: "not found" });
  } catch (e) {
    sendJSON(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Indexus mesh dash → http://127.0.0.1:${PORT}/`);
  console.log(`  BOOT_IP=${bootIp || "(probe local)"} MON_PORT=${MON_PORT}`);
  console.log(`  ISSUER_URL=${resolveIssuer() || "(from BOOT_IP:22000)"}`);
  console.log(`  static: ${staticRoot()}`);
  console.log(
    `  APIs: /api/mesh · /api/token · /api/spawn · /api/downscale · /api/terminate · /api/mesh-config · /api/remesh · /api/snapshots/* · /api/dvf/*`,
  );
  console.log(`  DVF_DATA_DIR=${defaultDvfDataDir()}`);
  pollLoop();
});
