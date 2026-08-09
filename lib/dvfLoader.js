/**
 * Load DVF Maison|Vente purchases into an Indexus mesh.
 *
 * Metrics (himo / simulation loaders):
 *   [valeur_fonciere, surface_reelle_bati, €/m², lat+90, lng+180]
 *
 * Env:
 *   DVF_DATA_DIR  CSV directory (default: sibling portfolio/himo/loaders/data/output)
 *   INDEXUS_BEARER  optional pre-issued token
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Collection, Space } from "js-indexus-sdk";
import { createRouter } from "./mesh_route.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_ROOT = path.resolve(__dirname, "..");

/** Canonical himo DVF geo-only collection id (may already hold geo_load in local benches). */
export const DVF_GEO_COLLECTION = "DENjYsMTAyLDE2ME";

/** Prefer a fresh ≤16-char collection so purchase metrics are not mixed with geo_load. */
export const DVF_PURCHASE_COLLECTION = "DvFMV2020idx0001";

const GPS_DIM = { name: "gps", type: "spherical", args: [-90, 90, -180, 180] };

export function defaultDvfDataDir() {
  if (process.env.DVF_DATA_DIR) return path.resolve(process.env.DVF_DATA_DIR);
  // Sibling portfolio checkout: github.com/portfolio/himo/...
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
  const AGENT =
    agent ||
    new http.Agent({
      keepAlive: true,
      maxSockets: Math.max(
        4,
        parseInt(process.env.INDEXUS_LOAD_SOCKETS || "32", 10) || 32,
      ),
    });

  const seeds = ports.map((p) => `http://${host}:${p}`);
  const router =
    route === "xor"
      ? createRouter(seeds, {
          refreshEvery: 32,
          refreshMs: 3000,
          token: bearer || "",
        })
      : null;
  let rr = 0;

  function postTo(base, data, headers) {
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
        },
        (res) => {
          res.resume();
          if (res.statusCode === 201 || res.statusCode === 200) resolve();
          else {
            const err = new Error(`HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            reject(err);
          }
        },
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }

  return async function postItem(body) {
    const data = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
    };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;

    if (!router) {
      const port = ports[rr % ports.length];
      rr++;
      return postTo(`http://${host}:${port}`, data, headers);
    }

    const collection = body?.item?.collection || "";
    const location = body?.item?.location || body?.current || "";
    const attempts = 5;
    let lastErr = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const base = await router.pick(collection, location);
      try {
        await postTo(base, data, headers);
        return;
      } catch (e) {
        lastErr = e;
        router.markHot(base, 1500 + attempt * 800);
        if (e?.statusCode === 503 || e?.statusCode === 429) {
          if (attempt % 2 === 1) await router.forceRefresh();
          await new Promise((r) =>
            setTimeout(r, Math.min(200 * 2 ** attempt, 4000)),
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
  const batchSize = Math.max(
    1,
    parseInt(process.env.INDEXUS_LOAD_BATCH || "128", 10) || 128,
  );

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
    const id = `${data.idMutation}:Maison:Vente`;
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
            onProgress?.({
              phase: "post",
              added: counters.added,
              file: path.basename(filePath),
            });
          }
        })
        .catch(() => {
          counters.errors++;
          counters.skipped++;
        }),
    );
    if (promises.length >= batchSize) {
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
  const counters = { added: 0, skipped: 0, errors: 0, limit };
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
      onProgress: opts.onProgress,
      shouldAbort: opts.shouldAbort,
      shouldPause: opts.shouldPause,
    });
  }

  const result = {
    ok: true,
    collectionId,
    added: counters.added,
    skipped: counters.skipped,
    errors: counters.errors,
    elapsedMs: Date.now() - t0,
    dataDir,
    files: files.length,
    route,
  };
  opts.onProgress?.({ phase: "done", ...result });
  return result;
}
