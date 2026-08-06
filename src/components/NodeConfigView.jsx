/**
 * Ops side-panel kv views.
 * - Live: per-node identity + capacity + signals (pulse)
 * - Config: editable network launch knobs + remesh CTA
 */
import Tip from "./Tip.jsx";
import {
  formatCount,
  formatDurationSeconds,
  formatPct,
  meshConfigEqual,
  parseDurationSeconds,
} from "../lib/meshConfig.js";

const fmt = (n) => {
  if (n == null || n === "" || (typeof n === "number" && Number.isNaN(n))) {
    return "—";
  }
  if (typeof n === "boolean") return n ? "yes" : "no";
  if (typeof n === "number") {
    if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
    if (Number.isInteger(n)) return String(n);
    return String(Math.round(n * 10) / 10);
  }
  return String(n);
};

function fmtUptime(s) {
  if (s == null || !Number.isFinite(s)) return "—";
  const sec = Math.max(0, Math.floor(s));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const r = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

function Row({ label, tip, value }) {
  return (
    <Tip tip={tip} className="ops-kv-row">
      <span className="ops-kv-label">{label}</span>
      <span className="ops-kv-value">{value}</span>
    </Tip>
  );
}

function Group({ title, tip, children }) {
  return (
    <section className="ops-kv-group">
      <Tip tip={tip} as="h3" className="ops-kv-group-title">
        {title}
      </Tip>
      <div className="ops-kv-rows">{children}</div>
    </section>
  );
}

function SliderRow({ label, tip, valueLabel, children, dirty }) {
  return (
    <Tip
      tip={tip}
      as="label"
      className={`ops-kv-ctrl${dirty ? " is-dirty" : ""}`}
    >
      <span className="ops-kv-ctrl-head">
        <span className="ops-kv-label">{label}</span>
        {valueLabel != null ? (
          <em className="ops-kv-ctrl-value">{valueLabel}</em>
        ) : null}
      </span>
      {children}
    </Tip>
  );
}

function CheckRow({ label, tip, checked, onChange, dirty }) {
  return (
    <Tip
      tip={tip}
      as="label"
      className={`ops-kv-ctrl ops-kv-ctrl--check${dirty ? " is-dirty" : ""}`}
    >
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="ops-kv-label">{label}</span>
    </Tip>
  );
}

function LiveView({ node }) {
  const a = node.autoscale || {};
  const pressure = a.pressure || {};

  return (
    <div className="ops-kv data-map-kv scroll-fade">
      <Group
        title="Identity"
        tip="Who this peer is on the mesh and how to reach its monitoring / P2P ports."
      >
        <Row label="name" tip="BASE64 node id on the XOR ring." value={fmt(node.name)} />
        <Row label="role" tip="bootstrap or spawned." value={fmt(node.role)} />
        <Row label="host" tip="ip|p2pPort contact." value={fmt(node.host)} />
        <Row
          label="mon"
          tip="Monitoring HTTP port."
          value={node.ip && node.mon != null ? `${node.ip}:${node.mon}` : "—"}
        />
        <Row label="instance" tip="local-N or cloud instance id." value={fmt(node.instance_id)} />
        <Row label="version" tip="Binary / build version." value={fmt(node.version)} />
        <Row label="uptime" tip="Process uptime." value={fmtUptime(node.uptime_s)} />
        <Row label="ready" tip="client_ready after join." value={fmt(node.client_ready)} />
        <Row label="leaving" tip="SoftLeave in progress." value={fmt(node.leaving)} />
        <Row
          label="rebalancing"
          tip="Ownership moving across zones."
          value={fmt(node.rebalancing)}
        />
      </Group>

      <Group title="Capacity" tip="Live load on this node.">
        <Row
          label="items"
          tip="Official serving item count (excludes prep)."
          value={fmt(node.items)}
        />
        <Row
          label="items prep"
          tip="Inbound snapshot items not yet SwitchAck'd."
          value={fmt(node.items_prep)}
        />
        <Row
          label="items limit"
          tip="Configured owned-item scale-up threshold (INDEXUS_ITEMS_LIMIT)."
          value={
            node.autoscale?.items_limit != null && node.autoscale.items_limit > 0
              ? fmt(node.autoscale.items_limit)
              : "—"
          }
        />
        <Row label="zones" tip="Owned zones." value={fmt(node.zones)} />
        <Row label="collections" tip="Distinct collections owned." value={fmt(node.collections)} />
        <Row label="peers" tip="Registered contacts." value={fmt(node.peers)} />
        <Row label="queue" tip="Ingress backlog." value={fmt(node.queue)} />
        <Row
          label="mem %"
          tip="Memory pressure sample."
          value={node.mem_pct != null ? `${fmt(node.mem_pct)}%` : "—"}
        />
        <Row
          label="cpu %"
          tip="CPU pressure sample."
          value={node.cpu_pct != null ? `${fmt(node.cpu_pct)}%` : "—"}
        />
        <Row
          label="mem projected"
          tip="Projected memory %."
          value={
            node.mem_projected != null ? `${fmt(node.mem_projected)}%` : "—"
          }
        />
        <Row label="deleg in" tip="Inbound delegation sessions." value={fmt(node.deleg_in)} />
        <Row label="deleg out" tip="Outbound delegation sessions." value={fmt(node.deleg_out)} />
        <Row label="snap dirty" tip="Dirty snapshot zones." value={fmt(node.snap_dirty)} />
        <Row label="snap zones" tip="Zones with a snapshot seq." value={fmt(node.snap_zones)} />
        <Row label="wal segments" tip="WAL segments retained." value={fmt(node.wal_segments)} />
      </Group>

      <Group title="Signals" tip="Live controller state.">
        <Row
          label="hot signal"
          tip="Pressure / hot classification."
          value={fmt(node.hot_signal || pressure.hot_signal)}
        />
        <Row
          label="last reason"
          tip="Last scale decision reason."
          value={fmt(a.last_reason || node.last_reason)}
        />
        <Row
          label="prefer near"
          tip="Last load-split PreferNear (weighted zone dichotomy)."
          value={fmt(a.last_prefer_near || node.prefer_near)}
        />
        <Row label="rising fast" tip="Fast rise detected." value={fmt(a.rising_fast)} />
        <Row label="admit blocked" tip="Writes refused." value={fmt(a.admit_blocked)} />
        <Row
          label="scale ups done"
          tip="Successful scale-ups since start."
          value={fmt(a.scale_ups_done ?? node.scale_ups_done)}
        />
        <Row
          label="up in flight"
          tip="Scale-up pending."
          value={fmt(a.up_in_flight ?? node.up_in_flight)}
        />
        <Row
          label="down in flight"
          tip="SoftLeave pending."
          value={fmt(a.down_in_flight ?? node.down_in_flight)}
        />
        <Row label="last up" tip="Last scale-up time." value={fmt(a.last_up_at)} />
        <Row label="last down" tip="Last SoftLeave time." value={fmt(a.last_down_at)} />
      </Group>
    </div>
  );
}

function DurationSlider({
  label,
  tip,
  value,
  onChange,
  minSec,
  maxSec,
  step = 5,
  dirty,
}) {
  const sec = parseDurationSeconds(value) ?? minSec;
  return (
    <SliderRow
      label={label}
      tip={tip}
      valueLabel={formatDurationSeconds(sec)}
      dirty={dirty}
    >
      <input
        type="range"
        min={minSec}
        max={maxSec}
        step={step}
        value={Math.min(maxSec, Math.max(minSec, sec))}
        onChange={(e) => onChange(formatDurationSeconds(Number(e.target.value)))}
      />
    </SliderRow>
  );
}

/**
 * Editable network launch config.
 * @param {{
 *   draft: object,
 *   live: object|null,
 *   onChange: (next: object) => void,
 *   onReset: () => void,
 *   onRemesh: (opts: { keep_snapshots: boolean }) => void,
 *   remeshBusy?: boolean,
 *   remeshMsg?: string,
 *   keepSnapshots: boolean,
 *   onKeepSnapshots: (v: boolean) => void,
 * }} props
 */
export function MeshConfigEditor({
  draft,
  live,
  onChange,
  remeshMsg,
  keepSnapshots,
  onKeepSnapshots,
}) {
  if (!draft) {
    return (
      <div className="ops-kv-empty">
        No network config yet — wait for mesh pulse.
      </div>
    );
  }

  const dirty = live ? !meshConfigEqual(draft, live) : true;
  const set = (key, value) => onChange({ ...draft, [key]: value });
  const isDirty = (key) => {
    if (live == null || live[key] == null) return false;
    return String(draft[key]) !== String(live[key]);
  };

  return (
    <div className="ops-kv data-map-kv scroll-fade">
      <Group
        title="Zones & handoff"
        tip="Zone size and snapshot handoff. Applied via INDEXUS_DELEGATION / TRANSFER_* at process start."
      >
        <SliderRow
          label="zone size"
          tip="Soft item count before a location range is owned / may split (DELEGATION). Default 5k."
          valueLabel={formatCount(draft.delegation)}
          dirty={isDirty("delegation")}
        >
          <input
            type="range"
            min={500}
            max={50000}
            step={500}
            value={draft.delegation}
            onChange={(e) => set("delegation", Number(e.target.value))}
          />
        </SliderRow>
        <SliderRow
          label="transfer threshold"
          tip="Zones at/above this count use snapshot handoff vs classic /transfer."
          valueLabel={formatCount(draft.transfer_threshold)}
          dirty={isDirty("transfer_threshold")}
        >
          <input
            type="range"
            min={1}
            max={5000}
            step={1}
            value={draft.transfer_threshold}
            onChange={(e) => set("transfer_threshold", Number(e.target.value))}
          />
        </SliderRow>
        <CheckRow
          label="snapshot handoff"
          tip="Enable S3 / DirStore snapshot handoff protocol (INDEXUS_DELEGATION_S3)."
          checked={draft.delegation_s3}
          onChange={(v) => set("delegation_s3", v)}
          dirty={isDirty("delegation_s3")}
        />
        <DurationSlider
          label="handoff timeout"
          tip="Max lifetime of a snapshot handoff session."
          value={draft.delegation_timeout}
          onChange={(v) => set("delegation_timeout", v)}
          minSec={30}
          maxSec={1800}
          step={30}
          dirty={isDirty("delegation_timeout")}
        />
        <DurationSlider
          label="transfer timeout"
          tip="HTTP client timeout for classic item /transfer."
          value={draft.transfer_timeout}
          onChange={(v) => set("transfer_timeout", v)}
          minSec={30}
          maxSec={3600}
          step={30}
          dirty={isDirty("transfer_timeout")}
        />
      </Group>

      <Group
        title="Resources"
        tip="Memory / CPU / disk pressure and owned-item capacity that trigger scale-up."
      >
        <SliderRow
          label="items limit"
          tip="Official owned items on this node that force a scale-up even without mem/CPU pressure (INDEXUS_ITEMS_LIMIT). 0 disables."
          valueLabel={
            draft.items_limit <= 0 ? "off" : formatCount(draft.items_limit)
          }
          dirty={isDirty("items_limit")}
        >
          <input
            type="range"
            min={0}
            max={500000}
            step={5000}
            value={draft.items_limit}
            onChange={(e) => set("items_limit", Number(e.target.value))}
          />
        </SliderRow>
        <SliderRow
          label="mem limit %"
          tip="Soft memory target: projected mem above this (with floor + hold) triggers scale-up."
          valueLabel={formatPct(draft.mem_limit_pct)}
          dirty={isDirty("mem_limit_pct")}
        >
          <input
            type="range"
            min={10}
            max={95}
            step={1}
            value={draft.mem_limit_pct}
            onChange={(e) => set("mem_limit_pct", Number(e.target.value))}
          />
        </SliderRow>
        <SliderRow
          label="mem floor %"
          tip="Memory % below which soft pressure is ignored (noise floor)."
          valueLabel={formatPct(draft.mem_floor_pct)}
          dirty={isDirty("mem_floor_pct")}
        >
          <input
            type="range"
            min={0}
            max={80}
            step={1}
            value={draft.mem_floor_pct}
            onChange={(e) => set("mem_floor_pct", Number(e.target.value))}
          />
        </SliderRow>
        <SliderRow
          label="mem refuse %"
          tip="Hard memory %: refuse client writes (GuardMemory) and instant emergency scale-up."
          valueLabel={formatPct(draft.mem_refuse_pct)}
          dirty={isDirty("mem_refuse_pct")}
        >
          <input
            type="range"
            min={20}
            max={99}
            step={1}
            value={draft.mem_refuse_pct}
            onChange={(e) => set("mem_refuse_pct", Number(e.target.value))}
          />
        </SliderRow>
        <SliderRow
          label="mem rise %"
          tip="Memory rise rate threshold that contributes to rising_fast."
          valueLabel={formatPct(draft.mem_rise_pct)}
          dirty={isDirty("mem_rise_pct")}
        >
          <input
            type="range"
            min={0.5}
            max={20}
            step={0.5}
            value={draft.mem_rise_pct}
            onChange={(e) => set("mem_rise_pct", Number(e.target.value))}
          />
        </SliderRow>
        <DurationSlider
          label="mem lead"
          tip="Look-ahead when projecting memory growth (mem_projected)."
          value={draft.mem_lead}
          onChange={(v) => set("mem_lead", v)}
          minSec={15}
          maxSec={600}
          step={15}
          dirty={isDirty("mem_lead")}
        />
        <SliderRow
          label="cpu limit %"
          tip="CPU % above which the node is under CPU pressure."
          valueLabel={formatPct(draft.cpu_limit_pct)}
          dirty={isDirty("cpu_limit_pct")}
        >
          <input
            type="range"
            min={10}
            max={99}
            step={1}
            value={draft.cpu_limit_pct}
            onChange={(e) => set("cpu_limit_pct", Number(e.target.value))}
          />
        </SliderRow>
        <SliderRow
          label="cpu floor %"
          tip="CPU % below which pressure is ignored."
          valueLabel={formatPct(draft.cpu_floor_pct)}
          dirty={isDirty("cpu_floor_pct")}
        >
          <input
            type="range"
            min={0}
            max={80}
            step={1}
            value={draft.cpu_floor_pct}
            onChange={(e) => set("cpu_floor_pct", Number(e.target.value))}
          />
        </SliderRow>
        <SliderRow
          label="cpu rise %"
          tip="CPU rise rate threshold for rising_fast."
          valueLabel={formatPct(draft.cpu_rise_pct)}
          dirty={isDirty("cpu_rise_pct")}
        >
          <input
            type="range"
            min={0.5}
            max={20}
            step={0.5}
            value={draft.cpu_rise_pct}
            onChange={(e) => set("cpu_rise_pct", Number(e.target.value))}
          />
        </SliderRow>
        <SliderRow
          label="disk min free %"
          tip="Minimum free disk %; below this the node signals pressure / may refuse work."
          valueLabel={formatPct(draft.disk_min_free_pct)}
          dirty={isDirty("disk_min_free_pct")}
        >
          <input
            type="range"
            min={5}
            max={80}
            step={1}
            value={draft.disk_min_free_pct}
            onChange={(e) => set("disk_min_free_pct", Number(e.target.value))}
          />
        </SliderRow>
        <DurationSlider
          label="rise hold"
          tip="How long a rise signal must persist before it counts as sustained pressure."
          value={draft.rise_hold}
          onChange={(v) => set("rise_hold", v)}
          minSec={3}
          maxSec={120}
          step={1}
          dirty={isDirty("rise_hold")}
        />
      </Group>

      <Group
        title="Autoscale timing"
        tip="Insert window, scale-down guards, cooldowns. Restart mesh to apply."
      >
        <SliderRow
          label="spawn max"
          tip="Max concurrent spawned processes (issuer SPAWN_MAX). Bootstrap is separate — mesh size ≈ 1 + spawn max. Hit this and scale-up returns 409."
          valueLabel={formatCount(draft.spawn_max)}
          dirty={isDirty("spawn_max")}
        >
          <input
            type="range"
            min={1}
            max={32}
            step={1}
            value={draft.spawn_max}
            onChange={(e) => set("spawn_max", Number(e.target.value))}
          />
        </SliderRow>
        <SliderRow
          label="queue abs"
          tip="Queue backlog that blocks scale-down (queuePressure). Not a scale-up trigger; SoftLeave drains on its own deadline."
          valueLabel={formatCount(draft.queue_pressure)}
          dirty={isDirty("queue_pressure")}
        >
          <input
            type="range"
            min={0}
            max={200000}
            step={1000}
            value={draft.queue_pressure}
            onChange={(e) => set("queue_pressure", Number(e.target.value))}
          />
        </SliderRow>
        <SliderRow
          label="down threshold"
          tip="Scale down when inserts in the window stay below this."
          valueLabel={formatCount(draft.scale_down_threshold)}
          dirty={isDirty("scale_down_threshold")}
        >
          <input
            type="range"
            min={0}
            max={5000}
            step={10}
            value={draft.scale_down_threshold}
            onChange={(e) =>
              set("scale_down_threshold", Number(e.target.value))
            }
          />
        </SliderRow>
        <DurationSlider
          label="window"
          tip="Sliding window used to count inserts (scaleWindow)."
          value={draft.scale_window}
          onChange={(v) => set("scale_window", v)}
          minSec={15}
          maxSec={600}
          step={15}
          dirty={isDirty("scale_window")}
        />
        <DurationSlider
          label="down hold"
          tip="How long the scale-down condition must hold before SoftLeave."
          value={draft.scale_down_hold}
          onChange={(v) => set("scale_down_hold", v)}
          minSec={60}
          maxSec={3600}
          step={60}
          dirty={isDirty("scale_down_hold")}
        />
        <DurationSlider
          label="cooldown"
          tip="Quiet period after a scale-up before another spawn."
          value={draft.scale_cooldown}
          onChange={(v) => set("scale_cooldown", v)}
          minSec={15}
          maxSec={900}
          step={15}
          dirty={isDirty("scale_cooldown")}
        />
        <DurationSlider
          label="pressure hold"
          tip="How long a resource signal must last before asking for a node."
          value={draft.pressure_hold}
          onChange={(v) => set("pressure_hold", v)}
          minSec={5}
          maxSec={300}
          step={5}
          dirty={isDirty("pressure_hold")}
        />
      </Group>

      <Group
        title="Restart"
        tip="Tear down issuer + bootstrap + spawned, then mesh_up with these knobs. Use the footer actions."
      >
        <CheckRow
          label="keep snapshots"
          tip="Preserve .data-local/snapshots across remesh (node data under nodes/ is still wiped)."
          checked={keepSnapshots}
          onChange={onKeepSnapshots}
        />
        {remeshMsg ? (
          <div className="ops-kv-banner ops-kv-banner--log">{remeshMsg}</div>
        ) : null}
      </Group>
    </div>
  );
}

/**
 * @param {{
 *   node: object|null,
 *   mode?: "live" | "config",
 *   configProps?: object,
 * }} props
 */
export default function NodeConfigView({
  node,
  mode = "live",
  configProps,
}) {
  if (mode === "config") {
    return <MeshConfigEditor {...(configProps || {})} />;
  }
  if (!node) {
    return (
      <div className="ops-kv-empty">
        No node data yet — wait for mesh pulse or select a node.
      </div>
    );
  }
  return <LiveView node={node} />;
}
