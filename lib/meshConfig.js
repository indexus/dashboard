/**
 * Local mesh launch knobs — shared between dashboard UI and remesh.
 * Written as KEY=value lines to core/.data-local/mesh-config.env and sourced
 * by scripts/local/mesh_up.sh + spawn.sh.
 */

/** @typedef {object} MeshConfig */

/** @type {MeshConfig} */
export const MESH_CONFIG_DEFAULTS = {
  delegation: 5000,
  transfer_threshold: 200,
  delegation_s3: true,
  /**
   * Lab-only: WAL + object store off (INDEXUS_IN_MEMORY). Forces classic
   * Transfer and empty -storage so Count reflects only in-process items.
   */
  in_memory: false,
  delegation_timeout: "2m",
  transfer_timeout: "5m",
  queue_pressure: 50000,
  pressure_hold: "30s",
  scale_window: "60s",
  scale_down_threshold: 100,
  scale_down_hold: "15m",
  scale_cooldown: "15s",
  mem_limit_pct: 40,
  mem_floor_pct: 25,
  mem_refuse_pct: 60,
  mem_rise_pct: 2,
  mem_lead: "90s",
  cpu_limit_pct: 70,
  cpu_floor_pct: 25,
  cpu_rise_pct: 2,
  disk_min_free_pct: 35,
  rise_hold: "12s",
  /** Official owned items that force scale-up (INDEXUS_ITEMS_LIMIT). */
  items_limit: 100000,
  /**
   * Max concurrent spawned processes (issuer -spawnMax / SPAWN_MAX).
   * Bootstrap is separate — total mesh ≈ 1 + spawn_max.
   */
  spawn_max: 15,
};

/** Compact Go durations like "2m0s" → "2m". */
export function compactDuration(raw) {
  if (raw == null || raw === "") return "";
  const s = String(raw).trim();
  if (!s) return "";
  const m = s.match(
    /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i,
  );
  if (!m) return s;
  const h = parseInt(m[1] || "0", 10);
  const min = parseInt(m[2] || "0", 10);
  const sec = parseFloat(m[3] || "0");
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (min) parts.push(`${min}m`);
  if (sec && !h && !min) parts.push(`${sec}s`);
  else if (sec && (h || min) && sec !== 0) parts.push(`${Math.round(sec)}s`);
  return parts.join("") || "0s";
}

export function parseDurationSeconds(raw) {
  const s = compactDuration(raw);
  if (!s) return null;
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
  if (!m) return null;
  return (
    (parseInt(m[1] || "0", 10) || 0) * 3600 +
    (parseInt(m[2] || "0", 10) || 0) * 60 +
    (parseFloat(m[3] || "0") || 0)
  );
}

export function formatDurationSeconds(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  if (n < 60) return `${n}s`;
  if (n % 3600 === 0) return `${n / 3600}h`;
  if (n % 60 === 0) {
    const m = n / 60;
    if (m % 60 === 0) return `${m / 60}h`;
    return `${m}m`;
  }
  const m = Math.floor(n / 60);
  const r = n % 60;
  return m ? `${m}m${r}s` : `${r}s`;
}

/** Compact integer/count for slider value labels. */
export function formatCount(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

/** Percent label for sliders. */
export function formatPct(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  if (Number.isInteger(v)) return `${v}%`;
  return `${Math.round(v * 10) / 10}%`;
}

/**
 * @param {object|null|undefined} node
 * @returns {MeshConfig}
 */
export function meshConfigFromNode(node) {
  const base = { ...MESH_CONFIG_DEFAULTS };
  if (!node) return base;
  const a = node.autoscale || {};
  if (node.delegation_size != null) base.delegation = Number(node.delegation_size);
  if (node.transfer_threshold != null) {
    base.transfer_threshold = Number(node.transfer_threshold);
  }
  if (typeof node.delegation === "boolean") base.delegation_s3 = node.delegation;
  // in_memory is launch-only — not readable from a live node status.
  if (node.delegation_timeout) {
    base.delegation_timeout = compactDuration(node.delegation_timeout);
  }
  if (node.transfer_timeout) {
    base.transfer_timeout = compactDuration(node.transfer_timeout);
  }
  if (a.queue_abs != null) base.queue_pressure = Number(a.queue_abs);
  if (a.pressure_hold) base.pressure_hold = compactDuration(a.pressure_hold);
  if (a.window) base.scale_window = compactDuration(a.window);
  if (a.down_threshold != null) {
    base.scale_down_threshold = Number(a.down_threshold);
  }
  if (a.down_hold) base.scale_down_hold = compactDuration(a.down_hold);
  if (a.cooldown) base.scale_cooldown = compactDuration(a.cooldown);
  if (a.mem_limit_pct != null) base.mem_limit_pct = Number(a.mem_limit_pct);
  if (a.mem_floor_pct != null) base.mem_floor_pct = Number(a.mem_floor_pct);
  if (a.mem_refuse_pct != null) base.mem_refuse_pct = Number(a.mem_refuse_pct);
  if (a.mem_rise_pct != null) base.mem_rise_pct = Number(a.mem_rise_pct);
  if (a.mem_lead) base.mem_lead = compactDuration(a.mem_lead);
  if (a.cpu_limit_pct != null) base.cpu_limit_pct = Number(a.cpu_limit_pct);
  if (a.cpu_floor_pct != null) base.cpu_floor_pct = Number(a.cpu_floor_pct);
  if (a.cpu_rise_pct != null) base.cpu_rise_pct = Number(a.cpu_rise_pct);
  if (a.disk_min_free != null) base.disk_min_free_pct = Number(a.disk_min_free);
  if (a.rise_hold) base.rise_hold = compactDuration(a.rise_hold);
  if (a.items_limit != null) base.items_limit = Number(a.items_limit);
  return base;
}

/**
 * @param {Partial<MeshConfig>} raw
 * @returns {MeshConfig}
 */
export function normalizeMeshConfig(raw = {}) {
  const d = MESH_CONFIG_DEFAULTS;
  const num = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const pct = (v, fallback, min = 1, max = 100) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n * 10) / 10));
  };
  const dur = (v, fallback) => {
    const c = compactDuration(v);
    return c || fallback;
  };
  return {
    delegation: num(raw.delegation, d.delegation, 100, 50000),
    transfer_threshold: num(
      raw.transfer_threshold,
      d.transfer_threshold,
      1,
      100000,
    ),
    delegation_s3: raw.delegation_s3 !== false && raw.delegation_s3 !== "0",
    in_memory: raw.in_memory === true || raw.in_memory === "1" || raw.in_memory === "true",
    delegation_timeout: dur(raw.delegation_timeout, d.delegation_timeout),
    transfer_timeout: dur(raw.transfer_timeout, d.transfer_timeout),
    queue_pressure: num(raw.queue_pressure, d.queue_pressure, 0, 5000000),
    pressure_hold: dur(raw.pressure_hold, d.pressure_hold),
    scale_window: dur(raw.scale_window, d.scale_window),
    scale_down_threshold: num(
      raw.scale_down_threshold,
      d.scale_down_threshold,
      0,
      1000000,
    ),
    scale_down_hold: dur(raw.scale_down_hold, d.scale_down_hold),
    scale_cooldown: dur(raw.scale_cooldown, d.scale_cooldown),
    mem_limit_pct: pct(raw.mem_limit_pct, d.mem_limit_pct),
    mem_floor_pct: pct(raw.mem_floor_pct, d.mem_floor_pct),
    mem_refuse_pct: pct(raw.mem_refuse_pct, d.mem_refuse_pct),
    mem_rise_pct: pct(raw.mem_rise_pct, d.mem_rise_pct, 0.1, 50),
    mem_lead: dur(raw.mem_lead, d.mem_lead),
    cpu_limit_pct: pct(raw.cpu_limit_pct, d.cpu_limit_pct),
    cpu_floor_pct: pct(raw.cpu_floor_pct, d.cpu_floor_pct),
    cpu_rise_pct: pct(raw.cpu_rise_pct, d.cpu_rise_pct, 0.1, 50),
    // 0 disables the disk scale-up / admit signal (AutoscaleConfig.DiskMinFreePct > 0).
    disk_min_free_pct: pct(raw.disk_min_free_pct, d.disk_min_free_pct, 0, 100),
    rise_hold: dur(raw.rise_hold, d.rise_hold),
    items_limit: num(raw.items_limit, d.items_limit, 0, 5000000),
    spawn_max: num(raw.spawn_max, d.spawn_max, 1, 64),
  };
}

/** @param {MeshConfig} a @param {MeshConfig} b */
export function meshConfigEqual(a, b) {
  const x = normalizeMeshConfig(a);
  const y = normalizeMeshConfig(b);
  return JSON.stringify(x) === JSON.stringify(y);
}

/** @param {MeshConfig} cfg */
export function meshConfigToEnv(cfg) {
  const c = normalizeMeshConfig(cfg);
  // In-memory lab wins: no DirStore and no snapshot handoff protocol.
  const delegationS3 = c.in_memory ? false : c.delegation_s3;
  const lines = [
    `# Written by indexus dashboard — sourced by mesh_up.sh / spawn.sh`,
    `DELEGATION=${c.delegation}`,
    `INDEXUS_DELEGATION=${c.delegation}`,
    `INDEXUS_TRANSFER_THRESHOLD=${c.transfer_threshold}`,
    `INDEXUS_DELEGATION_S3=${delegationS3 ? "1" : "0"}`,
    `INDEXUS_IN_MEMORY=${c.in_memory ? "1" : "0"}`,
    `INDEXUS_DELEGATION_TIMEOUT=${c.delegation_timeout}`,
    `INDEXUS_TRANSFER_TIMEOUT=${c.transfer_timeout}`,
    `QUEUE_PRESSURE=${c.queue_pressure}`,
    `INDEXUS_QUEUE_ABS=${c.queue_pressure}`,
    `PRESSURE_HOLD=${c.pressure_hold}`,
    `INDEXUS_PRESSURE_HOLD=${c.pressure_hold}`,
    `SCALE_WINDOW=${c.scale_window}`,
    `SCALE_DOWN_THRESHOLD=${c.scale_down_threshold}`,
    `SCALE_DOWN_HOLD=${c.scale_down_hold}`,
    `SCALE_COOLDOWN=${c.scale_cooldown}`,
    `INDEXUS_MEM_LIMIT_PCT=${c.mem_limit_pct}`,
    `INDEXUS_MEM_FLOOR_PCT=${c.mem_floor_pct}`,
    `INDEXUS_MEM_REFUSE_PCT=${c.mem_refuse_pct}`,
    `INDEXUS_MEM_RISE=${c.mem_rise_pct}`,
    `INDEXUS_MEM_LEAD=${c.mem_lead}`,
    `INDEXUS_CPU_LIMIT_PCT=${c.cpu_limit_pct}`,
    `INDEXUS_CPU_FLOOR_PCT=${c.cpu_floor_pct}`,
    `INDEXUS_CPU_RISE=${c.cpu_rise_pct}`,
    `INDEXUS_DISK_MIN_FREE_PCT=${c.disk_min_free_pct}`,
    `INDEXUS_RISE_HOLD=${c.rise_hold}`,
    `INDEXUS_ITEMS_LIMIT=${c.items_limit}`,
    `SPAWN_MAX=${c.spawn_max}`,
    "",
  ];
  return lines.join("\n");
}

/** @param {string} text @returns {Partial<MeshConfig>} */
export function meshConfigFromEnvText(text) {
  /** @type {Record<string, string>} */
  const map = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    map[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return normalizeMeshConfig({
    delegation: map.DELEGATION || map.INDEXUS_DELEGATION,
    transfer_threshold: map.INDEXUS_TRANSFER_THRESHOLD,
    delegation_s3: map.INDEXUS_DELEGATION_S3,
    in_memory: map.INDEXUS_IN_MEMORY,
    delegation_timeout: map.INDEXUS_DELEGATION_TIMEOUT,
    transfer_timeout: map.INDEXUS_TRANSFER_TIMEOUT,
    queue_pressure: map.QUEUE_PRESSURE || map.INDEXUS_QUEUE_ABS,
    pressure_hold: map.PRESSURE_HOLD || map.INDEXUS_PRESSURE_HOLD,
    scale_window: map.SCALE_WINDOW,
    scale_down_threshold: map.SCALE_DOWN_THRESHOLD,
    scale_down_hold: map.SCALE_DOWN_HOLD,
    scale_cooldown: map.SCALE_COOLDOWN,
    mem_limit_pct: map.INDEXUS_MEM_LIMIT_PCT,
    mem_floor_pct: map.INDEXUS_MEM_FLOOR_PCT,
    mem_refuse_pct: map.INDEXUS_MEM_REFUSE_PCT,
    mem_rise_pct: map.INDEXUS_MEM_RISE,
    mem_lead: map.INDEXUS_MEM_LEAD,
    cpu_limit_pct: map.INDEXUS_CPU_LIMIT_PCT,
    cpu_floor_pct: map.INDEXUS_CPU_FLOOR_PCT,
    cpu_rise_pct: map.INDEXUS_CPU_RISE,
    disk_min_free_pct: map.INDEXUS_DISK_MIN_FREE_PCT,
    rise_hold: map.INDEXUS_RISE_HOLD,
    items_limit: map.INDEXUS_ITEMS_LIMIT,
    spawn_max: map.SPAWN_MAX,
  });
}
