/**
 * The node table, kept across sessions.
 *
 * A cold client knows two bootstrap hosts and has to earn every other route
 * through `/neighbors` and read redirects — so the first load of a session pays
 * for a table the previous one already built. Keeping a trace of it makes the
 * first read routable straight away; the mesh moves, so the trace is a hint that
 * expires, never a source of truth. A stale contact costs one failed dial and is
 * dropped from the table like any other.
 *
 * The SDK does not own this: its Network runs both on the main thread and inside
 * a worker (and in Node, where neither store exists). It only takes contacts back
 * through the `seedPeers` read option.
 *
 * Persistence is authoritative from the latest `listPeers()` snapshot: Nearby and
 * Aggregate both write their full table. Last write wins. Merging previous traces
 * back in resurrected dead peers across sessions ("ghost nodes").
 */

const KEY = "mesh-dash-peers";
/** Beyond this the trace is more likely to describe a mesh that moved on. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A browser reaches far fewer nodes than a node does; the table is bounded. */
const MAX_PEERS = 128;

function store() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Storage access throws outright when the origin has cookies blocked.
    return null;
  }
}

function keyFor(networkId = globalThis.__INDEXUS_NETWORK_ID__ || "") {
  const id = String(networkId || "").trim();
  return id ? `${KEY}:${id}` : KEY;
}

/**
 * @param {unknown} entry
 * @returns {{ name: string, ip: string, port: number } | null}
 */
function normalize(entry) {
  if (!entry || typeof entry !== "object") return null;
  const source = /** @type {Record<string, unknown>} */ (entry);
  // `listPeers()` says `hash`, `seedPeers` says `name` — accept either so the
  // worker's peer messages can be persisted without a reshape.
  const name = String(source.name ?? source.hash ?? "").trim();
  const ip = String(source.ip ?? "").trim();
  const port = Number(source.port);
  if (!name || !ip || !Number.isFinite(port) || port <= 0) return null;
  return { name, ip, port: Math.floor(port) };
}

/**
 * Contacts the last sessions ended on, for the `seedPeers` read option.
 * @returns {{ name: string, ip: string, port: number }[]}
 */
export function loadSeedPeers(networkId) {
  const local = store();
  if (!local) return [];
  const key = keyFor(networkId);
  try {
    const parsed = JSON.parse(local.getItem(key) ?? "");
    if (!parsed || !Array.isArray(parsed.peers)) return [];
    if (!(Number(parsed.savedAt) > 0)) return [];
    if (Date.now() - Number(parsed.savedAt) > MAX_AGE_MS) {
      local.removeItem(key);
      return [];
    }
    const out = [];
    const seen = new Set();
    for (const entry of parsed.peers) {
      const peer = normalize(entry);
      if (!peer || seen.has(peer.name)) continue;
      seen.add(peer.name);
      out.push(peer);
      if (out.length === MAX_PEERS) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Replace the trace with a live `listPeers()` snapshot. Newest address for a
 * name wins within the batch. An empty array clears the store so down/dead
 * peers do not resurrect on the next cold start. `null` / non-arrays are ignored.
 * @param {Array<{ name?: string, hash?: string, ip?: string, port?: number }>} peers
 */
export function saveSeedPeers(peers, networkId) {
  const local = store();
  if (!local || !Array.isArray(peers)) return;
  const key = keyFor(networkId);

  if (peers.length === 0) {
    try {
      local.removeItem(key);
      if (networkId) local.removeItem(KEY);
    } catch {
      /* ignore */
    }
    return;
  }

  /** @type {Map<string, { name: string, ip: string, port: number }>} */
  const next = new Map();
  for (const entry of peers) {
    const peer = normalize(entry);
    if (!peer || next.size >= MAX_PEERS) {
      if (peer && next.has(peer.name)) next.set(peer.name, peer);
      continue;
    }
    next.set(peer.name, peer);
  }
  if (next.size === 0) return;

  try {
    local.setItem(
      key,
      JSON.stringify({ savedAt: Date.now(), peers: [...next.values()] }),
    );
  } catch {
    /* quota or private mode — the trace is an optimisation, not a requirement */
  }
}

/**
 * Drop any persisted contact whose name is not in the live peer table.
 * @param {Iterable<string>} aliveNames
 */
export function pruneSeedPeers(aliveNames, networkId) {
  const alive = new Set(
    [...(aliveNames || [])].map((name) => String(name || "").trim()).filter(Boolean),
  );
  const id = networkId ?? globalThis.__INDEXUS_NETWORK_ID__ ?? "";
  const current = loadSeedPeers(id);
  if (!current.length) return;
  const kept = current.filter((peer) => alive.has(peer.name));
  if (kept.length === current.length) return;
  saveSeedPeers(kept, id);
}

/** Remove one manually forgotten contact from the next session's seed table. */
export function forgetSeedPeer(hash, networkId) {
  const name = String(hash || "").trim();
  if (!name) return false;
  const local = store();
  if (!local) return false;
  const id = networkId ?? globalThis.__INDEXUS_NETWORK_ID__ ?? "";
  const key = keyFor(id);
  const remaining = loadSeedPeers(id).filter((peer) => peer.name !== name);
  try {
    if (remaining.length === 0) {
      local.removeItem(key);
    } else {
      local.setItem(
        key,
        JSON.stringify({ savedAt: Date.now(), peers: remaining }),
      );
    }
    // Legacy unscoped key from before network-scoped traces.
    if (id) {
      const legacy = loadSeedPeers("").filter((peer) => peer.name !== name);
      if (legacy.length === 0) local.removeItem(KEY);
      else {
        local.setItem(
          KEY,
          JSON.stringify({ savedAt: Date.now(), peers: legacy }),
        );
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function clearSeedPeers(networkId) {
  const local = store();
  if (!local) return;
  try {
    const id = networkId ?? globalThis.__INDEXUS_NETWORK_ID__ ?? "";
    local.removeItem(keyFor(id));
    // Always drop the legacy unscoped key — ghosts often live there.
    local.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export const PEER_STORE_KEY = KEY;
export const PEER_STORE_MAX_AGE_MS = MAX_AGE_MS;
export const PEER_STORE_MAX_PEERS = MAX_PEERS;
