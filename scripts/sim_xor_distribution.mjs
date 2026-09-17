#!/usr/bin/env node
/**
 * Expected DVF write share under XOR routing.
 *
 * zoneKeyID(collection, location) — bit-merge aligned with Go ZoneKeyID.
 * DVF uses 16-char GPS locations and a 16-char collection → key = location.
 * France GPS shares a geohash prefix, so random peer IDs pile onto 1–2 nodes.
 *
 * Autoscaler places spawned IDs in the exclusive-gap (dichotomy) of the hot
 * owner. After k splits, XOR-nearest of France keys ≈ 1/N among those N.
 *
 * Client table bugs (seed-only / k-slice) recreate the pile even after splits.
 */
import { createRequire } from "node:module";
import { nearestForKey } from "../lib/mesh_route.js";

const require = createRequire(import.meta.url);
const { Collection, Space, zoneKeyID, encodeUrl64 } = require("js-indexus-sdk");

const COLLECTION = "DvFMV2020idx0001";
const GPS = { name: "gps", type: "spherical", args: [-90, 90, -180, 180] };

function xorCmp(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function xorNearest(peers, key) {
  let best = null;
  let bestD = null;
  for (const p of peers) {
    const d = Buffer.alloc(Math.min(p.id.length, key.length));
    for (let i = 0; i < d.length; i++) d[i] = p.id[i] ^ key[i];
    if (!best || Buffer.compare(d, bestD) < 0) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

function makeRandomPeers(n, seed = 1) {
  const peers = [];
  let x = seed;
  for (let i = 0; i < n; i++) {
    const id = Buffer.alloc(12);
    for (let j = 0; j < 12; j++) {
      x = (x * 1664525 + 1013904223) >>> 0;
      id[j] = x & 255;
    }
    peers.push({ hash: encodeUrl64(id), base: `http://10.0.0.${i}:21000`, id });
  }
  return peers;
}

function franceLocations(space, m) {
  const out = [];
  for (let i = 1; i <= m; i++) {
    const lat = 42.3 + ((i * 17) % 7000) / 7000 * 8.7;
    const lng = -4.8 + ((i * 31) % 9000) / 9000 * 13.2;
    const point = [space.dimension(0).newPoint([lat, lng])];
    out.push(space.encode(point, 16));
  }
  return out;
}

function keysOf(locations) {
  return locations.map((loc) => Buffer.from(zoneKeyID(COLLECTION, loc)));
}

function prefixHist(locations, n = 2) {
  const h = Object.create(null);
  for (const loc of locations) {
    const p = loc.slice(0, n);
    h[p] = (h[p] || 0) + 1;
  }
  return Object.entries(h)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
}

function histogram(peers, locations) {
  const counts = Object.fromEntries(peers.map((p) => [p.hash, 0]));
  for (const loc of locations) {
    const p = nearestForKey(peers, COLLECTION, loc);
    if (p) counts[p.hash]++;
  }
  return counts;
}

function summarize(label, counts, nFull) {
  const vals = Object.values(counts);
  const total = vals.reduce((a, b) => a + b, 0);
  const used = vals.filter((v) => v > 0).length;
  const max = Math.max(...vals, 0);
  const minPos = Math.min(...vals.filter((v) => v > 0), Infinity);
  const min = Number.isFinite(minPos) ? minPos : 0;
  const shares = vals.map((v) => (total ? v / total : 0));
  const n = vals.length;
  const expect = n ? 1 / n : 0;
  const l1 = shares.reduce((a, s) => a + Math.abs(s - expect), 0) / 2;
  const maxShare = total ? max / total : 0;
  const imb = expect > 0 ? maxShare / expect : 0;
  console.log(
    `${label}: N=${n} hit=${used} maxShare=${(maxShare * 100).toFixed(1)}% ` +
      `minShare=${total ? ((min / total) * 100).toFixed(1) : 0}% ` +
      `L1=${l1.toFixed(3)} imbalance=${imb.toFixed(2)}× ` +
      `expect≈${(expect * 100).toFixed(1)}%` +
      (nFull && n < nFull ? `  [table ${n}/${nFull}]` : ""),
  );
  return { maxShare, l1, used, n, imb };
}

/** Heaviest exclusive 2-char location prefix → place an ID on that centroid. */
function placePrefixGap(peers, locations, keys) {
  const byOwner = new Map(peers.map((p) => [p.hash, Object.create(null)]));
  for (let i = 0; i < keys.length; i++) {
    const owner = xorNearest(peers, keys[i]);
    const pref = locations[i].slice(0, 2);
    const bag = byOwner.get(owner.hash);
    if (!bag[pref]) bag[pref] = [];
    bag[pref].push(keys[i]);
  }
  let bestPref = null;
  let bestKeys = [];
  for (const bag of byOwner.values()) {
    for (const [pref, ks] of Object.entries(bag)) {
      if (ks.length > bestKeys.length) {
        bestPref = pref;
        bestKeys = ks;
      }
    }
  }
  if (!bestKeys.length) return null;
  const mid = bestKeys[Math.floor(bestKeys.length / 2)];
  const id = Buffer.from(mid);
  return {
    hash: encodeUrl64(id),
    base: `http://10.0.0.2:21000`,
    id,
    prefix: bestPref,
  };
}

function dichotomyMesh(locations, keys, nTarget) {
  const genesis = Buffer.from(keys[0]);
  genesis.fill(0);
  const peers = [
    { hash: encodeUrl64(genesis), base: "http://10.0.0.1:21000", id: genesis },
  ];
  const used = new Set();
  while (peers.length < nTarget) {
    const next = placePrefixGap(peers, locations, keys);
    if (!next || used.has(next.prefix)) break;
    used.add(next.prefix);
    next.base = `http://10.0.${peers.length}.1:21000`;
    peers.push(next);
  }
  return peers;
}

function main() {
  const collection = new Collection(COLLECTION, [GPS]);
  const space = new Space(
    collection.dimensions(),
    collection.mask(),
    collection.offset(),
  );
  const M = parseInt(process.env.SIM_ITEMS || "20000", 10);
  const locations = franceLocations(space, M);
  const keys = keysOf(locations);
  const prefixes = prefixHist(locations, 2);

  console.log(`XOR sim  collection=${COLLECTION}  items=${M}  (France GPS)`);
  console.log(
    `location prefixes (2 chars): ${prefixes.map(([p, n]) => `${p}:${n}`).join(" ")}\n`,
  );
  console.log("Attendu si le client a la table complète des owners placés (dichotomy):");
  console.log("  dest_i → 1/N   rate ≈ N × k_node   (k constant = linéaire)\n");

  console.log("--- IDs aléatoires (placement cassé) ---");
  for (const N of [1, 4, 8, 16]) {
    summarize(`random N=${N}`, histogram(makeRandomPeers(N), locations), N);
  }

  console.log("\n--- IDs dichotomy (placement autoscale) ---");
  for (const N of [1, 2, 4, 8, 16]) {
    const mesh = dichotomyMesh(locations, keys, N);
    summarize(`placed N=${mesh.length}`, histogram(mesh, locations), N);
    if (N >= 8) {
      summarize(
        `  seed-only`,
        histogram([mesh[0]], locations),
        mesh.length,
      );
      summarize(
        `  slice k=2`,
        histogram(mesh.slice(0, 2), locations),
        mesh.length,
      );
    }
  }

  console.log(`
Lecture bench vs ce modèle:
  dest maxShare ≲ 1/N + 15 pts, L1 ≲ 0.20     → client XOR + placement OK
  dest maxShare > 50% alors que N≥4 placed    → table client (seed / k-bucket)
  dest ~1/N mais items bootstrap >> 1/N       → apply/forward/ownership
  items ~1/N, dest pile bootstrap             → forward masque un mauvais pick
  queue=0 et rate plat quand N double         → writers saturés, pas le mesh
  hot_signal=mem_rise avant items_limit       → spawn trop tôt (config)
`);
}

main();
