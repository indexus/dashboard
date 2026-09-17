#!/usr/bin/env node
/**
 * Gentle peak campaign with density-aware write distribution.
 * Climbs write load so PreferNearSplit sees real hot prefixes; XOR-routes.
 *
 * Env:
 *   BOOT, TOKEN, TARGET_RPS (5000)
 *   COLLECTION (≤16 chars)
 *   DENSITY_CSV — lat,lng CSV (default ../data/world_density_100k.csv)
 *   RPS_PER_NODE (900), CONC_PER_NODE (48), STEP_SECONDS (20)
 *   SETTLE_MS (20000) — shorter with warm pool
 *   MAX_FAIL_PCT (3)
 */
import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { createRouter } from "../lib/mesh_route.js";

const require = createRequire(import.meta.url);
const { Collection, Space } = require("js-indexus-sdk");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BOOT = (process.env.BOOT || "127.0.0.1").replace(/^https?:\/\//, "").split(":")[0];
const SEED = `http://${BOOT}:21000`;
const TOKEN = process.env.TOKEN || "";
const TARGET = parseInt(process.env.TARGET_RPS || "5000", 10);
const COL = (process.env.COLLECTION || "PeakDensWarm0001").slice(0, 16);
const RPS_PER_NODE = parseInt(process.env.RPS_PER_NODE || "900", 10);
const CONC_PER_NODE = parseInt(process.env.CONC_PER_NODE || "48", 10);
const STEP_SECONDS = parseInt(process.env.STEP_SECONDS || "20", 10);
const SETTLE_MS = parseInt(process.env.SETTLE_MS || "20000", 10);
const MAX_FAIL_PCT = parseFloat(process.env.MAX_FAIL_PCT || "3");
const PRECISION = parseInt(process.env.LOC_PRECISION || "12", 10);
const CSV_PATH =
  process.env.DENSITY_CSV ||
  path.join(__dirname, "..", "data", "world_density_100k.csv");

const collection = new Collection(COL, [
  { name: "gps", type: "spherical", args: [-90, 90, -180, 180] },
]);
const space = new Space(collection.dimensions(), collection.mask(), collection.offset());

function loadDensityPoints(csvPath) {
  if (!fs.existsSync(csvPath)) return null;
  const text = fs.readFileSync(csvPath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const start = lines[0].toLowerCase().startsWith("lat") ? 1 : 0;
  const pts = [];
  for (let i = start; i < lines.length; i++) {
    const [latS, lngS] = lines[i].split(",");
    const lat = parseFloat(latS);
    const lng = parseFloat(lngS);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    pts.push([lat, lng]);
  }
  return pts.length ? pts : null;
}

function encodeLocation(lat, lng) {
  const point = [space.dimension(0).newPoint([lat, lng])];
  return space.encode(point, PRECISION);
}

const densityPts = loadDensityPoints(CSV_PATH);
const FALLBACK_PREFIXES = ["7xmD", "1ZmK", "quW9", "aB3c", "Kp0s", "nR4t", "Xy9w", "mL2e", "pQ8v", "Zs3n"];

function nextLocation(i) {
  if (densityPts && densityPts.length) {
    const [lat0, lng0] = densityPts[i % densityPts.length];
    const lat = lat0 + (Math.random() - 0.5) * 0.02;
    const lng = lng0 + (Math.random() - 0.5) * 0.02;
    return encodeLocation(lat, lng);
  }
  const p = FALLBACK_PREFIXES[i % FALLBACK_PREFIXES.length];
  return p + Math.random().toString(36).slice(2, 6);
}

function post(base, body) {
  return new Promise((resolve) => {
    const u = new URL(base + "/item");
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + TOKEN,
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 8000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on("error", () => resolve(0));
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
    req.write(payload);
    req.end();
  });
}

async function status(ip) {
  return new Promise((resolve) => {
    http
      .get(`http://${ip}:19000/status`, { timeout: 2500 }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(b));
          } catch {
            resolve(null);
          }
        });
      })
      .on("error", () => resolve(null));
  });
}

async function clusterSnap(ips) {
  let sum = 0;
  let nodes = 0;
  let owned = 0;
  let ups = 0;
  const per = [];
  await Promise.all(
    ips.map(async (ip) => {
      const s = await status(ip);
      if (!s) return;
      const a = s.autoscale || {};
      const p = a.pressure || {};
      const r = Number(p.apply_rate || 0);
      sum += r;
      nodes++;
      owned += Number(p.owned_items || 0);
      ups = Math.max(ups, Number(a.scale_ups_done || 0));
      if (r >= 1) per.push(`${ip}:${r.toFixed(0)}`);
    })
  );
  return { sum, nodes, owned, ups, per };
}

async function discoverIps() {
  const ips = new Set([BOOT]);
  for (let i = 0; i < 48; i++) {
    try {
      const data = await new Promise((resolve, reject) => {
        http
          .get(
            `http://${BOOT}:21000/random?origin=AAAAAAAAAAAAAAAAAAAAAA`,
            { headers: { Authorization: "Bearer " + TOKEN }, timeout: 3000 },
            (res) => {
              let b = "";
              res.on("data", (c) => (b += c));
              res.on("end", () => {
                try {
                  resolve(JSON.parse(b));
                } catch (e) {
                  reject(e);
                }
              });
            }
          )
          .on("error", reject);
      });
      const c = data.random || {};
      const ip = c.ip || Object.keys(c.ips || {})[0];
      if (ip) ips.add(ip);
    } catch {
      /* ignore */
    }
  }
  return [...ips];
}

async function hold(pick, concurrency, seconds, label) {
  const tEnd = Date.now() + seconds * 1000;
  let ok = 0;
  let fail = 0;
  let c503 = 0;
  let seq = 0;
  async function worker(wid) {
    while (Date.now() < tEnd) {
      const i = seq++;
      const location = nextLocation(i + wid * 997);
      const base = await pick(COL, location);
      const code = await post(base, {
        item: {
          collection: COL,
          location,
          id: `${wid}-${i}`,
          metrics: [1, 0, 0, 1, 1],
        },
        root: "@",
        current: location,
      });
      if (code === 201) ok++;
      else {
        fail++;
        if (code === 503) c503++;
      }
    }
  }
  const t0 = Date.now();
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  const elapsed = (Date.now() - t0) / 1000;
  return {
    label,
    concurrency,
    seconds,
    elapsed: +elapsed.toFixed(2),
    ok,
    fail,
    c503,
    rps: +(ok / elapsed).toFixed(1),
    fail_pct: +((100 * fail) / Math.max(ok + fail, 1)).toFixed(2),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(
    JSON.stringify({
      event: "start",
      boot: BOOT,
      target_rps: TARGET,
      collection: COL,
      density_csv: densityPts ? CSV_PATH : null,
      density_pts: densityPts ? densityPts.length : 0,
      loc_precision: PRECISION,
      rps_per_node: RPS_PER_NODE,
      conc_per_node: CONC_PER_NODE,
      step_seconds: STEP_SECONDS,
      settle_ms: SETTLE_MS,
      max_fail_pct: MAX_FAIL_PCT,
    })
  );

  const router = createRouter([SEED], {
    token: TOKEN,
    refreshEvery: 24,
    refreshMs: 2000,
  });
  await router.peers();
  await sleep(2500);
  await router.forceRefresh();

  const pickXor = (col, loc) => router.pick(col, loc);
  let best = null;
  let conc = 8;
  let stagnant = 0;

  for (let step = 0; step < 40; step++) {
    await router.forceRefresh();
    let peers = await router.peers();
    if (peers.length < 2) {
      await sleep(3000);
      await router.forceRefresh();
      peers = await router.peers();
    }
    const ips = await discoverIps();
    const n = Math.max(peers.length, 1);
    const softCap = Math.max(8, n * CONC_PER_NODE);
    if (conc > softCap) conc = softCap;

    const before = await clusterSnap(ips);
    const r = await hold(pickXor, conc, STEP_SECONDS, "climb");
    const afterIps = await discoverIps();
    await router.forceRefresh();
    peers = await router.peers();
    const after = await clusterSnap(afterIps);

    const row = {
      event: "step",
      ...r,
      mesh_peers: peers.length,
      ec2_ips: afterIps.length,
      cluster_apply: +after.sum.toFixed(1),
      nodes_ok: after.nodes,
      owned: after.owned,
      scale_ups: after.ups,
      hot: after.per.slice(0, 10),
      soft_cap: softCap,
      before_ups: before.ups,
    };
    console.log(JSON.stringify(row));

    if (r.fail_pct <= MAX_FAIL_PCT && (!best || r.rps > best.rps)) {
      best = { ...row };
      stagnant = 0;
    } else {
      stagnant++;
    }

    if (r.rps >= TARGET && r.fail_pct <= MAX_FAIL_PCT) {
      console.log(JSON.stringify({ event: "target_hit", ...row }));
      break;
    }

    if (r.fail_pct > MAX_FAIL_PCT) {
      const prevPeers = peers.length;
      conc = Math.max(8, Math.floor(conc * 0.7));
      console.log(
        JSON.stringify({
          event: "throttle",
          reason: "fail_pct",
          next_conc: conc,
          settle_ms: SETTLE_MS,
        })
      );
      await sleep(SETTLE_MS);
      await router.forceRefresh();
      const nowPeers = (await router.peers()).length;
      if (nowPeers <= prevPeers && stagnant >= 3) {
        console.log(JSON.stringify({ event: "stop", reason: "no_new_peers" }));
        break;
      }
      continue;
    }

    const budget = peers.length * RPS_PER_NODE;
    if (r.rps > budget * 0.85) {
      console.log(
        JSON.stringify({
          event: "wait_spawn",
          rps: r.rps,
          budget,
          peers: peers.length,
          settle_ms: SETTLE_MS,
        })
      );
      await sleep(SETTLE_MS);
      continue;
    }

    const next = Math.min(softCap, conc + Math.max(8, Math.floor(CONC_PER_NODE / 3)));
    if (next === conc) {
      console.log(
        JSON.stringify({
          event: "wait_cap",
          conc,
          soft_cap: softCap,
          peers: peers.length,
          settle_ms: SETTLE_MS,
        })
      );
      await sleep(SETTLE_MS);
      stagnant++;
      if (stagnant >= 4) {
        console.log(JSON.stringify({ event: "stop", reason: "soft_cap" }));
        break;
      }
      continue;
    }
    conc = next;
    await sleep(Math.min(SETTLE_MS, 12000));
  }

  console.log(JSON.stringify({ event: "mesh_peak", ...best }));
  if (best) {
    const ips = await discoverIps();
    const sus = await hold(pickXor, best.concurrency, 30, "sustained");
    const after = await clusterSnap(ips);
    console.log(
      JSON.stringify({
        event: "sustained",
        ...sus,
        cluster_apply: +after.sum.toFixed(1),
        nodes_ok: after.nodes,
        owned: after.owned,
        hot: after.per.slice(0, 12),
      })
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
