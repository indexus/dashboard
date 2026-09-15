#!/usr/bin/env node
/**
 * Open-loop, rate-limited density writer.
 *
 * Multiple processes preserve one global density distribution by consuming
 * interleaved CSV rows (WRITER_INDEX, WRITER_COUNT). The requested RPS is an
 * offered rate, unlike a closed-loop concurrency benchmark.
 */
import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import zlib from "zlib";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { createRouter, p2pScheme } from "../lib/mesh_route.js";

const require = createRequire(import.meta.url);
const { Collection, Space } = require("js-indexus-sdk");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BOOT = (process.env.BOOT || "127.0.0.1")
  .replace(/^https?:\/\//, "")
  .split(":")[0];

function writerSeeds() {
  const scheme = p2pScheme();
  const bases = [`${scheme}://${BOOT}:21000`];
  const ports = String(process.env.INDEXUS_LOAD_PORTS || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  for (const port of ports) {
    const base = `${scheme}://${BOOT}:${port}`;
    if (!bases.includes(base)) bases.push(base);
  }
  return bases;
}
const TOKEN = process.env.TOKEN || "";
const RPS = Number(process.env.RPS || "100");
const RPS_START = Number(process.env.RPS_START || process.env.RPS || "100");
const RPS_END = Number(process.env.RPS_END || process.env.RPS || String(RPS_START));
const DURATION_S = Number(process.env.DURATION_S || "30");
const WRITER_INDEX = Number(process.env.WRITER_INDEX || "0");
const WRITER_COUNT = Number(process.env.WRITER_COUNT || "1");
const DATA_SHARDS = Number(process.env.DATA_SHARDS || String(WRITER_COUNT));
const DATA_SHARD_INDEX = Number(
  process.env.DATA_SHARD_INDEX || String(WRITER_INDEX % DATA_SHARDS)
);
const DATA_OFFSET = Number(process.env.DATA_OFFSET || "0");
const COLLECTION = (process.env.COLLECTION || "SmoothPeak000001").slice(0, 16);
const PRECISION = Number(process.env.LOC_PRECISION || "12");
const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT || "2048");
const RETRIES = Number(process.env.RETRIES || "2");
const WRITE_MODE = (process.env.INDEXUS_CLIENT_WRITE_MODE || "forward").toLowerCase();
const CLIENT_ROUTE = (process.env.INDEXUS_CLIENT_ROUTE || "xor").toLowerCase();
const SPREAD_HOPS = CLIENT_ROUTE === "rr" || CLIENT_ROUTE === "spread";
// XOR tables stay boot-filled + 201 hints. Spread needs a live walk or HTTP
// stays on the bootstrap seed after PreferNear joiners appear.
const ROUTE_REFRESH_MS = Number(
  process.env.INDEXUS_ROUTE_REFRESH_MS || (SPREAD_HOPS ? "5000" : "0")
);
// 201 X-Indexus-Ingress-* stick the last owner into the hop table (PreferNear
// magnet). INDEXUS_ADOPT_HINTS=0 keeps pick() on XOR of the discovered table.
const ADOPT_HINTS = !["0", "false", "no"].includes(
  String(process.env.INDEXUS_ADOPT_HINTS || "1").toLowerCase()
);
const RAMP_SECONDS_ENV = Number(process.env.RAMP_SECONDS || "0");
const RUN_ID = process.env.RUN_ID || Date.now().toString(36);
const CSV =
  process.env.DENSITY_CSV ||
  path.join(__dirname, "..", "data", "world_density_100k.csv");

if (!(RPS > 0) || !(DURATION_S > 0)) throw new Error("RPS and DURATION_S must be positive");
if (
  !Number.isInteger(DATA_SHARDS) ||
  DATA_SHARDS < 1 ||
  DATA_SHARD_INDEX < 0 ||
  DATA_SHARD_INDEX >= DATA_SHARDS
) {
  throw new Error("DATA_SHARD_INDEX must be in [0, DATA_SHARDS)");
}
if (WRITER_INDEX < 0 || WRITER_INDEX >= WRITER_COUNT) {
  throw new Error("WRITER_INDEX must be in [0, WRITER_COUNT)");
}

const collection = new Collection(COLLECTION, [
  { name: "gps", type: "spherical", args: [-90, 90, -180, 180] },
]);
const space = new Space(
  collection.dimensions(),
  collection.mask(),
  collection.offset()
);
const agent =
  p2pScheme() === "https"
    ? new https.Agent({
        keepAlive: true,
        maxSockets: MAX_INFLIGHT,
        maxFreeSockets: MAX_INFLIGHT,
        rejectUnauthorized: false,
      })
    : new http.Agent({
        keepAlive: true,
        maxSockets: MAX_INFLIGHT,
        maxFreeSockets: MAX_INFLIGHT,
      });

/** FNV-1a → mulberry32 seed so every writer sharing RUN_ID shuffles alike. */
function seedFrom(runId) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < runId.length; i++) {
    h ^= runId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates in place; same RUN_ID → same order across shards/writers. */
function shuffleInPlace(arr, runId) {
  const rnd = mulberry32(seedFrom(String(runId)));
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function loadPoints() {
  const raw = CSV.endsWith(".gz")
    ? zlib.gunzipSync(fs.readFileSync(CSV)).toString("utf8")
    : fs.readFileSync(CSV, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const start = lines[0].toLowerCase().startsWith("lat") ? 1 : 0;
  const points = [];
  for (let i = start; i < lines.length; i++) {
    const [latRaw, lngRaw] = lines[i].split(",");
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180
    ) {
      points.push([lat, lng]);
    }
  }
  if (!points.length) throw new Error(`no density points in ${CSV}`);
  // Temporal order follows shuffled density — not CSV geography clusters.
  return shuffleInPlace(points, RUN_ID);
}

const points = loadPoints();
const UNIQUE_WRITES =
  process.env.UNIQUE_WRITES === "1" ||
  process.env.UNIQUE_WRITES === "true" ||
  process.env.UNIQUE_WRITES === "yes";
// Cycling mode revisits a fixed working set; unique mode emits one distinct
// (location, id) per sequence — required for 250k+ conservation benches.
const CARDINALITY = UNIQUE_WRITES
  ? 0
  : Number(process.env.CARDINALITY || String(Math.max(points.length, 8000)));
if (!UNIQUE_WRITES && (!Number.isInteger(CARDINALITY) || CARDINALITY < 1)) {
  throw new Error("CARDINALITY must be a positive integer when UNIQUE_WRITES=0");
}

function locationFor(sequence) {
  const globalIndex = sequence * DATA_SHARDS + DATA_SHARD_INDEX;
  const [baseLat, baseLng] = points[globalIndex % points.length];
  // Deterministic tiny jitter prevents duplicate locations over long runs.
  const phase = (globalIndex * 2654435761) >>> 0;
  const lat = baseLat + ((phase % 1000) / 1000 - 0.5) * 0.01;
  const lng = baseLng + (((phase >>> 10) % 1000) / 1000 - 0.5) * 0.01;
  return space.encode([space.dimension(0).newPoint([lat, lng])], PRECISION);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function post(base, body) {
  return new Promise((resolve) => {
    const url = new URL(`${base}/item`);
    const payload = JSON.stringify(body);
    const started = performance.now();
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      "Content-Length": Buffer.byteLength(payload),
    };
    if (WRITE_MODE === "redirect") {
      headers["X-Indexus-Write-Mode"] = "redirect";
    }
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        agent,
        headers,
        timeout: 5000,
        rejectUnauthorized: false,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          if (raw.length < 2048) raw += chunk;
        });
        res.on("end", () => {
          let parsed = {};
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = { error: raw.slice(0, 120) };
          }
          resolve({
            status: res.statusCode || 0,
            error: parsed.error || "",
            redirect_name: parsed.redirect_name || "",
            redirect_ip: parsed.redirect_ip || "",
            redirect_port: parsed.redirect_port || 0,
            ingress_name: res.headers["x-indexus-ingress-name"] || "",
            ingress_ip: res.headers["x-indexus-ingress-ip"] || "",
            ingress_port: Number(res.headers["x-indexus-ingress-port"] || 0),
            latencyMs: performance.now() - started,
          });
        });
      }
    );
    req.on("error", (error) =>
      resolve({
        status: 0,
        error: error.code || error.message,
        latencyMs: performance.now() - started,
      })
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(payload);
  });
}

const router = createRouter(writerSeeds(), {
  token: TOKEN,
  route: CLIENT_ROUTE,
});

const counters = {
  offered: 0,
  accepted: 0,
  failed: 0,
  retries: 0,
  dropped: 0,
};
const statuses = new Map();
const errors = new Map();
const hops = new Map();
const latencies = [];
let inflight = 0;

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

async function send(sequence) {
  inflight++;
  const dataSequence = UNIQUE_WRITES
    ? sequence + DATA_OFFSET
    : (sequence + DATA_OFFSET) % CARDINALITY;
  const location = locationFor(dataSequence);
  const itemId = UNIQUE_WRITES
    ? `${RUN_ID}-${DATA_SHARD_INDEX}-${sequence}`
    : `${RUN_ID}-${DATA_SHARD_INDEX}-${dataSequence}`;
  const body = {
    item: {
      collection: COLLECTION,
      location,
      id: itemId,
      metrics: [1, 0, 0, 1, 1],
    },
    root: "@",
    current: location,
  };

  try {
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      const base = await router.pick(COLLECTION, location);
      const result = await post(base, body);
      increment(statuses, String(result.status));
      increment(hops, base);
      if (result.status === 201) {
        counters.accepted++;
        latencies.push(result.latencyMs);
        if (
          ADOPT_HINTS &&
          result.ingress_ip &&
          result.ingress_name
        ) {
          router.adoptHint(COLLECTION, location, {
            name: result.ingress_name,
            ip: result.ingress_ip,
            port: result.ingress_port,
          });
        }
        return;
      }
      if (result.status === 421 && result.redirect_ip) {
        counters.retries++;
        router.adoptRedirect({
          name: result.redirect_name,
          ip: result.redirect_ip,
          port: result.redirect_port,
        });
        // The redirect is an authoritative, immediately usable owner hint.
        // A full discovery walk here makes every concurrent wrong-route write
        // wait on the same expensive refresh and can exhaust MAX_INFLIGHT.
        continue;
      }
      increment(errors, result.error || `HTTP_${result.status}`);
      if (attempt === RETRIES) break;
      counters.retries++;
      if (result.status === 0) {
        router.dropPeer(base);
        await router.forceRefresh();
      } else {
        router.markHot(base, 300 + attempt * 500);
        if (attempt > 0) await router.forceRefresh();
      }
      await sleep(100 + Math.random() * 100 + attempt * 200);
    }
    counters.failed++;
  } finally {
    inflight--;
  }
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

await router.forceRefresh();
const initialPeers = await router.peers();
const started = performance.now();
const endAt = started + DURATION_S * 1000;
let sequence = 0;
let nextDue = started;

function targetRps(elapsedS) {
  if (RPS_END === RPS_START || DURATION_S <= 0) return RPS_END;
  const rampS =
    RAMP_SECONDS_ENV > 0 && RAMP_SECONDS_ENV < DURATION_S
      ? RAMP_SECONDS_ENV
      : DURATION_S;
  if (elapsedS >= rampS) return RPS_END;
  return RPS_START + (RPS_END - RPS_START) * (elapsedS / rampS);
}

console.log(
  JSON.stringify({
    event: "writer_start",
    writer: WRITER_INDEX,
    writers: WRITER_COUNT,
    data_shards: DATA_SHARDS,
    data_shard: DATA_SHARD_INDEX,
    data_offset: DATA_OFFSET,
    rps: RPS,
    rps_start: RPS_START,
    rps_end: RPS_END,
    duration_s: DURATION_S,
    collection: COLLECTION,
    cardinality: UNIQUE_WRITES ? null : CARDINALITY,
    unique_writes: UNIQUE_WRITES,
    points: points.length,
    run_id: RUN_ID,
    shuffle: "fisher_yates_run_id",
    write_mode: WRITE_MODE,
    client_route: CLIENT_ROUTE,
    route_refresh_ms: ROUTE_REFRESH_MS,
    adopt_hints: ADOPT_HINTS,
    ramp_seconds: RAMP_SECONDS_ENV || DURATION_S,
    peers: initialPeers.length,
  })
);

let lastTickAt = started;
let lastPeerRefresh = started;
let peerCount = initialPeers.length;
const TICK_EVERY_MS = 2000;

while (performance.now() < endAt) {
  const now = performance.now();
  const elapsedS = (now - started) / 1000;
  const currentTarget = targetRps(elapsedS);
  if (now - lastTickAt >= TICK_EVERY_MS) {
    lastTickAt = now;
    console.log(
      JSON.stringify({
        event: "writer_tick",
        writer: WRITER_INDEX,
        elapsed_s: Number(elapsedS.toFixed(2)),
        target_rps: Number(currentTarget.toFixed(1)),
        offered: counters.offered,
        accepted: counters.accepted,
        failed: counters.failed,
        retries: counters.retries,
        dropped: counters.dropped,
        inflight,
        offered_rps: Number((counters.offered / Math.max(elapsedS, 0.001)).toFixed(1)),
        accepted_rps: Number((counters.accepted / Math.max(elapsedS, 0.001)).toFixed(1)),
        peers: peerCount,
      })
    );
    try {
      fs.writeFileSync(
        "/tmp/indexus-writer-progress.json",
        JSON.stringify({
          writer: WRITER_INDEX,
          elapsed_s: Number(elapsedS.toFixed(2)),
          target_rps: Number(currentTarget.toFixed(1)),
          offered: counters.offered,
          accepted: counters.accepted,
          dropped: counters.dropped,
          inflight,
          offered_rps: Number((counters.offered / Math.max(elapsedS, 0.001)).toFixed(1)),
          accepted_rps: Number((counters.accepted / Math.max(elapsedS, 0.001)).toFixed(1)),
          peers: peerCount,
        })
      );
    } catch {
      // progress file is best-effort for the sampler
    }
  }
  if (ROUTE_REFRESH_MS > 0 && now - lastPeerRefresh >= ROUTE_REFRESH_MS) {
    lastPeerRefresh = now;
    void router.forceRefresh().then(async () => {
      peerCount = (await router.peers()).length;
    });
  }
  const intervalMs = 1000 / Math.max(currentTarget, 0.001);
  if (now < nextDue) {
    await sleep(Math.min(5, nextDue - now));
    continue;
  }
  // Do not turn scheduler lag into a destructive catch-up burst.
  if (now - nextDue > 250) nextDue = now;
  if (inflight >= MAX_INFLIGHT) {
    counters.dropped++;
    sequence++;
    nextDue += intervalMs;
    continue;
  }
  counters.offered++;
  void send(sequence++);
  nextDue += intervalMs;
}

const drainDeadline = performance.now() + 15000;
while (inflight > 0 && performance.now() < drainDeadline) await sleep(25);

const elapsedS = (performance.now() - started) / 1000;
const actualOfferedRps = counters.offered / Math.max(elapsedS, 0.001);
const finalPeers = await router.peers();
agent.destroy();
console.log(
  JSON.stringify({
    event: "writer_result",
    writer: WRITER_INDEX,
    writers: WRITER_COUNT,
    elapsed_s: Number(elapsedS.toFixed(3)),
    offered_rps: Number(actualOfferedRps.toFixed(1)),
    target_avg_rps: Number(
      (RPS_END === RPS_START ? RPS_END : (RPS_START + RPS_END) / 2).toFixed(1)
    ),
    rps_start: RPS_START,
    rps_end: RPS_END,
    accepted_rps: Number((counters.accepted / elapsedS).toFixed(1)),
    unique_writes: UNIQUE_WRITES,
    cardinality: UNIQUE_WRITES ? null : CARDINALITY,
    ...counters,
    peers: finalPeers.length,
    p50_ms: Number(percentile(latencies, 0.5).toFixed(2)),
    p95_ms: Number(percentile(latencies, 0.95).toFixed(2)),
    p99_ms: Number(percentile(latencies, 0.99).toFixed(2)),
    statuses: Object.fromEntries(statuses),
    errors: Object.fromEntries(
      [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    ),
    hops: Object.fromEntries(
      [...hops.entries()].sort((a, b) => b[1] - a[1])
    ),
  })
);
