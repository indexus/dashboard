import { useEffect, useMemo, useRef, useState } from "react";

/** Hold full color after last request, then fade to transparent. */
const HOT_MS = 1200;
const FADE_MS = 2800;

/**
 * Stable pastel from peer hash (or host) for the activity flash.
 * @param {string} key
 */
function colorForKey(key) {
  let h = 0;
  const s = String(key || "");
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue} 58% 48%)`;
}

function activityOpacity(lastActiveAt, now, inFlight) {
  if (inFlight > 0) return 1;
  if (!lastActiveAt) return 0;
  const age = now - lastActiveAt;
  if (age <= HOT_MS) return 1;
  if (age >= HOT_MS + FADE_MS) return 0;
  return 1 - (age - HOT_MS) / FADE_MS;
}

/**
 * Aggregate / Data side panel: known client peers + live request pulse.
 *
 * @param {{
 *   controller?: { subscribeNetwork?: (fn: Function) => () => void },
 *   empty?: string,
 * }} props
 */
export default function NodesList({
  controller,
  empty = "aucun nœud connu…",
}) {
  const [peers, setPeers] = useState([]);
  const [routingKey, setRoutingKey] = useState(null);
  const [tick, setTick] = useState(0);
  const stateRef = useRef(new Map());

  useEffect(() => {
    if (!controller?.subscribeNetwork) return undefined;
    return controller.subscribeNetwork((snap) => {
      const list = Array.isArray(snap?.peers) ? snap.peers : [];
      setPeers(list);
      setRoutingKey((prev) => snap?.routingKey ?? prev);

      const activity = snap?.activity;
      if (!activity?.host && !activity?.hash) return;

      const key = activity.host || `${activity.ip}|${activity.port}` || activity.hash;
      if (!key) return;
      const map = stateRef.current;
      let row = map.get(key);
      if (!row) {
        row = {
          key,
          hash: activity.hash || null,
          ip: activity.ip || null,
          port: activity.port || null,
          host: activity.host || key,
          inFlight: 0,
          lastActiveAt: 0,
          lastMethod: null,
          lastOk: null,
        };
        map.set(key, row);
      }
      if (activity.hash) row.hash = activity.hash;
      if (activity.ip) row.ip = activity.ip;
      if (activity.port != null) row.port = activity.port;
      if (activity.host) row.host = activity.host;
      row.lastMethod = activity.method || row.lastMethod;

      if (activity.phase === "start") {
        row.inFlight += 1;
        row.lastActiveAt = performance.now();
      } else if (activity.phase === "end") {
        row.inFlight = Math.max(0, row.inFlight - 1);
        row.lastActiveAt = performance.now();
        row.lastOk = activity.ok !== false;
      }
      setTick((n) => n + 1);
    });
  }, [controller]);

  // Drive fade animation while any node is still cooling down.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const now = performance.now();
      let needs = false;
      for (const row of stateRef.current.values()) {
        if (row.inFlight > 0) {
          needs = true;
          break;
        }
        if (row.lastActiveAt && now - row.lastActiveAt < HOT_MS + FADE_MS) {
          needs = true;
          break;
        }
      }
      if (needs) {
        setTick((n) => n + 1);
        raf = requestAnimationFrame(loop);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tick, peers.length]);

  const rows = useMemo(() => {
    const now = performance.now();
    const byHost = new Map();

    for (const p of peers) {
      const key = p.host || `${p.ip}|${p.port}` || p.hash;
      if (!key) continue;
      const live = stateRef.current.get(key);
      byHost.set(key, {
        key,
        hash: p.hash || live?.hash || null,
        ip: p.ip ?? live?.ip,
        port: p.port ?? live?.port,
        host: p.host || key,
        ingress: !!p.ingress,
        inFlight: live?.inFlight || 0,
        lastActiveAt: live?.lastActiveAt || 0,
        lastMethod: live?.lastMethod || null,
        lastOk: live?.lastOk,
        opacity: activityOpacity(live?.lastActiveAt, now, live?.inFlight || 0),
        color: colorForKey(p.hash || key),
      });
    }

    // Activity-only peers not yet in table (race during ping).
    for (const [key, live] of stateRef.current) {
      if (byHost.has(key)) continue;
      byHost.set(key, {
        key,
        hash: live.hash,
        ip: live.ip,
        port: live.port,
        host: live.host || key,
        ingress: false,
        inFlight: live.inFlight,
        lastActiveAt: live.lastActiveAt,
        lastMethod: live.lastMethod,
        lastOk: live.lastOk,
        opacity: activityOpacity(live.lastActiveAt, now, live.inFlight),
        color: colorForKey(live.hash || key),
      });
    }

    return Array.from(byHost.values()).sort((a, b) => {
      if (a.ingress !== b.ingress) return a.ingress ? -1 : 1;
      return String(a.hash || a.host).localeCompare(String(b.hash || b.host));
    });
    // tick forces recompute for fade
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peers, tick]);

  const clientKey = routingKey ? (
    <div
      className="node-client-key"
      title="clé de session du client — l'ingress est le nœud le plus proche de cette clé"
    >
      <span className="node-client-key__label">clé client</span>
      <span className="node-client-key__value">{routingKey}</span>
    </div>
  ) : null;

  if (!rows.length) {
    return (
      <div className="nodes-list" aria-label="mesh nodes">
        {clientKey}
        <div className="hit meta" style={{ color: "var(--fog)" }}>
          {empty}
        </div>
      </div>
    );
  }

  return (
    <div className="nodes-list" aria-label="mesh nodes">
      {clientKey}
      {rows.map((row) => {
        const shortHash = row.hash
          ? row.hash.length > 10
            ? `${row.hash.slice(0, 6)}…${row.hash.slice(-4)}`
            : row.hash
          : "—";
        const active = row.opacity > 0.05;
        return (
          <div
            key={row.key}
            className={`node-row${active ? " node-row--active" : ""}${
              row.inFlight > 0 ? " node-row--inflight" : ""
            }${row.ingress ? " node-row--ingress" : ""}`}
            style={{
              "--node-flash": row.color,
              "--node-flash-alpha": String(row.opacity),
            }}
          >
            <span className="node-dot" aria-hidden="true" />
            <div className="node-body">
              <div className="node-id">
                {shortHash}
                {row.ingress ? (
                  <span className="node-ingress-tag" title="read ingress (session seed)">
                    {" "}
                    ingress
                  </span>
                ) : null}
              </div>
              <div className="node-meta">
                {row.ip}:{row.port}
                {row.inFlight > 0
                  ? ` · ${row.lastMethod || "req"} ×${row.inFlight}`
                  : row.lastMethod
                    ? ` · ${row.lastMethod}${
                        row.lastOk === false ? " ✗" : ""
                      }`
                    : ""}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
