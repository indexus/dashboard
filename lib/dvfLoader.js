/**
 * Load DVF Maison|Vente purchases into an Indexus mesh.
 *
 * Metrics (simulation loaders):
 *   [valeur_fonciere, surface_reelle_bati, €/m², lat+90, lng+180]
 *
 * Env:
 *   DVF_DATA_DIR  CSV directory (default: sibling portfolio loaders output, if present)
 *   INDEXUS_BEARER  optional pre-issued token
 *   INDEXUS_LOAD_SOCKETS / INDEXUS_LOAD_BATCH  steady-state concurrency
 *   INDEXUS_LOAD_MESH_SCALE  when 1 (default), scale in-flight batch with ready XOR peers
 *   INDEXUS_LOAD_BATCH_PER_NODE  batch slots per routable peer (default 16)
 *   INDEXUS_LOAD_BATCH_MAX / INDEXUS_LOAD_BATCH_MIN  clamp adaptive batch
 *   INDEXUS_LOAD_RAMP_START / INDEXUS_LOAD_RAMP_TARGET / INDEXUS_LOAD_RAMP_SECONDS
 *     optional write ramp: in-flight batch grows from START→TARGET over SECONDS
 *   INDEXUS_LOAD_PAUSE_QUEUE / INDEXUS_LOAD_ABORT_QUEUE / INDEXUS_LOAD_MONITOR_MS
 *     bootstrap queue backpressure (poll :19000/status)
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Collection, Space } from "js-indexus-sdk";
import { createRouter, discoverMesh, newRoutingKey } from "./mesh_route.js";

/** In-flight POST batch size; optionally ramps START→TARGET over RAMP_SECONDS. */
function createBatchSizer() {
  const steady =
    Math.max(1, parseInt(process.env.INDEXUS_LOAD_BATCH || "128", 10) || 128);
  const rampSec = Math.max(
    0,
    parseInt(process.env.INDEXUS_LOAD_RAMP_SECONDS || "0", 10) || 0,
  );
  const start = Math.max(
    1,
    parseInt(process.env.INDEXUS_LOAD_RAMP_START || "0", 10) || 0,
  );
  const target = Math.max(
    start,
    parseInt(process.env.INDEXUS_LOAD_RAMP_TARGET || String(steady), 10) ||
      steady,
  );
  if (!rampSec || !start || start >= target) {
    return {
      size: () => steady,
      describe: `batch=${steady}`,
    };
  }
  const t0 = Date.now();
  return {
    size: () => {
      const p = Math.min(1, (Date.now() - t0) / (rampSec * 1000));
      return Math.max(1, Math.round(start + (target - start) * p));
    },
    describe: `ramp batch ${start}→${target} over ${rampSec}s`,
  };
}

/** Ramp + live mesh scale: more ready peers ⇒ larger in-flight POST batch. */
function createMeshScaledBatchSizer(opts = {}) {
  const ramp = createBatchSizer();
  const meshMode = (
    process.env.INDEXUS_LOAD_MESH_SCALE ||
    process.env.LOAD_MESH_SCALE ||
    "cap"
  ).toLowerCase();
  if (meshMode === "0" || meshMode === "off" || meshMode === "false") {
    return ramp;
  }
  if (opts.route !== "xor") {
    return ramp;
  }
  const perNode = Math.max(
    1,
    parseInt(process.env.INDEXUS_LOAD_BATCH_PER_NODE || "16", 10) || 16,
  );
  const maxBatch = Math.max(
    perNode,
    parseInt(process.env.INDEXUS_LOAD_BATCH_MAX || "512", 10) || 512,
  );
  const minBatch = Math.max(
    1,
    parseInt(process.env.INDEXUS_LOAD_BATCH_MIN || "8", 10) || 8,
  );
  const probeMs = Math.max(
    5000,
    parseInt(process.env.INDEXUS_LOAD_MESH_PROBE_MS || "15000", 10) || 15000,
  );
  const host = opts.host || "127.0.0.1";
  const ports =
    Array.isArray(opts.ports) && opts.ports.length ? opts.ports : [21000];
  const bearer = opts.bearer || process.env.INDEXUS_BEARER || "";
  let readyPeers = 1;
  const routingKey = newRoutingKey();

  async function probe() {
    try {
      const seeds = ports.map((p) => `http://${host}:${p}`);
      const peers = await discoverMesh(seeds, {
        token: bearer,
        rounds: 2,
        routingKey,
      });
      readyPeers = Math.max(1, peers.length);
    } catch {
      /* keep last count */
    }
  }
  probe();
  const timer = setInterval(probe, probeMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    size: () => {
      const ramped = ramp.size();
      const scaled = Math.min(
        maxBatch,
        Math.max(minBatch, perNode * readyPeers),
      );
      if (meshMode === "cap") {
        return Math.min(maxBatch, ramped, scaled);
      }
      return Math.min(maxBatch, Math.max(ramped, scaled));
    },
    describe: `${ramp.describe} · mesh ${meshMode} (≥${minBatch}, ${perNode}/node, max ${maxBatch})`,
    readyPeers: () => readyPeers,
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_ROOT = path.resolve(__dirname, "..");

/** Canonical legacy DVF geo-only collection id (may already hold geo_load in local benches). */
export const DVF_GEO_COLLECTION = "DENjYsMTAyLDE2ME";

/** Prefer a fresh ≤16-char collection so purchase metrics are not mixed with geo_load. */
export const DVF_PURCHASE_COLLECTION = "DvFMV2020idx0001";

const GPS_DIM = { name: "gps", type: "spherical", args: [-90, 90, -180, 180] };

export function defaultDvfDataDir() {
  if (process.env.DVF_DATA_DIR) return path.resolve(process.env.DVF_DATA_DIR);
  // Optional sibling portfolio CSV tree (legacy local path).
  return path.resolve(
    DASHBOARD_ROOT,
    "../../portfolio/himo/loaders/data/output",
  );
}

function tryImportCsvParser() {
  try {
    const require = createRequire(import.meta.url);
    return require("csv-parser");
  } catch {
    return null;
  }
}

const randomizeLocation = (lat, lng, maxOffsetMeters = 10) => {
  const earthRadius = 6378137;
  const maxLat = (maxOffsetMeters / earthRadius) * (180 / Math.PI);
  const maxLng =
    (maxOffsetMeters / (earthRadius * Math.cos((lat * Math.PI) / 180))) *
    (180 / Math.PI);
  return [
    lat + (Math.random() - 0.5) * 2 * maxLat,
    lng + (Math.random() - 0.5) * 2 * maxLng,
  ];
};

/**
 * @param {object} opts
 * @param {string} opts.host
 * @param {number[]} opts.ports  seed P2P ports (bootstrap + known peers)
 * @param {string} [opts.bearer]
 * @param {http.Agent} [opts.agent]
 * @param {"xor"|"rr"} [opts.route]  xor = discover + nearest peer; rr = round-robin seeds
 */
function createPoster({ host, ports, bearer, agent, route = "xor" }) {
  const sockets = Math.max(
    4,
    parseInt(process.env.INDEXUS_LOAD_SOCKETS || "32", 10) || 32,
  );
  const rampTarget = Math.max(
    0,
    parseInt(process.env.INDEXUS_LOAD_RAMP_TARGET || "0", 10) || 0,
  );
  const AGENT =
    agent ||
    new http.Agent({
      keepAlive: true,
      // Headroom for ramp target so Agent is not the bottleneck mid-ramp.
      maxSockets: Math.max(sockets, rampTarget, 4),
    });

  const seeds = ports.map((p) => `http://${host}:${p}`);
  const router =
    route === "xor"
      ? createRouter(seeds, {
          refreshEvery: 256,
          refreshMs: 12000,
          token: bearer || "",
        })
      : null;
  let rr = 0;
  const destByHost = Object.create(null);
  const stats = { destByHost, picks: 0, peers: 0 };

  function noteDest(base) {
    let hostKey = base;
    try {
      hostKey = new URL(base).hostname;
    } catch {
      /* keep raw */
    }
    destByHost[hostKey] = (destByHost[hostKey] || 0) + 1;
    stats.picks++;
  }

  function postTo(base, data, headers) {
    const timeoutMs = Math.max(
      2000,
      parseInt(process.env.INDEXUS_LOAD_TIMEOUT_MS || "20000", 10) || 20000,
    );
    return new Promise((resolve, reject) => {
      const u = new URL(base);
      const req = http.request(
        {
          host: u.hostname,
          port: u.port || 80,
          path: "/item",
          method: "POST",
          agent: AGENT,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            if (res.statusCode === 201 || res.statusCode === 200) {
              resolve();
              return;
            }
            const body = Buffer.concat(chunks).toString("utf8");
            let detail = "";
            try {
              detail = JSON.parse(body)?.error || "";
            } catch {
              detail = body.slice(0, 120);
            }
            const err = new Error(
              detail
                ? `HTTP ${res.statusCode}: ${detail}`
                : `HTTP ${res.statusCode}`,
            );
            err.statusCode = res.statusCode;
            err.body = body;
            reject(err);
          });
        },
      );
      req.on("error", reject);
      // Without this, a dead peer IP hangs the whole DVF job forever in
      // `encode` (CSV done, first post batch never settles).
      req.on("timeout", () => {
        req.destroy(new Error(`timeout ${timeoutMs}ms ${base}`));
      });
      req.write(data);
      req.end();
    });
  }

  async function postItem(body) {
    const data = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
    };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;

    if (!router) {
      const port = ports[rr % ports.length];
      rr++;
      const base = `http://${host}:${port}`;
      noteDest(base);
      return postTo(base, data, headers);
    }

    const collection = body?.item?.collection || "";
    const location = body?.item?.location || body?.current || "";
    const attempts = Math.max(
      5,
      parseInt(process.env.INDEXUS_LOAD_ATTEMPTS || "16", 10) || 16,
    );
    let lastErr = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const base = await router.pick(collection, location);
      try {
        await postTo(base, data, headers);
        noteDest(base);
        if (typeof router.peers === "function") {
          const list = await router.peers();
          stats.peers = list?.length || 0;
        }
        return;
      } catch (e) {
        lastErr = e;
        router.markHot(base, 1500 + attempt * 800);
        if (e?.statusCode === 503 || e?.statusCode === 429) {
          // Scale pressure no longer 503s. These are queue-full / node.full /
          // still-joining — back off and re-pick instead of a permanent miss.
          if (attempt % 2 === 1) await router.forceRefresh();
          await new Promise((r) =>
            setTimeout(r, Math.min(300 * 2 ** attempt, 8000)),
          );
          continue;
        }
        if (attempt === attempts - 1) throw e;
        await router.forceRefresh();
      }
    }
    // Exhausted retries on 503/429: the mesh never accepted this write. It
    // must count as an error — resolving here silently inflated `added` by
    // every write refused during autoscale churn (posted 546k, stored 543k).
    throw lastErr || new Error("post retries exhausted");
  };
  postItem.stats = stats;
  return postItem;
}

function fetchBootstrapQueue(host) {
  return new Promise((resolve) => {
    const req = http.get(
      `http://${host}:19000/status`,
      { timeout: 3000 },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          try {
            const st = JSON.parse(body);
            resolve(parseInt(st.queue, 10) || 0);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Poll bootstrap queue depth and expose shouldPause / shouldAbort hooks.
 * @param {string} host bootstrap public IP or hostname
 */
export function createBootstrapBackpressure(host) {
  const pauseQ = Math.max(
    1,
    parseInt(process.env.INDEXUS_LOAD_PAUSE_QUEUE || "2500", 10) || 2500,
  );
  const abortQ = Math.max(
    pauseQ,
    parseInt(process.env.INDEXUS_LOAD_ABORT_QUEUE || "8000", 10) || 8000,
  );
  const intervalMs = Math.max(
    2000,
    parseInt(process.env.INDEXUS_LOAD_MONITOR_MS || "10000", 10) || 10000,
  );
  let lastQueue = 0;
  let paused = false;
  let aborted = false;

  async function poll() {
    const q = await fetchBootstrapQueue(host);
    if (q == null) return;
    lastQueue = q;
    paused = q >= pauseQ;
    aborted = q >= abortQ;
  }
  poll();
  const timer = setInterval(poll, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    queue: () => lastQueue,
    shouldPause: () => paused,
    shouldAbort: () => aborted,
    stop: () => clearInterval(timer),
  };
}

/** Block while paused; returns true if abort was requested. */
async function waitWhilePaused(opts) {
  let announced = false;
  while (opts.shouldPause?.()) {
    if (opts.shouldAbort?.()) return true;
    if (!announced) {
      announced = true;
      opts.onProgress?.({
        phase: "paused",
        added: opts.counters?.added,
      });
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return !!opts.shouldAbort?.();
}

/**
 * Aggregate CSV rows into unique Maison|Vente mutations, then POST items.
 *
 * @param {object} opts
 * @param {string} opts.filePath
 * @param {string} opts.collectionId
 * @param {(body: object) => Promise<void>} opts.postItem
 * @param {number} [opts.maxItems] stop after this many POSTs (across all files use external counter)
 * @param {{ added: number, skipped: number, errors: number, limit?: number }} opts.counters
 * @param {(info: object) => void} [opts.onProgress]
 * @param {() => boolean} [opts.shouldAbort]
 * @param {() => boolean} [opts.shouldPause]
 */
async function processCsvFile(opts) {
  const csv = tryImportCsvParser();
  if (!csv) {
    throw new Error(
      "csv-parser missing — run: pnpm add csv-parser  (in dashboard)",
    );
  }

  const { filePath, collectionId, postItem, counters, onProgress } = opts;
  const collection = new Collection(collectionId, [GPS_DIM]);
  const space = new Space(
    collection.dimensions(),
    collection.mask(),
    collection.offset(),
  );

  const unique = new Map();
  let rowsKept = 0;

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    const parser = csv();
    parser.on("data", (row) => {
      try {
        if (counters.limit != null && counters.added >= counters.limit) return;
        // Stop reading more rows once we already queued enough posts
        if (
          counters.limit != null &&
          counters.added + unique.size >= counters.limit * 2
        ) {
          return;
        }
        const idMutation = row.id_mutation;
        const valeurFonciere = parseFloat(row.valeur_fonciere);
        const surfaceReelleBati = parseFloat(row.surface_reelle_bati);
        const typeLocal = row.type_local;
        const natureMutation = row.nature_mutation;
        const lat = parseFloat(row.latitude);
        const lng = parseFloat(row.longitude);
        if (
          typeLocal !== "Maison" ||
          natureMutation !== "Vente" ||
          !idMutation ||
          Number.isNaN(lat) ||
          Number.isNaN(lng) ||
          Number.isNaN(valeurFonciere) ||
          valeurFonciere <= 0
        ) {
          return;
        }
        rowsKept++;
        const key = `${idMutation}|${valeurFonciere}`;
        if (!unique.has(key)) {
          unique.set(key, {
            idMutation,
            valeurFonciere,
            sumSurface: Number.isNaN(surfaceReelleBati) ? 0 : surfaceReelleBati,
            sumLat: lat,
            sumLng: lng,
            count: 1,
          });
        } else {
          const a = unique.get(key);
          a.sumSurface += Number.isNaN(surfaceReelleBati)
            ? 0
            : surfaceReelleBati;
          a.sumLat += lat;
          a.sumLng += lng;
          a.count++;
        }
      } catch (_) {}
    });
    parser.on("end", () => resolve());
    parser.on("error", reject);
    stream.pipe(parser);
  });

  onProgress?.({
    phase: "encode",
    file: path.basename(filePath),
    mutations: unique.size,
    rowsKept,
  });

  const promises = [];
  const remaining =
    counters.limit != null
      ? Math.max(0, counters.limit - counters.added)
      : Infinity;
  let queued = 0;
  const batchSizer = opts.batchSizer || createBatchSizer();

  async function flushBatch() {
    if (!promises.length) return;
    const batch = promises.splice(0, promises.length);
    await Promise.all(batch);
  }

  for (const data of unique.values()) {
    if (await waitWhilePaused(opts)) break;
    if (opts.shouldAbort?.()) break;
    if (queued >= remaining) break;
    const avgLat = data.sumLat / data.count;
    const avgLng = data.sumLng / data.count;
    const surface = data.sumSurface > 0 ? data.sumSurface : 1;
    const [rLat, rLng] = randomizeLocation(avgLat, avgLng);
    const point = [space.dimension(0).newPoint([rLat, rLng])];
    const location = space.encode(point, 16);
    const metrics = [
      data.valeurFonciere,
      data.sumSurface,
      data.valeurFonciere / surface,
      avgLat + 90,
      avgLng + 180,
    ];
    const idBase = `${data.idMutation}:Maison:Vente`;
    const idSuffix = opts.idSuffix || process.env.INDEXUS_LOAD_ID_SUFFIX || "";
    const id = idSuffix ? `${idBase}:${idSuffix}` : idBase;
    queued++;
    promises.push(
      postItem({
        item: {
          collection: collectionId,
          location,
          metrics,
          id,
        },
        root: "@",
        current: location,
      })
        .then(() => {
          counters.added++;
          if (counters.added % 200 === 0) {
            const st = postItem.stats;
            onProgress?.({
              phase: "post",
              added: counters.added,
              errors: counters.errors,
              errorByType: { ...counters.errorByType },
              file: path.basename(filePath),
              destByHost: st?.destByHost ? { ...st.destByHost } : undefined,
              routePeers: st?.peers,
            });
          }
        })
        .catch((err) => {
          counters.errors++;
          counters.skipped++;
          const msg = String(err?.message || err);
          const key =
            err?.statusCode != null
              ? String(err.message || `HTTP ${err.statusCode}`).slice(0, 96)
              : /timeout/i.test(msg)
                ? "timeout"
                : /ECONNREFUSED/i.test(msg)
                  ? "ECONNREFUSED"
                  : /ECONNRESET|hang up/i.test(msg)
                    ? "reset"
                    : msg.slice(0, 80);
          counters.errorByType = counters.errorByType || {};
          counters.errorByType[key] = (counters.errorByType[key] || 0) + 1;
          counters.lastError = msg;
          // Surface the first failure — silent catches made a total write
          // outage look like a healthy encode pass in the dashboard.
          if (counters.errors === 1 || counters.errors % 1000 === 0) {
            onProgress?.({
              phase: "post",
              added: counters.added,
              errors: counters.errors,
              lastError: msg,
              errorByType: { ...counters.errorByType },
              file: path.basename(filePath),
            });
          }
        }),
    );
    if (promises.length >= batchSizer.size()) {
      if (await waitWhilePaused(opts)) {
        await flushBatch();
        break;
      }
      await flushBatch();
    }
  }
  await flushBatch();
}

/**
 * @param {object} opts
 * @param {string} [opts.host]
 * @param {number[]} [opts.ports] seed P2P ports; loader rediscovers peers via /ping+/neighbors
 * @param {string} [opts.bearer]
 * @param {string} [opts.collectionId]
 * @param {string} [opts.dataDir]
 * @param {string[]} [opts.files] basename filters; default 2020_*.csv
 * @param {number} [opts.limit] max items to POST
 * @param {"xor"|"rr"} [opts.route] default xor (XOR-nearest discovered peer)
 * @param {(info: object) => void} [opts.onProgress]
 * @param {() => boolean} [opts.shouldAbort]
 * @param {() => boolean} [opts.shouldPause]
 */
export async function loadDvfPurchases(opts = {}) {
  const host = opts.host || "127.0.0.1";
  const ports =
    Array.isArray(opts.ports) && opts.ports.length
      ? opts.ports
      : [21000];
  const route = opts.route === "rr" ? "rr" : "xor";
  const collectionId = opts.collectionId || DVF_PURCHASE_COLLECTION;
  const dataDir = opts.dataDir || defaultDvfDataDir();
  const bearer = opts.bearer || process.env.INDEXUS_BEARER || "";
  const limit = opts.limit != null ? Math.max(1, opts.limit) : null;

  if (!fs.existsSync(dataDir)) {
    throw new Error(`DVF data dir not found: ${dataDir}`);
  }

  let files = fs
    .readdirSync(dataDir)
    .filter((f) => f.endsWith(".csv"))
    .sort();
  if (opts.files?.length) {
    const want = new Set(opts.files);
    files = files.filter((f) => want.has(f));
  } else if (opts.year) {
    const prefix = `${opts.year}_`;
    files = files.filter((f) => f.startsWith(prefix));
  } else {
    const y2020 = files.filter((f) => f.startsWith("2020_"));
    if (y2020.length) files = y2020;
  }
  if (!files.length) {
    throw new Error(`No CSV files in ${dataDir}`);
  }

  const postItem = createPoster({ host, ports, bearer, route });
  const batchSizer = createMeshScaledBatchSizer({ host, ports, bearer, route });
  const counters = {
    added: 0,
    skipped: 0,
    errors: 0,
    limit,
    errorByType: {},
    lastError: null,
  };
  const t0 = Date.now();

  opts.onProgress?.({
    phase: "start",
    host,
    ports,
    route,
    collectionId,
    files: files.length,
    limit,
    dataDir,
    writeRamp: batchSizer.describe,
  });

  for (const file of files) {
    if (await waitWhilePaused(opts)) break;
    if (opts.shouldAbort?.()) break;
    if (limit != null && counters.added >= limit) break;
    await processCsvFile({
      filePath: path.join(dataDir, file),
      collectionId,
      postItem,
      counters,
      batchSizer,
      onProgress: opts.onProgress,
      shouldAbort: opts.shouldAbort,
      shouldPause: opts.shouldPause,
      idSuffix: opts.idSuffix || process.env.INDEXUS_LOAD_ID_SUFFIX || "",
    });
  }

  const result = {
    ok: true,
    collectionId,
    added: counters.added,
    skipped: counters.skipped,
    errors: counters.errors,
    lastError: counters.lastError,
    errorByType: { ...counters.errorByType },
    elapsedMs: Date.now() - t0,
    dataDir,
    files: files.length,
    route,
    destByHost: postItem.stats ? { ...postItem.stats.destByHost } : {},
    routePeers: postItem.stats?.peers || 0,
  };
  opts.onProgress?.({ phase: "done", ...result });
  return result;
}
