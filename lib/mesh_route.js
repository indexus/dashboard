/**
 * Discover mesh peers (ping + /neighbors + /registered) and pick the
 * XOR-nearest node for an item key — same model as the SDK write path.
 *
 * Ping returns `client_ready` (spawned nodes publish after first ownership).
 * PreferNear joiners answer ping but stay off the XOR hop set until then.
 * `write_ready` is a dashboard alias; p2p /ping does not send `zones`.
 */
import http from "http";
import https from "https";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { decodeUrl64, encodeUrl64, zoneKeyID } = require("js-indexus-sdk");

/** http|https for P2P. INDEXUS_P2P_TLS=1 (or P2P_PROTOCOL=https) uses HTTPS. */
export function p2pScheme() {
  const proto = String(process.env.P2P_PROTOCOL || "").toLowerCase();
  if (proto === "https" || proto === "http") return proto;
  const tls = String(process.env.INDEXUS_P2P_TLS || "0").toLowerCase();
  if (["1", "true", "yes", "on"].includes(tls)) return "https";
  return "http";
}

function httpJson(url, { method = "GET", body, headers = {}, timeout = 8000, token } = {}) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  const payload = body != null ? JSON.stringify(body) : null;
  const hdrs = {
    ...(payload
      ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        }
      : {}),
    ...headers,
  };
  if (token) hdrs.Authorization = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers: hdrs,
        timeout,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode} ${url}`));
            return;
          }
          if (!raw) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

function normalizeBase(b) {
  return String(b || "").replace(/\/$/, "");
}

function baseUrlFromContact(contact, fallbackHost) {
  const port = contact.port || 21000;
  const ip =
    contact.ip ||
    (contact.ips && Object.keys(contact.ips)[0]) ||
    fallbackHost;
  if (!ip) return null;
  return `${p2pScheme()}://${ip}:${port}`;
}

function xorDistance(a, b) {
  const len = Math.min(a.length, b.length);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** 12-byte session key — same decoded width as a 16-char BASE64 node name. */
export function newRoutingKey() {
  const key = Buffer.alloc(12);
  for (let i = 0; i < 12; i++) key[i] = Math.floor(Math.random() * 256);
  return key;
}

/** XOR id of the zone that must own this item — location leads, not the client. */
export function itemZoneKey(collection, location) {
  return Buffer.from(zoneKeyID(collection || "", location || ""));
}

/**
 * `/neighbors?origin=` for a write: the item zone key, never a client session
 * seed. Nodes bucket neighbors around this origin, so the answer is the
 * owner neighborhood of that location.
 */
export function itemOrigin(collection, location) {
  return encodeUrl64(itemZoneKey(collection, location));
}

/** Coarse region key so we look up a prefix once, not every item. */
export function originBucket(collection, location) {
  const loc = String(location || "");
  if (loc && loc !== "@") return `${collection || ""}:${loc.slice(0, 2)}`;
  return `${collection || ""}:${itemOrigin(collection, location).slice(0, 4)}`;
}

/** Stick a 201 owner-hint to the location's region so the next write skips the emptied donor. */
export function rememberRegionOwner(
  map,
  collection,
  location,
  base,
  ttlMs,
  now = Date.now()
) {
  if (!map || !base) return map;
  map.set(originBucket(collection, location), {
    base: normalizeBase(base),
    until: now + ttlMs,
  });
  return map;
}

export function regionOwnerBase(
  map,
  collection,
  location,
  now = Date.now(),
  avoid = null
) {
  if (!map) return null;
  const bucket = originBucket(collection, location);
  const hit = map.get(bucket);
  if (!hit) return null;
  if (hit.until <= now) {
    map.delete(bucket);
    return null;
  }
  if (avoid?.has?.(hit.base)) return null;
  return hit.base;
}

/** Union by peer hash; `next` wins (fresher ping / ready). */
export function mergePeerTables(prev, next) {
  const by = new Map();
  for (const p of prev || []) {
    if (p?.hash) by.set(p.hash, p);
  }
  for (const p of next || []) {
    if (p?.hash) by.set(p.hash, p);
  }
  return [...by.values()];
}

/**
 * XOR hop set: seed always, plus peers that have published client routing.
 * `/ping` sends `client_ready`, not `write_ready` / `zones`.
 */
export function peerIsRoutable(peer, seedSet) {
  if (peer?.base && seedSet?.has?.(peer.base)) return true;
  if (peer?.writeReady === true || peer?.clientReady === true) return true;
  if (peer?.writeReady === false && peer?.clientReady !== true) return false;
  if (peer?.zonesKnown) return (peer.zones ?? 0) > 0;
  return false;
}

/**
 * Walk the mesh the way a client can: ping a seed, ask it for neighbours, ping
 * those, repeat. Only the p2p port is used — monitoring is an operator port and
 * a client has no business needing it to find where to write.
 *
 * @param {string[]} seedBases - e.g. ["http://1.2.3.4:21000"]
 * @param {{ token?: string, rounds?: number, now?: number, routingKey?: Buffer, itemOrigins?: string[], randomDraws?: number }} [opts]
 * @returns {Promise<Array<{ base: string, hash: string, id: Buffer, clientReady: boolean, firstSeen: number }>>}
 */
export async function discoverMesh(seedBases, opts = {}) {
  const token = opts.token || process.env.INDEXUS_BEARER || "";
  const rounds = opts.rounds ?? 1;
  const now = opts.now ?? Date.now();
  const randomDraws = Math.max(0, opts.randomDraws ?? 2);
  const contactBudget = Math.max(1, opts.contactBudget ?? 32);
  const seedSet = new Set(seedBases.map(normalizeBase).filter(Boolean));
  const byHash = new Map();
  // One session key for the walk (and across refreshes when the router
  // passes the same Buffer). A *new* random key every refresh asked
  // /neighbors around a different XOR region and then *replaced* the
  // table — writers only saw a slice, so most DVF keys XOR-nearest the
  // bootstrap seed.
  const routingKey = Buffer.isBuffer(opts.routingKey)
    ? opts.routingKey
    : newRoutingKey();
  const itemOrigins = [
    ...new Set((opts.itemOrigins || []).filter(Boolean)),
  ];

  function discoveryOrigin(peerId) {
    const width = peerId?.length || 0;
    if (!width || width >= routingKey.length) {
      return encodeUrl64(routingKey);
    }
    return encodeUrl64(routingKey.subarray(0, width));
  }

  /** Write path: walk around item locations. Seed/session key is fallback only. */
  function originsToAsk(peer) {
    if (itemOrigins.length) return itemOrigins;
    return [encodeUrl64(peer.id)];
  }

  function isRoutable(peer) {
    return peerIsRoutable(peer, seedSet);
  }

  async function ingest(base) {
    if (!base) return null;
    const cleaned = normalizeBase(base);
    try {
      const data = await httpJson(`${cleaned}/ping`, {
        method: "POST",
        body: {},
        timeout: 4000,
        token,
      });
      const c = data?.contact;
      if (!c?.name) return null;
      const peerBase = baseUrlFromContact(c, new URL(cleaned).hostname) || cleaned;
      const zonesKnown = typeof data?.zones === "number";
      const zones = zonesKnown ? data.zones : 0;
      const clientReady =
        typeof data?.client_ready === "boolean" ? data.client_ready : null;
      // p2p /ping speaks client_ready. write_ready is dashboard-only.
      const writeReady =
        typeof data?.write_ready === "boolean"
          ? data.write_ready
          : clientReady;
      const prev = byHash.get(c.name);
      const peer = {
        base: normalizeBase(peerBase),
        hash: c.name,
        id: Buffer.from(decodeUrl64(c.name)),
        clientReady,
        writeReady,
        zones,
        zonesKnown,
        firstSeen: prev?.firstSeen ?? now,
      };
      const known = byHash.has(c.name);
      byHash.set(c.name, peer);
      return known ? null : peer;
    } catch {
      return null; // unreachable, still booting, or not ours
    }
  }

  async function ingestContacts(contacts, fallbackHost) {
    const fresh = [];
    for (const c of (contacts || []).slice(0, contactBudget)) {
      if (!c?.name || byHash.has(c.name)) continue;
      const base = baseUrlFromContact(c, fallbackHost);
      const added = await ingest(base);
      if (added) fresh.push(added);
    }
    return fresh;
  }

  async function askNeighbors(peer, originEnc) {
    const data = await httpJson(
      `${peer.base}/neighbors?origin=${encodeURIComponent(originEnc)}`,
      { timeout: 4000, token }
    );
    return ingestContacts(
      data?.neighbors,
      new URL(peer.base).hostname
    );
  }

  const seeds = seedBases.map(normalizeBase).filter(Boolean);
  let frontier = (await Promise.all(seeds.map((b) => ingest(b)))).filter(Boolean);

  for (let round = 0; round < rounds && frontier.length; round++) {
    const found = await Promise.all(
      frontier.map(async (peer) => {
        try {
          const found = [];
          for (const origin of originsToAsk(peer)) {
            found.push(...(await askNeighbors(peer, origin)));
          }
          return found;
        } catch {
          return [];
        }
      })
    );
    frontier = found.flat();
  }

  // /neighbors is k-bucket around an origin. Uniform /random fills holes so
  // XOR pick sees owners across the space, not one cluster + the seed.
  const randomOrigin = itemOrigins[0] || discoveryOrigin(null);
  for (const seed of seeds) {
    for (let i = 0; i < randomDraws; i++) {
      try {
        const data = await httpJson(
          `${seed}/random?origin=${encodeURIComponent(randomOrigin)}`,
          { timeout: 3000, token }
        );
        const c = data?.random;
        if (!c?.name || byHash.has(c.name)) continue;
        await ingest(baseUrlFromContact(c, new URL(seed).hostname));
      } catch {
        /* optional fill */
      }
    }
  }

  // Only return peers that are safe for client XOR routing.
  return [...byHash.values()].filter(isRoutable);
}

/**
 * Peer whose id is XOR-closest to zoneKeyID(collection, location).
 * Optional `avoid` set of bases to skip (e.g. after 503).
 */
export function nearestForKey(peers, collection, location, avoid = null) {
  // `transform` was renamed to `zoneKeyID` in js-indexus-sdk; using the old
  // name threw on every pick and the DVF loader counted 100% write errors.
  const key = Buffer.from(zoneKeyID(collection, location));
  let best = null;
  let bestDist = null;
  for (const p of peers) {
    if (avoid && avoid.has(p.base)) continue;
    const d = xorDistance(p.id, key);
    if (!best || Buffer.compare(d, bestDist) < 0) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Cycle among client-ready peers instead of XOR-nearest.
 * XOR pick + PreferNear (node named after the collection) magnets HTTP onto
 * one ingress; P2P Handoff still places by XOR after ACK.
 */
export function nextReadyBase(peers, n, avoid, seedSet, seedFallback) {
  const ready = [];
  for (const p of peers) {
    if (!p?.base) continue;
    if (avoid && avoid.has(p.base)) continue;
    if (p.clientReady === false && !seedSet?.has?.(p.base)) continue;
    if (!peerIsRoutable(p, seedSet)) continue;
    ready.push(p);
  }
  if (!ready.length) return seedFallback;
  return ready[Math.abs(n) % ready.length].base;
}

/**
 * Client hop pick from a table filled at boot, then by 201 owner-hints.
 * Ping/neighbors only on forceRefresh (boot + errors), not every write.
 *
 * `route`: `xor` (default) = XOR-nearest of zoneKey(collection, location).
 * `rr` / `spread` = round-robin among client_ready peers so HTTP ingress
 * does not magnet onto one PreferNear joiner.
 */
export function createRouter(
  seedBases,
  { token = "", route } = {}
) {
  const hopMode = String(
    route || process.env.INDEXUS_CLIENT_ROUTE || "xor"
  ).toLowerCase();
  const spreadHops = hopMode === "rr" || hopMode === "spread";
  let peers = [];
  let n = 0;
  let ready = null;
  let inflight = null;
  let lastRefresh = 0;
  let lastFullRefreshBases = new Set(
    seedBases.map(normalizeBase).filter(Boolean)
  );
  const avoidUntil = new Map(); // base -> epoch ms
  const bearer = token || process.env.INDEXUS_BEARER || "";
  const recentOrigins = [];
  const MAX_ORIGINS = 4;
  const seedSet = new Set(seedBases.map(normalizeBase).filter(Boolean));
  // Stable across refreshes — a new key each walk only saw one XOR slice and
  // writers never discovered owners outside the bootstrap seed's neighborhood.
  const routingKey = newRoutingKey();

  function rememberOrigin(origin) {
    if (!origin) return;
    const i = recentOrigins.indexOf(origin);
    if (i >= 0) recentOrigins.splice(i, 1);
    recentOrigins.unshift(origin);
    if (recentOrigins.length > MAX_ORIGINS) recentOrigins.length = MAX_ORIGINS;
  }

  function refresh() {
    if (inflight) return inflight;
    const now = Date.now();
    const seeds = [
      ...new Set([
        ...seedBases.map(normalizeBase),
        ...peers.slice(0, 2).map((x) => x.base).filter(Boolean),
      ]),
    ];
    inflight = discoverMesh(seeds, {
      token: bearer,
      now,
      routingKey,
      itemOrigins: recentOrigins.slice(),
      rounds: 1,
      randomDraws: 2,
      contactBudget: 32,
    })
      .then(async (p) => {
        if (p.length) {
          // Merge so 201-hinted owners survive a later discover walk.
          peers = mergePeerTables(peers, p);
        } else {
          const seedOnly = await discoverMesh(
            seedBases.map(normalizeBase).filter(Boolean),
            {
              token: bearer,
              now,
              routingKey,
              itemOrigins: [],
              rounds: 1,
              randomDraws: 0,
            }
          );
          if (seedOnly.length) {
            peers = mergePeerTables(peers, seedOnly);
          } else if (!peers.length) {
            peers = seedBases.map((base) => ({
              base: normalizeBase(base),
              hash: base,
              id: Buffer.alloc(16),
              clientReady: true,
              writeReady: true,
              firstSeen: Date.now(),
            }));
          }
        }
        lastFullRefreshBases = new Set(peers.map((x) => x.base));
        lastRefresh = Date.now();
        return peers;
      })
      .finally(() => {
        inflight = null;
      });
    ready = inflight;
    return inflight;
  }

  async function ensure() {
    if (!peers.length) await refresh();
  }

  function dropPeer(base) {
    const cleaned = normalizeBase(base);
    if (!cleaned) return;
    peers = peers.filter((p) => p.base !== cleaned);
    avoidUntil.delete(cleaned);
    lastFullRefreshBases.delete(cleaned);
  }

  function adoptRedirect({ name, ip, port }) {
    if (!ip || !name) return;
    const base = normalizeBase(`http://${ip}:${port || 21000}`);
    let id;
    try {
      id = Buffer.from(decodeUrl64(name));
    } catch {
      id = Buffer.alloc(16);
    }
    const peer = {
      base,
      hash: name,
      id,
      firstSeen: Date.now(),
    };
    peers = mergePeerTables(peers, [peer]);
    lastFullRefreshBases.add(base);
  }

  function adoptHint(_collection, _location, contact) {
    adoptRedirect(contact);
  }

  return {
    async pick(collection, location) {
      rememberOrigin(itemOrigin(collection, location));
      if (!peers.length) await refresh();
      n++;
      const now = Date.now();
      const avoid = new Set();
      for (const [base, until] of avoidUntil) {
        if (until > now) avoid.add(base);
        else avoidUntil.delete(base);
      }
      for (const p of peers) {
        if (p.clientReady === false && !seedSet.has(p.base)) {
          avoid.add(p.base);
        }
      }
      if (spreadHops) {
        return nextReadyBase(
          peers,
          n,
          avoid,
          seedSet,
          seedBases[0]
        );
      }
      const peer = nearestForKey(peers, collection, location, avoid);
      return peer?.base || seedBases[0];
    },
    /** Temporarily deprioritize a base after backpressure / errors. */
    markHot(base, ms = 2000) {
      if (!base) return;
      avoidUntil.set(normalizeBase(base), Date.now() + ms);
    },
    dropPeer,
    adoptRedirect,
    adoptHint,
    async forceRefresh() {
      await refresh();
      return peers;
    },
    async peers() {
      await ensure();
      return peers;
    },
  };
}
