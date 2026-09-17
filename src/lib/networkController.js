/**
 * Bridge a main-thread Network into the same subscribeNetwork shape Aggregate
 * exposes from the worker (NodesList / ClientMetrics).
 *
 * @param {import("js-indexus-sdk").Network} network
 * @param {{
 *   metricsIntervalMs?: number,
 *   activityFlushMs?: number,
 *   onPeersChanged?: (peers: object[]) => void,
 * }} [opts]
 */
export function attachNetworkController(network, opts = {}) {
  if (!network) {
    throw new Error("attachNetworkController requires a Network");
  }

  const metricsIntervalMs = Number.isFinite(opts.metricsIntervalMs)
    ? Math.max(250, Math.floor(opts.metricsIntervalMs))
    : 1000;
  const activityFlushMs = Number.isFinite(opts.activityFlushMs)
    ? Math.max(16, Math.floor(opts.activityFlushMs))
    : 80;

  const subscribers = new Set();
  let snap = {
    peers: typeof network.listPeers === "function" ? network.listPeers() : [],
    activity: null,
    activityEvents: null,
    metrics: typeof network.readMetrics === "function" ? network.readMetrics() : null,
    routingKey:
      typeof network.routingKeyHash === "function" ? network.routingKeyHash() : null,
  };

  let pendingActivity = [];
  let activityTimer = null;
  let metricsTimer = null;

  function notify() {
    for (const subscriber of subscribers) {
      try {
        subscriber(snap);
      } catch {
        /* ignore */
      }
    }
  }

  function flushActivity() {
    activityTimer = null;
    if (pendingActivity.length === 0) return;
    const events = pendingActivity;
    pendingActivity = [];
    snap = {
      ...snap,
      activity: events[events.length - 1],
      activityEvents: events,
      activityAt: performance.now(),
    };
    notify();
  }

  if (typeof network.setActivityHandler === "function") {
    network.setActivityHandler((ev) => {
      pendingActivity.push(ev);
      if (pendingActivity.length > 200) pendingActivity.shift();
      if (activityTimer == null) {
        activityTimer = setTimeout(flushActivity, activityFlushMs);
      }
    });
  }

  if (typeof network.setPeersHandler === "function") {
    network.setPeersHandler((peers) => {
      const nextPeers = Array.isArray(peers) ? peers : [];
      opts.onPeersChanged?.(nextPeers);
      snap = {
        ...snap,
        peers: nextPeers,
        routingKey:
          typeof network.routingKeyHash === "function"
            ? network.routingKeyHash()
            : snap.routingKey,
      };
      notify();
    });
  }

  if (typeof network.setMetricsHandler === "function") {
    network.setMetricsHandler((metrics) => {
      snap = { ...snap, metrics: metrics || null };
      notify();
    });
  }

  if (typeof network.readMetrics === "function") {
    metricsTimer = setInterval(() => {
      snap = { ...snap, metrics: network.readMetrics() };
      notify();
    }, metricsIntervalMs);
  }

  // Initial push so Nodes/Metrics have peers+counters before the first query.
  notify();

  return {
    subscribeNetwork(handler) {
      if (typeof handler !== "function") return () => {};
      subscribers.add(handler);
      handler(snap);
      return () => subscribers.delete(handler);
    },
    forgetPeer(hash) {
      return typeof network.forgetPeer === "function"
        ? network.forgetPeer(hash)
        : false;
    },
    dispose() {
      if (typeof network.setActivityHandler === "function") {
        network.setActivityHandler(null);
      }
      if (typeof network.setPeersHandler === "function") {
        network.setPeersHandler(null);
      }
      if (typeof network.setMetricsHandler === "function") {
        network.setMetricsHandler(null);
      }
      if (activityTimer != null) {
        clearTimeout(activityTimer);
        activityTimer = null;
      }
      if (metricsTimer != null) {
        clearInterval(metricsTimer);
        metricsTimer = null;
      }
      subscribers.clear();
    },
  };
}
