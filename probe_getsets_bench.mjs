/**
 * Live getSets latency probe against the local mesh.
 * Usage: INDEXUS_BEARER=... node probe_getsets_bench.mjs
 */
import { Network, API, Peer } from "js-indexus-sdk";
import { performance } from "node:perf_hooks";

const COLL = "DvFMV2020idx0001";
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const fmt = (ms) => `${Math.round(ms)}ms`;

const net = new Network("http", new API(), ["127.0.0.1|21000"], 100, 50000, {
  navigation: "direct",
  method: "getSets",
  meshDiscovery: true,
  refreshTtlMs: 0,
});

const samples = [];
net.setActivityHandler((ev) => {
  if (ev.method !== "getSets" || ev.phase !== "end") return;
  samples.push({
    ms: ev.ms ?? 0,
    locs: Array.isArray(ev.locations) ? ev.locations.length : 1,
    bytes: ev.bytes ?? 0,
    wireBytes: ev.wireBytes ?? 0,
    redirects: ev.redirects ?? 0,
    peer: ev.host || ev.hash || "?",
    ok: ev.ok !== false,
  });
});

await net.whenReady();
console.log(`peers: ${net.listPeers().length}`);

let level = await net.getSet(COLL, "@");
let locations = level.map((c) => c.hash());
const byDepth = [locations.slice()];
for (let d = 0; d < 4 && locations.length; d++) {
  const map = await net.getSets(COLL, locations, { refresh: true, force: true });
  const next = [];
  for (const [, ch] of map) {
    for (const c of ch || []) if (typeof c.hash === "function") next.push(c.hash());
  }
  locations = next.slice(0, 400);
  if (locations.length) byDepth.push(locations.slice());
}
const all = byDepth.flat();
console.log(
  `tree depths: ${byDepth.map((z, i) => `d${i}=${z.length}`).join(" ")} | total=${all.length}`
);

function report(label, arr) {
  if (!arr.length) {
    console.log(`\n## ${label}\n  (no samples)`);
    return;
  }
  const ms = arr.map((s) => s.ms);
  const locs = arr.reduce((a, s) => a + s.locs, 0);
  const redirs = arr.reduce((a, s) => a + s.redirects, 0);
  const bytes = arr.reduce((a, s) => a + (s.bytes || 0), 0);
  console.log(`\n## ${label}`);
  console.log(
    `  n=${arr.length} locs=${locs} redirects=${redirs} bytes=${(bytes / 1024).toFixed(1)}KB`
  );
  console.log(
    `  latency: min=${fmt(Math.min(...ms))} p50=${fmt(pct(ms, 0.5))} avg=${fmt(avg(ms))} p95=${fmt(pct(ms, 0.95))} max=${fmt(Math.max(...ms))}`
  );
}

// 1) Single-location cold
{
  samples.length = 0;
  const picks = [];
  for (const depth of byDepth) {
    for (let i = 0; i < Math.min(10, depth.length); i++) picks.push(depth[i]);
  }
  const t0 = performance.now();
  for (const z of picks) {
    await net.getSets(COLL, [z], { refresh: true, force: true });
  }
  const wall = performance.now() - t0;
  report(`1. single-location sequential force (${picks.length} zones)`, samples.slice());
  console.log(
    `  wall=${fmt(wall)}  throughput=${(picks.length / (wall / 1000)).toFixed(1)} zones/s`
  );
}

// 2) Batch sizes
for (const batch of [1, 4, 16, 64]) {
  samples.length = 0;
  const pool = all.slice(0, Math.min(all.length, batch * 20));
  const t0 = performance.now();
  for (let i = 0; i < pool.length; i += batch) {
    await net.getSets(COLL, pool.slice(i, i + batch), {
      refresh: true,
      force: true,
    });
  }
  const wall = performance.now() - t0;
  report(`2. batch=${batch} sequential force (${pool.length} zones)`, samples.slice());
  console.log(`  wall=${fmt(wall)}  ${(pool.length / (wall / 1000)).toFixed(1)} zones/s`);
}

// 3) Concurrent singles
{
  samples.length = 0;
  const pool = all.slice(0, 128);
  const conc = net.getConcurrency();
  const t0 = performance.now();
  for (let i = 0; i < pool.length; i += conc) {
    await Promise.all(
      pool.slice(i, i + conc).map((z) =>
        net.getSets(COLL, [z], { refresh: true, force: true })
      )
    );
  }
  const wall = performance.now() - t0;
  report(`3. concurrent singles (conc=${conc}, ${pool.length} zones)`, samples.slice());
  console.log(`  wall=${fmt(wall)}  ${(pool.length / (wall / 1000)).toFixed(1)} zones/s`);
}

// 4) Cache / TTL re-read
{
  const warm = new Network("http", new API(), ["127.0.0.1|21000"], 100, 50000, {
    navigation: "direct",
    method: "getSets",
    meshDiscovery: false,
    refreshTtlMs: 5000,
  });
  await warm.whenReady();
  const pool = all.slice(0, 80);
  for (let i = 0; i < pool.length; i += 16) {
    await warm.getSets(COLL, pool.slice(i, i + 16), { refresh: true, force: true });
  }
  const before = warm.readMetrics();
  const t0 = performance.now();
  for (let i = 0; i < pool.length; i += 16) {
    await warm.getSets(COLL, pool.slice(i, i + 16), { refresh: true });
  }
  const wall = performance.now() - t0;
  const after = warm.readMetrics();
  console.log(`\n## 4. cache/TTL re-read (${pool.length} zones, refresh=true)`);
  console.log(
    `  wall=${fmt(wall)}  wireΔ=${after.requests - before.requests} cacheHitsΔ=${after.cacheHits - before.cacheHits} ttlHitsΔ=${after.ttlHits - before.ttlHits}`
  );
  console.log(`  ${(pool.length / (wall / 1000)).toFixed(0)} zones/s (client-side)`);
}

// 5) Per-peer latency
{
  samples.length = 0;
  const pool = all.slice(0, 200);
  for (let i = 0; i < pool.length; i += 20) {
    await net.getSets(COLL, pool.slice(i, i + 20), { refresh: true, force: true });
  }
  const byPeer = new Map();
  for (const s of samples) {
    let r = byPeer.get(s.peer);
    if (!r) {
      r = { n: 0, sum: 0, max: 0, locs: 0, redirs: 0, bytes: 0 };
      byPeer.set(s.peer, r);
    }
    r.n++;
    r.sum += s.ms;
    r.max = Math.max(r.max, s.ms);
    r.locs += s.locs;
    r.redirs += s.redirects;
    r.bytes += s.bytes || 0;
  }
  console.log(`\n## 5. per-peer latency (batch=20 force)`);
  const rows = [...byPeer.entries()].sort(
    (a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n
  );
  for (const [peer, r] of rows) {
    console.log(
      `  ${String(peer).padEnd(22)} n=${String(r.n).padStart(3)} avg=${String(Math.round(r.sum / r.n)).padStart(4)} max=${String(Math.round(r.max)).padStart(4)} locs=${String(r.locs).padStart(4)} redir=${String(r.redirs).padStart(3)} ${(r.bytes / 1024).toFixed(1)}KB`
    );
  }
}

// 6) Latency vs batch size
{
  console.log(
    `\n## 6. latency vs batch size (same 64 zones, force, sequential waves)`
  );
  const pool = all.slice(0, 64);
  for (const batch of [1, 2, 4, 8, 16, 32, 64]) {
    samples.length = 0;
    const t0 = performance.now();
    for (let i = 0; i < pool.length; i += batch) {
      await net.getSets(COLL, pool.slice(i, i + batch), {
        refresh: true,
        force: true,
      });
    }
    const wall = performance.now() - t0;
    const ms = samples.map((s) => s.ms);
    const redirs = samples.reduce((a, s) => a + s.redirects, 0);
    console.log(
      `  batch=${String(batch).padStart(2)} wall=${String(Math.round(wall)).padStart(5)}ms  reqs=${String(samples.length).padStart(3)}  p50=${String(Math.round(pct(ms, 0.5))).padStart(4)}  avg=${String(Math.round(avg(ms))).padStart(4)}  redir=${String(redirs).padStart(3)}  ${((pool.length / wall) * 1000).toFixed(0)} zones/s`
    );
  }
}

// 7) Raw API against bootstrap :21000
{
  const api = new API();
  const peer = new Peer(
    "AAAAAAAAAAAAAAAA",
    { "127.0.0.1": null },
    21000,
    "127.0.0.1"
  );
  // Use real bootstrap peer if table has it
  const listed = net.listPeers().find((p) => p.port === 21000);
  const target = listed
    ? new Peer(listed.hash, { [listed.ip]: null }, listed.port, listed.ip)
    : peer;
  const times = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    await api.getSets("http", target, COLL, ["@"], {
      deep: false,
      envelope: true,
      refresh: true,
    });
    times.push(performance.now() - t0);
  }
  console.log(`\n## 7. raw API.getSets('@') against :21000 x20`);
  console.log(
    `  min=${fmt(Math.min(...times))} p50=${fmt(pct(times, 0.5))} avg=${fmt(avg(times))} p95=${fmt(pct(times, 0.95))} max=${fmt(Math.max(...times))}`
  );
}

// 8) Concurrent batch=16 waves (how Aggregate actually drills)
{
  samples.length = 0;
  const pool = all.slice(0, 192);
  const batches = [];
  for (let i = 0; i < pool.length; i += 16) batches.push(pool.slice(i, i + 16));
  const t0 = performance.now();
  await Promise.all(
    batches.map((b) => net.getSets(COLL, b, { refresh: true, force: true }))
  );
  const wall = performance.now() - t0;
  report(
    `8. concurrent batches of 16 (${pool.length} zones, ${batches.length} reqs)`,
    samples.slice()
  );
  console.log(`  wall=${fmt(wall)}  ${(pool.length / (wall / 1000)).toFixed(1)} zones/s`);
}

console.log("\nDONE");
