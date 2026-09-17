async function parse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export function getMesh() {
  return fetch("/api/mesh")
    .then(parse)
    .catch((err) => {
      const msg = err?.message || String(err);
      if (/Failed to fetch|NetworkError|ERR_/i.test(msg)) {
        throw new Error("dashboard api unavailable (proxy → :3847)");
      }
      throw err;
    });
}

export function getHealth() {
  return fetch("/api/health").then(parse);
}

export function getNetworks() {
  return fetch("/api/networks").then(parse);
}

export function createNetwork(body) {
  return fetch("/api/networks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(parse);
}

export function selectNetwork(id) {
  return fetch("/api/networks/active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  }).then(parse);
}

export function networkLifecycle(id, action) {
  return fetch(
    `/api/networks/${encodeURIComponent(id)}/${encodeURIComponent(action)}`,
    { method: "POST" },
  )
    .then(parse)
    .catch((err) => {
      const msg = err?.message || String(err);
      if (/Failed to fetch|NetworkError|ERR_/i.test(msg)) {
        throw new Error(
          `${action} failed: dashboard proxy timed out or api unreachable (wake/sleep can take minutes)`,
        );
      }
      throw err;
    });
}

export function spawn(body) {
  return fetch("/api/spawn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(parse);
}

/** Resolve PreferNear hint (last load-split / name) for a peer. */
export function getPreferNear({ ip, mon, name } = {}) {
  const q = new URLSearchParams();
  if (ip) q.set("ip", ip);
  if (mon != null) q.set("mon", String(mon));
  if (name) q.set("name", name);
  return fetch(`/api/prefer-near?${q}`).then(parse);
}

export function downscale(body) {
  return fetch("/api/downscale", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(parse);
}

/** Force-kill a local or AWS spawned instance (no Drain). */
export function terminate(body) {
  return fetch("/api/terminate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(parse);
}

export function flushSnapshots(all = false) {
  return fetch("/api/snapshots/flush", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ all }),
  }).then(parse);
}

export function clearSnapshots(prefix = "") {
  return fetch("/api/snapshots/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix }),
  }).then(parse);
}

/** Permanently delete one collection from every live mesh node. */
export function deleteCollection(name) {
  return fetch("/api/collections/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).then(parse);
}

export function getCollections() {
  return fetch("/api/collections").then(parse);
}

export function createCollection(name) {
  return fetch("/api/collections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).then(parse);
}

export function issueToken() {
  return fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scopes: ["read", "write"] }),
  }).then(parse);
}

/** Start background DVF Maison|Vente load (purchase metrics). */
export function loadDvf(body) {
  return fetch("/api/dvf/load", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(parse);
}

export function getDvfStatus() {
  return fetch("/api/dvf/status").then(parse);
}

/** Pause a running DVF load (inserts stop until resume). */
export function pauseDvf() {
  return fetch("/api/dvf/pause", { method: "POST" }).then(parse);
}

/** Resume a paused DVF load. */
export function resumeDvf() {
  return fetch("/api/dvf/resume", { method: "POST" }).then(parse);
}

/** Abort a running DVF load (cannot resume). */
export function stopDvf() {
  return fetch("/api/dvf/stop", { method: "POST" }).then(parse);
}

export function getMeshConfig() {
  return fetch("/api/mesh-config").then(parse);
}

export function saveMeshConfig(config) {
  return fetch("/api/mesh-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  }).then(parse);
}

/** Restart local mesh (bootstrap + issuer + wipe spawned) with pending config. */
export function remesh(body) {
  return fetch("/api/remesh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(parse);
}

export function getRemeshStatus() {
  return fetch("/api/remesh").then(parse);
}
