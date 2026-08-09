import { useEffect, useState } from "react";

function pct(ratio) {
  if (!Number.isFinite(ratio)) return "—";
  return `${Math.round(ratio * 100)}%`;
}

function ms(n) {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 10) return `${n.toFixed(1)} ms`;
  return `${Math.round(n)} ms`;
}

function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function signed(n) {
  if (!Number.isFinite(n)) return "—";
  return n > 0 ? `+${n}` : String(n);
}

function age(ts) {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ${s % 60}s ago`;
}

function Row({ label, value, hint }) {
  return (
    <div className="client-metrics-row" title={hint}>
      <span className="client-metrics-label">{label}</span>
      <span className="client-metrics-value">{value}</span>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="client-metrics-section">
      <h3 className="client-metrics-title">{title}</h3>
      <div className="client-metrics-grid">{children}</div>
    </section>
  );
}

/**
 * Aggregate Metrics tab — live client read-path counters from the worker Network.
 *
 * @param {{
 *   controller?: { subscribeNetwork?: (fn: Function) => () => void },
 *   empty?: string,
 * }} props
 */
export default function ClientMetrics({
  controller,
  empty = "en attente du client…",
}) {
  const [snap, setSnap] = useState(null);

  useEffect(() => {
    if (!controller?.subscribeNetwork) return undefined;
    return controller.subscribeNetwork((next) => {
      if (next?.metrics) setSnap(next.metrics);
    });
  }, [controller]);

  if (!snap) {
    return (
      <div className="client-metrics" aria-label="client metrics">
        <div className="hit meta" style={{ color: "var(--fog)" }}>
          {empty}
        </div>
      </div>
    );
  }

  return (
    <div className="client-metrics" aria-label="client metrics">
      <div className="client-metrics-mode">
        <span>{snap.navigation || "—"}</span>
        <span aria-hidden="true">·</span>
        <span>{snap.method || "—"}</span>
        {snap.refreshTtlMs != null ? (
          <>
            <span aria-hidden="true">·</span>
            <span title="refresh TTL floor">ttl {snap.refreshTtlMs}ms</span>
          </>
        ) : null}
      </div>

      <Section title="Cache">
        <Row
          label="sets cached"
          value={`${snap.cacheSize} / ${snap.cacheCapacity}`}
          hint="Parent zones held in the Network LRU"
        />
        <Row
          label="in flight"
          value={`${snap.inFlight} req · ${snap.inflightZones} zones`}
          hint="HTTP getSets open now, and zones waiting on a shared wave"
        />
        <Row
          label="cache hits"
          value={snap.cacheHits}
          hint="Locations answered locally without a new wire hop"
        />
        <Row
          label="TTL hits"
          value={snap.ttlHits}
          hint="refresh=true served from a still-fresh cache entry"
        />
        <Row
          label="hit ratio"
          value={pct(snap.hitRatio)}
          hint="cacheHits / (cacheHits + locationsRequested)"
        />
      </Section>

      <Section title="Requests">
        <Row
          label="wire getSets"
          value={snap.requests}
          hint="HTTP /sets calls started"
        />
        <Row label="ok / err" value={`${snap.responsesOk} / ${snap.responsesErr}`} />
        <Row
          label="locations asked"
          value={snap.locationsRequested}
          hint="Sum of parent locations on the wire"
        />
        <Row
          label="coalesced joins"
          value={snap.coalescedJoins}
          hint="Callers that joined an in-flight wave (avoided duplicate HTTP)"
        />
        <Row
          label="dup avoided"
          value={pct(snap.dupRatio)}
          hint="coalescedJoins / (requests + coalescedJoins)"
        />
        <Row
          label="peers touched"
          value={snap.peersTouched}
          hint="Distinct peers that answered at least one getSets"
        />
        <Row
          label="redirects"
          value={`${snap.redirects} · followed ${snap.redirectFollows}`}
          hint="IXS1 redirects received vs hops actually followed (direct)"
        />
      </Section>

      <Section title="Latency">
        <Row label="last" value={ms(snap.lastLatencyMs)} />
        <Row label="avg" value={ms(snap.latencyAvgMs)} />
        <Row label="p50" value={ms(snap.latencyP50Ms)} />
        <Row label="p95" value={ms(snap.latencyP95Ms)} />
      </Section>

      <Section title="Payload">
        <Row
          label="avg packet"
          value={bytes(snap.bytesAvg)}
          hint="Mean /sets response — decoded binary frame, no JSON involved"
        />
        <Row label="last / max" value={`${bytes(snap.lastBytes)} / ${bytes(snap.bytesMax)}`} />
        <Row
          label="avg on wire"
          value={bytes(snap.wireBytesAvg)}
          hint="Content-Length of the answer: compressed size when the node gzips"
        />
        <Row
          label="compression"
          value={
            snap.compressionRatio > 0 ? `${snap.compressionRatio.toFixed(2)}×` : "—"
          }
          hint="decoded / transferred — 1.00× means the answer came uncompressed"
        />
        <Row
          label="total"
          value={bytes(snap.bytesTotal)}
          hint="Decoded bytes pulled since the client started"
        />
        <Row
          label="per location"
          value={bytes(snap.bytesPerLocation)}
          hint="bytesTotal / locations asked"
        />
        <Row
          label="per row"
          value={bytes(snap.bytesPerRow)}
          hint="bytesTotal / decoded Set+Item rows"
        />
        <Row label="rows decoded" value={snap.rowsTotal ?? 0} />
      </Section>

      <Section title="Deltas">
        <Row
          label="zones updated"
          value={snap.zonesUpdated}
          hint="Refresh stores where Abelian count moved"
        />
        <Row
          label="|Δ| sum"
          value={snap.deltaAbsSum}
          hint="Sum of absolute count deltas on refresh"
        />
        <Row
          label="last Δ"
          value={
            snap.lastDeltaLocation
              ? `${signed(snap.lastDelta)} @ ${snap.lastDeltaLocation}`
              : "—"
          }
          hint={age(snap.lastDeltaAt)}
        />
      </Section>

      <Section title="Reconcile">
        <Row label="passes" value={snap.reconcilePasses} />
        <Row
          label="quiet / dirty"
          value={`${snap.reconcileQuiet} / ${snap.reconcileDirty}`}
          hint="Quiet = root Abelian matched, no subzone walk"
        />
        <Row label="last root Δ" value={signed(snap.lastRootDelta)} />
        <Row label="last pass" value={ms(snap.lastReconcileMs)} />
        <Row label="last at" value={age(snap.lastReconcileAt)} />
      </Section>
    </div>
  );
}
