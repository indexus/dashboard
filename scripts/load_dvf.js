#!/usr/bin/env node
/**
 * Load DVF Maison|Vente purchases into a local mesh.
 *
 *   BOOT_IP=127.0.0.1 node scripts/load_dvf.js
 *   node scripts/load_dvf.js --limit 5000
 *   node scripts/load_dvf.js --ports 21000 --route xor
 *   node scripts/load_dvf.js --ports 21000,21010 --route rr
 *
 * Issues a write token via mesh_dash issuer (or INDEXUS_BEARER).
 * Default route=xor: discover peers from seed port(s) and write to the
 * XOR-nearest ready peer (same model as geo_load_density / mesh_route).
 */
import { loadDvfPurchases, DVF_PURCHASE_COLLECTION } from "../lib/dvfLoader.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}
function has(flag) {
  return process.argv.includes(flag);
}

const host = arg("--host", process.env.BOOT_IP || "127.0.0.1");
const ports = String(arg("--ports", process.env.INDEXUS_LOAD_PORTS || "21000"))
  .split(",")
  .map((p) => parseInt(p.trim(), 10))
  .filter((n) => !Number.isNaN(n));
const route = arg("--route", process.env.INDEXUS_LOAD_ROUTE || "xor");
const limitRaw = arg("--limit", null);
const limit = limitRaw != null ? parseInt(limitRaw, 10) : null;
const year = arg("--year", process.env.DVF_YEAR || "2020");
const collectionId = arg("--collection", DVF_PURCHASE_COLLECTION);
const issuer =
  (process.env.ISSUER_URL || `http://${host}:22000`).replace(/\/$/, "");

async function issueBearer() {
  if (process.env.INDEXUS_BEARER) return process.env.INDEXUS_BEARER;
  const res = await fetch(`${issuer}/v1/issue/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: `mesh-dash-dvf-${Date.now()}`,
      scopes: ["read", "write"],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `issuer HTTP ${res.status}`);
  }
  const token = body.token || body.access_token || body.bearer;
  if (!token) throw new Error("issuer returned no token");
  return token;
}

async function main() {
  if (has("--help")) {
    console.log(`Usage: node scripts/load_dvf.js [options]
  --host HOST          mesh host (default BOOT_IP or 127.0.0.1)
  --ports P1,P2,...    seed P2P ports (default 21000); peers rediscovered
  --route xor|rr       xor = XOR-nearest discovered peer (default); rr = round-robin seeds
  --year YYYY          CSV year prefix (default 2020) — full France Maison|Vente
  --limit N            optional cap (omit for full year)
  --collection ID      default ${DVF_PURCHASE_COLLECTION}
Env: DVF_DATA_DIR, INDEXUS_BEARER, ISSUER_URL, DVF_YEAR,
     INDEXUS_LOAD_PORTS, INDEXUS_LOAD_ROUTE, INDEXUS_LOAD_SOCKETS, INDEXUS_LOAD_BATCH`);
    return;
  }

  console.log(`Issuing write token via ${issuer}…`);
  const bearer = await issueBearer();
  console.log(
    `Loading DVF ${year} → ${host} seeds [${ports.join(",")}] route=${route} collection ${collectionId}` +
      (limit ? ` limit=${limit}` : " (full year)"),
  );

  const result = await loadDvfPurchases({
    host,
    ports,
    route,
    bearer,
    collectionId,
    year,
    limit: Number.isFinite(limit) ? limit : null,
    onProgress: (info) => {
      if (info.phase === "start") {
        console.log(
          `  data: ${info.dataDir} (${info.files} files) · route ${info.route}` +
            (info.limit ? ` · limit ${info.limit}` : " · no limit"),
        );
      } else if (info.phase === "encode") {
        console.log(
          `  ${info.file}: ${info.mutations} mutations (${info.rowsKept} rows)`,
        );
      } else if (info.phase === "post" && info.added) {
        process.stdout.write(`\r  posted ${info.added}…`);
      } else if (info.phase === "done") {
        console.log(
          `\nDone: +${info.added} items in ${(info.elapsedMs / 1000).toFixed(1)}s` +
            (info.errors ? ` (${info.errors} errors)` : "") +
            ` · route=${info.route}`,
        );
      }
    },
  });

  if (!result.added) {
    console.warn("No items written — check CSV filters / auth / mesh.");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
