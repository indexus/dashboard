import fs from "node:fs";
import path from "node:path";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

function cleanURL(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function normalizeCollection(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 16 || /[/\\\0\r\n]/.test(name)) return "";
  return name;
}

/** Stable network id from a human label (`Local Lab` → `local-lab`). */
export function slugifyNetworkId(label) {
  const slug = String(label || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return ID_RE.test(slug) ? slug : "";
}

/** Pick an unused slug, appending -2, -3… when needed. */
export function uniqueNetworkId(label, existingIds = []) {
  const base = slugifyNetworkId(label);
  if (!base) return "";
  const taken = new Set(
    (Array.isArray(existingIds) ? existingIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, Math.max(1, 63 - suffix.length))}${suffix}`;
    if (ID_RE.test(candidate) && !taken.has(candidate)) return candidate;
  }
  return "";
}

export function normalizeNetwork(input, defaults = {}) {
  const source = input && typeof input === "object" ? input : {};
  const labelHint = String(source.label || defaults.label || "").trim();
  const id =
    String(source.id || defaults.id || "").trim() ||
    slugifyNetworkId(labelHint);
  if (!ID_RE.test(id)) {
    throw new Error(
      "network id must be 1-63 letters, numbers, _ or - (or derived from label)",
    );
  }
  const kind = source.kind === "local" ? "local" : "aws";
  const bootIP = String(source.boot_ip ?? defaults.boot_ip ?? "").trim();
  const monPort = Math.max(
    1,
    Math.min(65535, Number(source.mon_port ?? defaults.mon_port ?? 19000) || 19000),
  );
  const p2pPort = Math.max(
    1,
    Math.min(65535, Number(source.p2p_port ?? defaults.p2p_port ?? 21000) || 21000),
  );
  const issuerURL = cleanURL(
    source.issuer_url ??
      defaults.issuer_url ??
      (bootIP ? `http://${bootIP}:22000` : ""),
  );
  const collections = [
    ...new Set(
      (Array.isArray(source.collections) ? source.collections : [])
        .map(normalizeCollection)
        .filter(Boolean),
    ),
  ];
  return {
    id,
    label: labelHint || String(defaults.label || id).trim() || id,
    kind,
    project: String(source.project || defaults.project || id).trim() || id,
    boot_ip: bootIP,
    issuer_url: issuerURL,
    mon_port: monPort,
    p2p_port: p2pPort,
    state: source.state === "asleep" ? "asleep" : "awake",
    bootstrap_instance_id: String(source.bootstrap_instance_id || "").trim() || null,
    run_dir: String(source.run_dir || defaults.run_dir || "").trim() || null,
    snapshot_dir:
      String(source.snapshot_dir || defaults.snapshot_dir || "").trim() || null,
    collections,
    created_at: source.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export function createNetworkRegistry(file, initial) {
  const registryFile = path.resolve(file);
  let data = { active: initial.id, networks: [normalizeNetwork(initial)] };

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(registryFile, "utf8"));
      if (Array.isArray(parsed?.networks)) {
        const networks = parsed.networks.map((entry) => normalizeNetwork(entry));
        data = {
          active: networks.some((entry) => entry.id === parsed.active)
            ? parsed.active
            : networks[0]?.id || "",
          networks,
        };
      }
    } catch {
      save();
    }
    return snapshot();
  }

  function save() {
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    const tmp = `${registryFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, registryFile);
  }

  function snapshot() {
    return {
      active: data.active,
      networks: data.networks.map((entry) => ({
        ...entry,
        collections: [...entry.collections],
      })),
    };
  }

  function active() {
    return (
      data.networks.find((entry) => entry.id === data.active) ||
      data.networks[0] ||
      null
    );
  }

  function get(id) {
    return data.networks.find((entry) => entry.id === id) || null;
  }

  function upsert(input) {
    const existing = get(input?.id);
    const normalized = normalizeNetwork(
      existing ? { ...existing, ...input, created_at: existing.created_at } : input,
    );
    const idx = data.networks.findIndex((entry) => entry.id === normalized.id);
    if (idx >= 0) data.networks[idx] = normalized;
    else data.networks.push(normalized);
    if (!data.active) data.active = normalized.id;
    save();
    return normalized;
  }

  function setActive(id) {
    if (!get(id)) throw new Error(`unknown network ${id}`);
    data.active = id;
    save();
    return active();
  }

  function remove(id) {
    const idx = data.networks.findIndex((entry) => entry.id === id);
    if (idx < 0) throw new Error(`unknown network ${id}`);
    const [removed] = data.networks.splice(idx, 1);
    if (data.active === id) data.active = data.networks[0]?.id || "";
    save();
    return removed;
  }

  function addCollection(id, name) {
    const entry = get(id);
    if (!entry) throw new Error(`unknown network ${id}`);
    const collection = normalizeCollection(name);
    if (!collection) throw new Error("collection name must be 1-16 safe characters");
    if (!entry.collections.includes(collection)) entry.collections.push(collection);
    entry.updated_at = new Date().toISOString();
    save();
    return collection;
  }

  function removeCollection(id, name) {
    const entry = get(id);
    if (!entry) throw new Error(`unknown network ${id}`);
    entry.collections = entry.collections.filter((item) => item !== name);
    entry.updated_at = new Date().toISOString();
    save();
  }

  load();
  return {
    file: registryFile,
    snapshot,
    active,
    get,
    upsert,
    setActive,
    remove,
    addCollection,
    removeCollection,
  };
}

export { normalizeCollection };
