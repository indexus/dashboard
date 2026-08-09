import { useEffect, useRef } from "react";
import { formatDistanceKm } from "../lib/sdk.js";
import { useOverlayScroll } from "../lib/overlayScroll.js";

/**
 * Right-hand Data panel: Contrôles ↔ Items ↔ Nodes ↔ Metrics
 * for both Nearby and Aggregate.
 */
export default function DataSidePanel({
  view,
  onView,
  controls,
  items,
  nodes = null,
  metrics = null,
  itemCount = 0,
  nodeCount = 0,
  metricsHint = null,
  onAddClick,
  controlsLabel = "Contrôles",
  itemsLabel = "Items",
  nodesLabel = "Nodes",
  metricsLabel = "Metrics",
}) {
  const bodyRef = useOverlayScroll([view]);
  const showNodes = nodes != null;
  const showMetrics = metrics != null;

  let body = items;
  if (view === "controls") body = controls;
  else if (view === "nodes" && showNodes) body = nodes;
  else if (view === "metrics" && showMetrics) body = metrics;

  return (
    <aside className="data-side" aria-label="data side panel">
      <div className="data-side-head">
        <div className="data-side-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === "controls"}
            className={view === "controls" ? "active" : ""}
            onClick={() => onView("controls")}
          >
            {controlsLabel}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "items"}
            className={view === "items" ? "active" : ""}
            onClick={() => onView("items")}
          >
            {itemsLabel}
            {itemCount > 0 ? (
              <span className="data-side-count">{itemCount}</span>
            ) : null}
          </button>
          {showNodes ? (
            <button
              type="button"
              role="tab"
              aria-selected={view === "nodes"}
              className={view === "nodes" ? "active" : ""}
              onClick={() => onView("nodes")}
            >
              {nodesLabel}
              {nodeCount > 0 ? (
                <span className="data-side-count">{nodeCount}</span>
              ) : null}
            </button>
          ) : null}
          {showMetrics ? (
            <button
              type="button"
              role="tab"
              aria-selected={view === "metrics"}
              className={view === "metrics" ? "active" : ""}
              onClick={() => onView("metrics")}
            >
              {metricsLabel}
              {metricsHint != null && metricsHint !== "" ? (
                <span className="data-side-count">{metricsHint}</span>
              ) : null}
            </button>
          ) : null}
        </div>
        {onAddClick ? (
          <button
            type="button"
            className="icon-btn"
            title="Add item"
            aria-label="Add item"
            onClick={onAddClick}
          >
            +
          </button>
        ) : null}
      </div>
      <div className="data-side-body scroll-fade" ref={bodyRef}>
        {body}
      </div>
    </aside>
  );
}

function sameHit(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id && a.rank === b.rank) return true;
  if (a.lat == null || b.lat == null || a.lng == null || b.lng == null) {
    return false;
  }
  return (
    Math.abs(a.lat - b.lat) < 1e-7 &&
    Math.abs(a.lng - b.lng) < 1e-7 &&
    (a.rank == null || b.rank == null || a.rank === b.rank)
  );
}

/** Generic hit title — no collection / DVF assumptions. */
export function hitTitle(h, index = 0) {
  if (!h) return "item";
  const rank = h.rank ?? index + 1;
  const id = h.id || h.hash || "";
  return id ? `#${rank} ${id}` : `#${rank}`;
}

/**
 * Generic detail lines for list selection / map tooltip.
 * Shows raw value, optional metrics[], measure metadata — not €/m² labels.
 */
export function hitDetailLines(h) {
  if (!h) return [];
  const lines = [];
  const meta = [];
  const dist = formatDistanceKm(h.distance);
  if (dist) meta.push(dist);
  if (h.count != null && h.count !== 1) meta.push(`n=${h.count}`);
  if (h.value != null && Number.isFinite(Number(h.value))) {
    meta.push(`v=${Number(h.value).toFixed(2)}`);
  }
  if (h.measure) meta.push(h.measure);
  if (meta.length) lines.push(meta.join(" · "));

  if (Array.isArray(h.metrics) && h.metrics.length) {
    const parts = h.metrics.map((m, i) => {
      const n = Number(m);
      if (!Number.isFinite(n)) return `m${i}=${m}`;
      return `m${i}=${Number.isInteger(n) ? n : n.toFixed(2)}`;
    });
    lines.push(parts.join(" · "));
  }

  if (h.metricIndex != null || h.normalizer != null) {
    const bits = [];
    if (h.metricIndex != null) bits.push(`metric[${h.metricIndex}]`);
    if (h.normalizer != null) bits.push(`norm=${h.normalizer}`);
    if (bits.length) lines.push(bits.join(" · "));
  }

  if (h.lat != null && h.lng != null) {
    lines.push(`${Number(h.lat).toFixed(5)}, ${Number(h.lng).toFixed(5)}`);
  }
  return lines;
}

export function HitDetail({ hit, index = 0, className = "dataset-selected" }) {
  if (!hit) return null;
  const lines = hitDetailLines(hit);
  return (
    <div className={className}>
      <div className="id">{hitTitle(hit, index)}</div>
      {lines.map((line, i) => (
        <div className="meta" key={`${i}-${line}`}>
          {line}
        </div>
      ))}
    </div>
  );
}

/** Shared scrollable hit / point list with optional infinite-scroll sentinel. */
export function HitsList({
  hits = [],
  selected,
  onFocus,
  onHover,
  empty = "aucun item",
  max = 200,
  onLoadMore,
  hasMore = false,
  loadingMore = false,
}) {
  const sentinelRef = useRef(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !onLoadMore || !hasMore) return undefined;

    const root = el.closest(".data-side-body");
    let cancelled = false;

    const io = new IntersectionObserver(
      (entries) => {
        if (cancelled || loadingMore || !hasMore) return;
        if (entries.some((e) => e.isIntersecting)) onLoadMore();
      },
      { root: root || null, rootMargin: "64px", threshold: 0 },
    );

    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [onLoadMore, hasMore, loadingMore, hits.length]);

  if (!hits.length) {
    return (
      <div className="hit meta" style={{ color: "var(--fog)" }}>
        {empty}
      </div>
    );
  }

  const rest = hits.filter((h) => !sameHit(h, selected));
  const shown = rest.slice(0, max);
  const truncated = rest.length > max;

  return (
    <div className="hits-list">
      {selected ? (
        <HitDetail hit={selected} className="dataset-selected" />
      ) : null}
      {shown.map((h, i) => {
        const key = `${h.rank ?? i}-${h.id ?? ""}-${h.lat}-${h.lng}`;
        const lines = hitDetailLines(h);
        return (
          <div
            className="hit"
            key={key}
            onClick={() => onFocus?.(h)}
            onMouseEnter={() => onHover?.(h)}
            onMouseLeave={() => onHover?.(null)}
            onFocus={() => onHover?.(h)}
            onBlur={() => onHover?.(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onFocus?.(h);
            }}
            role="button"
            tabIndex={0}
          >
            <div className="id">{hitTitle(h, i)}</div>
            {lines[0] ? <div className="meta">{lines[0]}</div> : null}
          </div>
        );
      })}
      {truncated ? (
        <div className="hit meta" style={{ color: "var(--fog)" }}>
          … {rest.length - max} more
        </div>
      ) : null}
      {onLoadMore && hasMore ? (
        <div
          ref={sentinelRef}
          className="hits-sentinel"
          aria-hidden="true"
        >
          {loadingMore ? (
            <span className="hit meta" style={{ color: "var(--fog)" }}>
              loading…
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Nearby-only knobs for the Contrôles tab. */
export function NearbyControls({
  origin,
  step,
  onStep,
  normalizer,
  onNormalizer,
  auto,
  onAuto,
  onQuery,
  onNext,
  canNext,
  busy,
}) {
  return (
    <section className="data-rail-section">
      <div className="data-metrics">
        <div>
          <span>origine</span>{" "}
          {origin?.lat != null
            ? `${origin.lat.toFixed(4)}, ${origin.lng.toFixed(4)}`
            : "—"}
        </div>
        <div>
          <span>hint</span> clic carte pour déplacer l’origine
        </div>
      </div>
      <label className="data-ctrl-slider">
        <span className="data-ctrl-label">
          Normalizer €/m² <em>{normalizer}</em>
        </span>
        <input
          type="range"
          min={1000}
          max={30000}
          step={500}
          value={normalizer}
          onChange={(e) => onNormalizer(Number(e.target.value))}
          title="Plafond de saturation couleur (€/m²)"
        />
      </label>
      <label className="data-ctrl-slider">
        <span className="data-ctrl-label">
          Step <em>{step}</em>
        </span>
        <input
          type="range"
          min={1}
          max={50}
          step={1}
          value={step}
          onChange={(e) => onStep(Number(e.target.value))}
        />
      </label>
      <label className="data-ctrl-check">
        <input
          type="checkbox"
          checked={!!auto}
          onChange={(e) => onAuto(e.target.checked)}
        />
        <span>Auto-query</span>
      </label>
      <div className="data-side-actions">
        <button
          type="button"
          className="ghost compact"
          disabled={busy}
          onClick={onQuery}
        >
          Query
        </button>
        <button
          type="button"
          className="ghost compact"
          disabled={busy || !canNext}
          onClick={onNext}
        >
          Next
        </button>
      </div>
    </section>
  );
}

/**
 * Convert flat overlay points [lng,lat,v,…] to hit-shaped rows.
 * Optional stats attach measure metadata (metric index / normalizer).
 */
export function pointsToHits(points, stats = null) {
  if (!points?.length) return [];
  const out = [];
  const metricIndex = stats?.valueMetricIndex ?? stats?.metricIndex ?? null;
  const normalizer = stats?.normalizer ?? null;
  const measure =
    metricIndex != null ? `measure m[${metricIndex}]` : "measure";
  for (let i = 0; i + 2 < points.length; i += 3) {
    out.push({
      rank: out.length + 1,
      kind: "item",
      lng: points[i],
      lat: points[i + 1],
      value: points[i + 2],
      measure,
      metricIndex,
      normalizer,
    });
  }
  return out;
}
