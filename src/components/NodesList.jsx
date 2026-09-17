import { useEffect, useMemo, useRef, useState } from "react";
import {
  forgetSeedPeer,
  pruneSeedPeers,
} from "../lib/indexus/peerStore.js";

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

function samePeerList(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].host !== b[i].host || a[i].ingress !== b[i].ingress) return false;
  }
  return true;
}

/**
 * Aggregate / Data side panel: known client peers + live request pulse.
 *
 * @param {{
 *   controller?: {
 *     subscribeNetwork?: (fn: Function) => () => void,
 *     forgetPeer?: (hash: string) => boolean,
 *   },
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
  const prevHashesRef = useRef(new Set());

  function onForget(row) {
    if (!row?.hash || !controller?.forgetPeer) return;
    // Remove the cross-session trace first; the worker's membership event can
    // then persist the smaller table without resurrecting this contact.
    const networkId = globalThis.__INDEXUS_NETWORK_ID__ || "";
    forgetSeedPeer(row.hash, networkId);
    stateRef.current.delete(row.key);
    setPeers((previous) =>
      previous.filter((peer) => peer.hash !== row.hash)
    );
    controller.forgetPeer(row.hash);
    setTick((n) => n + 1);
  }

  useEffect(() => {
    if (!controller?.subscribeNetwork) return undefined;
    return controller.subscribeNetwork((snap) => {
      const list = Array.isArray(snap?.peers) ? snap.peers : [];
      const networkId = globalThis.__INDEXUS_NETWORK_ID__ || "";
      const alive = new Set(
        list.map((peer) => peer?.hash).filter(Boolean),
      );

      // Peers that left the live table (unreachable / Drain) leave the UI
      // and the browser seed cache immediately.
      const previous = prevHashesRef.current;
      for (const hash of previous) {
        if (!alive.has(hash)) forgetSeedPeer(hash, networkId);
      }
      pruneSeedPeers(alive, networkId);
      prevHashesRef.current = alive;

      for (const [key, row] of [...stateRef.current.entries()]) {
        if (row.hash && !alive.has(row.hash) && (row.inFlight || 0) === 0) {
          stateRef.current.delete(key);
        }
      }

      // Identity changes on every worker message; only re-render on real
      // membership changes or the map fights the pan for frames.
      setPeers((prev) => (samePeerList(prev, list) ? prev : list));
      setRoutingKey((prev) => snap?.routingKey ?? prev);

      const events = Array.isArray(snap?.activityEvents)
        ? snap.activityEvents
        : snap?.activity
          ? [snap.activity]
          : [];
      let touched = false;
      const map = stateRef.current;
      const at = performance.now();

      for (const activity of events) {
        if (!activity?.host && !activity?.hash) continue;
        // Failed dials against peers already dropped from the table must not
        // reappear as ghost rows.
        if (activity.hash && alive.size > 0 && !alive.has(activity.hash)) {
          if (activity.phase === "end" && activity.ok === false) {
            forgetSeedPeer(activity.hash, networkId);
          }
          continue;
        }
        const key =
          activity.host || `${activity.ip}|${activity.port}` || activity.hash;
        if (!key) continue;
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
          row.lastActiveAt = at;
        } else if (activity.phase === "end") {
          row.inFlight = Math.max(0, row.inFlight - 1);
          row.lastActiveAt = at;
          row.lastOk = activity.ok !== false;
          if (activity.ok === false && activity.hash) {
            forgetSeedPeer(activity.hash, networkId);
          }
        }
        touched = true;
      }
      if (touched) setTick((n) => n + 1);
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
    const aliveHosts = new Set();

    for (const p of peers) {
      const key = p.host || `${p.ip}|${p.port}` || p.hash;
      if (!key) continue;
      aliveHosts.add(key);
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
        inTable: true,
      });
    }

    // In-flight activity for a host still in the table only — never revive
    // down peers as activity-only ghost rows.
    for (const [key, live] of stateRef.current) {
      if (byHost.has(key) || !aliveHosts.has(key)) continue;
      if ((live.inFlight || 0) <= 0) continue;
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
        inTable: false,
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
            {row.inTable && row.hash && controller?.forgetPeer ? (
              <button
                type="button"
                className="node-forget"
                onClick={() => onForget(row)}
                title="Oublier ce nœud pour cette session"
                aria-label={`Oublier le nœud ${row.hash}`}
              >
                ×
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
