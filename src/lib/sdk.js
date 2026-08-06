import { Collection, Space, Local, API, Peer } from "js-indexus-sdk";
import { issueToken } from "./api.js";

export const GPS_DIM = { name: "gps", type: "spherical", args: [-90, 90, -180, 180] };

/** Cube early-stop: cells with count ≤ LIMIT become detail leaves (Aggregate worker). */
export const DETAIL_LIMIT = 5;

export const COLLECTION_PRESETS = [
  { id: "DvFMV2020idx0001", label: "DVF Maison|Vente" },
  { id: "DENjYsMTAyLDE2ME", label: "himo DVF id (legacy)" },
  { id: "FrGeoBenchAws00001", label: "bench geo (legacy)" },
];

/** Canonical clean purchase collection for mesh_dash Aggregate (≤16 chars). */
export const DVF_PURCHASE_COLLECTION = COLLECTION_PRESETS[0].id;

/** DVF purchase metrics: [valeur, surface, €/m², lat+90, lng+180] */
export function dvfMetrics(valeurFonciere, surfaceM2, lat, lng) {
  const v = Number(valeurFonciere) || 0;
  const s = Number(surfaceM2) || 0;
  return [v, s, s > 0 ? v / s : 0, lat + 90, lng + 180];
}

export const VIEW_MODES = [
  { id: "aggregate", label: "Aggregate" },
  { id: "nearby", label: "Nearby" },
];

/** metrics[2] — used by nearby summarizeItem (geo_load / DVF). */
export const METRIC_VALUE_INDEX = 2;

/**
 * Multi-peer network for Local.search.
 * Pings every known mesh host, follows contacts on getSet (same pattern as geo_nearest.js).
 * Prefer this over SDK Network.discoverPeers which races before the table is warm.
 */
class MeshNetwork {
  constructor(protocol, api, hosts, concurrency = 32) {
    this._protocol = protocol;
    this._api = api;
    this._concurrency = concurrency;
    this._hosts = [...new Set((hosts || []).filter(Boolean))];
    /** @type {import("js-indexus-sdk").Peer[]} */
    this._peers = [];
    this._ready = this._discover();
  }

  getConcurrency() {
    return this._concurrency;
  }

  hosts() {
    return this._hosts.slice();
  }

  peerCount() {
    return this._peers.length;
  }

  async _discover() {
    if (!this._hosts.length) {
      throw new Error("no mesh hosts — wait for /api/mesh nodes");
    }
    const settled = await Promise.allSettled(
      this._hosts.map(async (host) => {
        const [ip, portStr] = host.split("|");
        const port = parseInt(portStr, 10);
        if (!ip || !Number.isFinite(port)) {
          throw new Error(`bad host ${host}`);
        }
        return this._api.pingPeer(this._protocol, ip, port);
      }),
    );
    const peers = [];
    const seen = new Set();
    for (const r of settled) {
      if (r.status !== "fulfilled" || !r.value) continue;
      const peer = r.value;
      const key = peer.hash?.() || `${peer.ip?.()}:${peer.port?.()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      peers.push(peer);
    }
    this._peers = peers;
    if (!peers.length) {
      throw new Error(
        `failed to ping any peer (${this._hosts.length} hosts: ${this._hosts.join(", ")})`,
      );
    }
  }

  _remember(peer) {
    if (!(peer instanceof Peer)) return;
    const key = peer.hash?.() || `${peer.ip?.()}:${peer.port?.()}`;
    if (this._peers.some((p) => (p.hash?.() || "") === key)) return;
    this._peers.push(peer);
  }

  _pickPeer(i = 0) {
    if (!this._peers.length) return null;
    return this._peers[i % this._peers.length];
  }

  async getSet(coll, location) {
    await this._ready;
    let peer = this._pickPeer(0);
    if (!peer) return [];

    for (let hop = 0; hop < 12; hop++) {
      try {
        const response = await this._api.getSet(this._protocol, peer, coll, location);
        if (response.contact instanceof Peer) {
          this._remember(response.contact);
          if (
            response.contact.hash() !== peer.hash() &&
            response.set === null
          ) {
            peer = response.contact;
            continue;
          }
        }
        return response.set || [];
      } catch (e) {
        // Try next known peer; Grid.process assumes an array.
        peer = this._pickPeer(hop + 1);
        if (!peer) {
          console.warn("getSet failed", coll, location, e.message || e);
          return [];
        }
      }
    }
    return [];
  }

  async addItem(collection, root, location, metrics, reference) {
    await this._ready;
    let lastErr = null;
    for (let i = 0; i < this._peers.length; i++) {
      const peer = this._pickPeer(i);
      try {
        await this._api.addItem(
          this._protocol,
          peer,
          collection,
          root,
          location,
          metrics,
          reference,
        );
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("addItem failed on all peers");
  }
}

let tokenPromise = null;

export async function ensureToken() {
  if (globalThis.__INDEXUS_BEARER__) return globalThis.__INDEXUS_BEARER__;
  if (!tokenPromise) {
    tokenPromise = issueToken()
      .then((d) => {
        const tok = d.token || d.access_token;
        if (!tok) throw new Error("issuer returned no token");
        globalThis.__INDEXUS_BEARER__ = tok;
        return tok;
      })
      .catch((e) => {
        tokenPromise = null;
        throw e;
      });
  }
  return tokenPromise;
}

export function bootstrapHost(bootIp, p2pPort = 21000) {
  if (!bootIp) return null;
  return `${bootIp}|${p2pPort}`;
}

/**
 * Build `ip|p2p` hosts from /api/mesh payload.
 */
export function hostsFromMesh(mesh, fallbackBootHost = null) {
  const hosts = [];
  if (Array.isArray(mesh?.hosts) && mesh.hosts.length) {
    hosts.push(...mesh.hosts);
  } else {
    for (const n of mesh?.nodes || []) {
      if (!n?.up) continue;
      if (n.host) {
        hosts.push(n.host);
        continue;
      }
      const p2p = n.p2p ?? (n.mon != null ? n.mon + 2000 : null);
      if (n.ip && p2p) hosts.push(`${n.ip}|${p2p}`);
    }
  }
  if (mesh?.bootstrap) hosts.push(mesh.bootstrap);
  if (fallbackBootHost) hosts.push(fallbackBootHost);
  return [...new Set(hosts.filter(Boolean))];
}

export function buildCollection(name) {
  const collection = new Collection(name, [GPS_DIM]);
  const space = new Space(collection.dimensions(), collection.mask(), collection.offset());
  return { collection, space, gps: space.dimension(0) };
}

/** Haversine distance in kilometers (same formula as Spherical.pointDistance). */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const rLat1 = (Math.PI * lat1) / 180;
  const rLat2 = (Math.PI * lat2) / 180;
  const theta = (Math.PI * (lng2 - lng1)) / 180;
  let dist =
    Math.sin(rLat1) * Math.sin(rLat2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.cos(theta);
  dist = Math.min(dist, 1);
  dist = Math.acos(dist);
  dist = (dist * 180) / Math.PI;
  return dist * 60 * 1.1515 * 1.609344;
}

/**
 * Format a kilometer distance for the items list (m under 1 km).
 * @param {number|null|undefined} km
 */
export function formatDistanceKm(km) {
  if (km == null || !Number.isFinite(km)) return null;
  const d = Math.max(0, km);
  if (d < 1) return `${Math.round(d * 1000)} m`;
  if (d < 10) return `${d.toFixed(2)} km`;
  if (d < 100) return `${d.toFixed(1)} km`;
  return `${Math.round(d)} km`;
}

/**
 * Summarize a Local.search hit for the UI.
 * Prefer true km from the search origin (metrics lat/lng or per-dim distances),
 * never the normalized `distance()` score used for ranking (~0.00x).
 *
 * @param {object} item
 * @param {number} rank
 * @param {{ lat?: number, lng?: number } | null} [origin]
 */
export function summarizeItem(item, rank, origin = null) {
  const metrics = item.metrics?.() || item._metrics || [];
  const lat = metrics.length > 3 ? Number(metrics[3]) - 90 : null;
  const lng = metrics.length > 4 ? Number(metrics[4]) - 180 : null;
  const value = Number(metrics[METRIC_VALUE_INDEX]) || 0;
  const idRaw = item.id?.() || item._id || String(item.hash?.() || "");
  const hash = item.hash?.() || item._hash || "";
  // Prefer human reference; fall back to short hash when id is the bare location key.
  const id =
    idRaw && idRaw !== hash
      ? idRaw
      : hash
        ? hash.length > 16
          ? `${hash.slice(0, 12)}…`
          : hash
        : idRaw || "—";

  let distanceKm = null;
  if (
    origin != null &&
    Number.isFinite(origin.lat) &&
    Number.isFinite(origin.lng) &&
    Number.isFinite(lat) &&
    Number.isFinite(lng)
  ) {
    distanceKm = haversineKm(origin.lat, origin.lng, lat, lng);
  } else {
    const dims = item.distances?.() || item._distances || [];
    if (dims.length && Number.isFinite(Number(dims[0]))) {
      distanceKm = Number(dims[0]);
    }
  }

  return {
    rank,
    id,
    hash: hash || null,
    /** Distance from search origin in kilometers (null if unknown). */
    distance: distanceKm,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    count: 1,
    value,
    metrics,
  };
}


export class SearchSession {
  /**
   * @param {{ collectionName: string, hosts: string[], lat: number, lng: number, step: number }} opts
   */
  constructor({ collectionName, hosts, lat, lng, step }) {
    this.collectionName = collectionName;
    this.hosts = hosts;
    this.lat = lat;
    this.lng = lng;
    this.step = step;
    this._batch = [];
    this._local = null;
    this._network = null;
    this._ready = null;
  }

  async _ensure() {
    if (this._ready) return this._ready;
    this._ready = (async () => {
      await ensureToken();
      const { space, gps } = buildCollection(this.collectionName);
      const api = new API();
      this._network = new MeshNetwork("http", api, this.hosts);
      await this._network._ready;

      const output = {
        send: (results) => {
          for (const r of results) this._batch.push(r);
        },
      };
      const monitoring = { send: () => {} };
      const options = {
        cap: 1,
        step: this.step,
        origins: { gps: gps.newPoint([this.lat, this.lng]) },
        filters: { gps: gps.newFilter([0, 0], [0, 360]) },
      };
      this._local = new Local(
        { [this.collectionName]: space },
        options,
        output,
        monitoring,
        this._network,
      );
      return {
        peers: this._network.peerCount(),
        hosts: this._network.hosts(),
      };
    })();
    return this._ready;
  }

  /**
   * Run one Local.search() advancing by `step` nearest items.
   * @returns {Promise<{ items: ReturnType<typeof summarizeItem>[], peers: number, hosts: string[] }>}
   */
  async search(step = this.step) {
    const meta = await this._ensure();
    this.step = step;
    if (this._local?.options) this._local.options.step = step;
    this._batch = [];
    await this._local.search();
    const origin = { lat: this.lat, lng: this.lng };
    const items = this._batch.map((r, i) => summarizeItem(r, i + 1, origin));
    return { items, peers: meta.peers, hosts: meta.hosts };
  }
}

/**
 * @deprecated use SearchSession — kept for one-shot callers
 */
export async function searchNearest({
  collectionName,
  hosts,
  bootHost,
  lat,
  lng,
  step,
  session,
}) {
  const resolvedHosts = hosts?.length ? hosts : bootHost ? [bootHost] : [];
  let sess = session;
  if (!sess) {
    sess = new SearchSession({
      collectionName,
      hosts: resolvedHosts,
      lat,
      lng,
      step,
    });
  }
  const { items } = await sess.search(step);
  return { items, session: sess, local: sess };
}

export async function addGeoItem({
  collectionName,
  hosts,
  bootHost,
  lat,
  lng,
  id,
  valeurFonciere,
  surfaceM2,
}) {
  await ensureToken();
  const resolved = hosts?.length ? hosts : bootHost ? [bootHost] : [];
  const { space, gps } = buildCollection(collectionName);
  const point = [gps.newPoint([lat, lng])];
  const location = space.encode(point, 16);
  const hasPurchase =
    Number.isFinite(valeurFonciere) &&
    valeurFonciere > 0 &&
    Number.isFinite(surfaceM2) &&
    surfaceM2 > 0;
  // Purchase-shaped by default on the DVF collection; geo_load count otherwise.
  const metrics = hasPurchase
    ? dvfMetrics(valeurFonciere, surfaceM2, lat, lng)
    : collectionName === DVF_PURCHASE_COLLECTION ||
        collectionName === "DENjYsMTAyLDE2ME"
      ? dvfMetrics(250000, 80, lat, lng)
      : [1, 0, 0, lat + 90, lng + 180];
  const reference = id || `dash-${Date.now().toString(36)}`;

  const api = new API();
  const network = new MeshNetwork("http", api, resolved);
  await network.addItem(collectionName, "@", location, metrics, reference);
  return { id: reference, location, lat, lng, metrics, peers: network.peerCount() };
}
