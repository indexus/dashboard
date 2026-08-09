/**
 * Live 2×2 read-navigation matrix against the local mesh.
 * Run: node scripts/live_read_matrix.mjs
 */
import axios from "axios";

import { API } from "../src/himo/js-indexus-sdk/api/index.js";
import { Network } from "../src/himo/js-indexus-sdk/network/index.js";
import { ROOT } from "../src/himo/js-indexus-sdk/utilities/encoding.js";
import { abelianTotal } from "../src/himo/js-indexus-sdk/entities/abelian.js";

const DASH = process.env.DASH_URL || "http://127.0.0.1:3847";
const COLLECTION = process.env.COLLECTION || "DvFMV2020idx0001";
const ORIGIN = { lat: 48.8566, lng: 2.3522 };

function fail(msg) {
  console.error("FAIL:", msg);
  process.exitCode = 1;
}

function ok(msg) {
  console.log("  ✓", msg);
}

function wrapApi(api, log) {
  const orig = api.getSets.bind(api);
  api.getSets = async (protocol, peer, collection, locations, options = {}) => {
    const entry = {
      peer: peer.hash(),
      ip: peer.ip(),
      port: peer.port(),
      locations: [...locations],
      deep: options.deep !== false,
      envelope: options.envelope === true || (options.deep === false && options.envelope !== false),
      refresh: options.refresh === true,
      via: options.via || "",
      routingKey: options.routingKey instanceof Uint8Array,
    };
    log.push(entry);
    return orig(protocol, peer, collection, locations, options);
  };
  return api;
}

async function fetchMesh() {
  const { data: health } = await axios.get(`${DASH}/api/health`);
  const { data: mesh } = await axios.get(`${DASH}/api/mesh`);
  const { data: tok } = await axios.post(`${DASH}/api/token`, {});
  const token = tok.token || tok.access_token;
  if (!token) throw new Error("no token from /api/token");
  globalThis.__INDEXUS_BEARER__ = token;
  const hosts =
    Array.isArray(mesh.hosts) && mesh.hosts.length
      ? mesh.hosts
      : (mesh.nodes || [])
          .filter((n) => n.up && n.host)
          .map((n) => n.host);
  return { health, mesh, hosts: [...new Set(hosts)], token };
}

async function checkCors(host, token) {
  const [ip, port] = host.split("|");
  const url = `http://${ip}:${port}/sets?collection=${encodeURIComponent(
    COLLECTION
  )}&location=${encodeURIComponent(ROOT)}&deep=true`;
  const res = await axios.options(url, {
    headers: {
      Origin: "http://127.0.0.1:3847",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers":
        "authorization,accept,x-indexus-routing-key",
    },
    validateStatus: () => true,
  });
  const allowOrigin = res.headers["access-control-allow-origin"];
  if (!allowOrigin) fail(`CORS preflight missing ACAO on ${host}`);
  else ok(`CORS preflight ACAO=${allowOrigin} on ${host}`);
  const allowHeaders = String(
    res.headers["access-control-allow-headers"] || ""
  ).toLowerCase();
  if (
    !allowHeaders.includes("authorization") ||
    !allowHeaders.includes("x-indexus-routing-key")
  ) {
    fail(`CORS Allow-Headers missing auth/routing-key (got ${allowHeaders || "∅"})`);
  } else ok(`CORS allows Authorization + X-Indexus-Routing-Key`);

  // Expose-Headers is on the actual GET response (not OPTIONS).
  const key = Buffer.alloc(16, 7).toString("base64url");
  const get = await axios.get(url, {
    responseType: "arraybuffer",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Indexus-Routing-Key": key,
      Origin: "http://127.0.0.1:3847",
    },
    validateStatus: () => true,
  });
  if (get.status !== 200) fail(`auth GET /sets status=${get.status}`);
  else ok(`auth GET /sets 200 (${get.data?.byteLength ?? 0} B)`);

  const expose = String(get.headers["access-control-expose-headers"] || "");
  for (const h of [
    "x-indexus-ingress-name",
    "x-indexus-ingress-ip",
    "x-indexus-ingress-port",
  ]) {
    if (!expose.toLowerCase().includes(h)) {
      fail(`CORS Expose-Headers missing ${h} (got ${expose || "∅"})`);
    }
  }
  if (expose) ok(`CORS Expose-Headers: ${expose}`);

  const hintName = get.headers["x-indexus-ingress-name"];
  if (hintName) ok(`routing-key ingress hint → ${hintName}`);
  else ok(`routing-key: no closer ingress hint (self-nearest ok)`);
}

async function runCell({ navigation, method, hosts }) {
  const label = `${navigation}+${method}`;
  console.log(`\n=== ${label} ===`);
  const log = [];
  const api = wrapApi(new API(), log);
  const net = new Network("http", api, hosts, 32, 5000, {
    navigation,
    method,
  });
  await net.whenReady();
  const peers = net.listPeers();
  if (!peers.length) {
    fail(`${label}: no peers after discover`);
    return null;
  }
  ok(`peers=${peers.length} ingress=${net.ingressPeer()?.hash()}`);

  // Aggregate-style: batch parents from root drill
  const rootMap = await net.getSets(COLLECTION, [ROOT]);
  const rootKids = rootMap.get(ROOT) || [];
  const rootCount = abelianTotal(rootKids).count;
  if (rootCount <= 0) fail(`${label}: root count=${rootCount}`);
  else ok(`Aggregate root children=${rootKids.length} count=${rootCount}`);

  const sampleParents = rootKids
    .map((c) => c.hash())
    .filter(Boolean)
    .slice(0, 8);
  const beforeBatch = log.length;
  const batchMap = await net.getSets(COLLECTION, sampleParents);
  let batchCount = 0;
  for (const loc of sampleParents) {
    batchCount += abelianTotal(batchMap.get(loc) || []).count;
  }
  ok(
    `Aggregate batch parents=${sampleParents.length} childMass=${batchCount} http+=${
      log.length - beforeBatch
    }`
  );

  // Nearby-style: one-location alias
  const beforeNearby = log.length;
  const nearbyLoc = sampleParents[0] || ROOT;
  const nearbyKids = await net.getSet(COLLECTION, nearbyLoc);
  ok(
    `Nearby getSet(${nearbyLoc}) kids=${nearbyKids.length} count=${
      abelianTotal(nearbyKids).count
    } http+=${log.length - beforeNearby}`
  );

  // Wire checks
  const cellReqs = log;
  if (navigation === "direct") {
    const deepOnes = cellReqs.filter((r) => r.deep);
    if (deepOnes.length) {
      fail(
        `${label}: direct issued deep=true ${deepOnes.length}× (must be zero server-side deep hops)`
      );
    } else ok(`direct: all ${cellReqs.length} /sets used deep=false`);
    const envMissing = cellReqs.filter((r) => !r.envelope);
    if (envMissing.length) fail(`${label}: direct missing envelope on some requests`);
    else ok(`direct: envelope=1 on all requests`);
    const peersUsed = new Set(cellReqs.map((r) => r.peer));
    ok(`direct: contacted ${peersUsed.size} distinct peer(s)`);
  } else {
    const shallow = cellReqs.filter((r) => !r.deep);
    if (shallow.length) fail(`${label}: ingress issued deep=false ${shallow.length}×`);
    else ok(`ingress: all ${cellReqs.length} /sets used deep=true`);
    const noKey = cellReqs.filter((r) => !r.routingKey);
    if (noKey.length) fail(`${label}: ingress missing routing-key header`);
    else ok(`ingress: routing-key header on all requests`);
    const peersUsed = new Set(cellReqs.map((r) => r.peer));
    // Sticky ingress may still retry another peer on failure; expect mostly one.
    ok(`ingress: contacted ${peersUsed.size} peer(s) (sticky preferred)`);
  }

  if (method === "getSet") {
    const multi = cellReqs.filter((r) => r.locations.length > 1);
    if (multi.length) fail(`${label}: getSet method coalesced ${multi.length} multi-loc batches`);
    else ok(`getSet method: every request was one-location`);
  } else {
    const multi = cellReqs.filter((r) => r.locations.length > 1);
    ok(
      `getSets method: multi-loc batches=${multi.length} (ok if parents fit one wave)`
    );
  }

  // Cache parity: second getSet should not hit the wire
  const beforeCache = log.length;
  await net.getSet(COLLECTION, nearbyLoc);
  if (log.length !== beforeCache) fail(`${label}: cache miss on repeat getSet`);
  else ok(`cache: repeat getSet served locally`);

  return {
    label,
    rootCount,
    batchCount,
    nearbyCount: abelianTotal(nearbyKids).count,
    requests: cellReqs.length,
    peers: peers.length,
    ingress: net.ingressPeer()?.hash() || null,
  };
}

async function main() {
  console.log("Live read navigation matrix");
  console.log("dashboard", DASH, "collection", COLLECTION);
  const { hosts, token, mesh } = await fetchMesh();
  console.log(`mesh hosts=${hosts.length} up nodes=${(mesh.nodes || []).filter((n) => n.up).length}`);
  if (hosts.length < 2) {
    fail("need a multi-node mesh");
    return;
  }

  await checkCors(hosts[0], token);

  const matrix = [
    { navigation: "ingress", method: "getSets" },
    { navigation: "ingress", method: "getSet" },
    { navigation: "direct", method: "getSets" },
    { navigation: "direct", method: "getSet" },
  ];

  const results = [];
  for (const cell of matrix) {
    results.push(await runCell({ ...cell, hosts }));
  }

  console.log("\n=== summary ===");
  const baseline = results[0];
  for (const r of results) {
    if (!r) continue;
    const drift =
      baseline && r.rootCount !== baseline.rootCount
        ? ` ROOT_DRIFT(${r.rootCount} vs ${baseline.rootCount})`
        : "";
    console.log(
      `${r.label}: root=${r.rootCount} batchMass=${r.batchCount} nearby=${r.nearbyCount} http=${r.requests} peers=${r.peers} ingress=${r.ingress}${drift}`
    );
    if (baseline && Math.abs(r.rootCount - baseline.rootCount) > baseline.rootCount * 0.05) {
      fail(`${r.label}: root count drifted >5% from ingress+getSets`);
    }
  }

  if (process.exitCode) {
    console.error("\nMatrix finished with failures.");
  } else {
    console.log("\nMatrix passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
