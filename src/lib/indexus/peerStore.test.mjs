/**
 * The node-table trace: what survives a reload, what expires, what is refused.
 */

import test from "node:test";
import assert from "node:assert/strict";

function installStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
  return map;
}

const store = installStorage();
const {
  loadSeedPeers,
  saveSeedPeers,
  forgetSeedPeer,
  clearSeedPeers,
  pruneSeedPeers,
  PEER_STORE_KEY,
  PEER_STORE_MAX_AGE_MS,
  PEER_STORE_MAX_PEERS,
} = await import("./peerStore.js");

test("a saved table comes back as seedPeers", () => {
  clearSeedPeers();
  saveSeedPeers([
    { hash: "AAAAAAAAAAAAAAAA", ip: "10.0.0.1", port: 21000, host: "x", ingress: true },
    { name: "BBBBBBBBBBBBBBBB", ip: "10.0.0.2", port: 21002 },
  ]);
  assert.deepEqual(loadSeedPeers(), [
    { name: "AAAAAAAAAAAAAAAA", ip: "10.0.0.1", port: 21000 },
    { name: "BBBBBBBBBBBBBBBB", ip: "10.0.0.2", port: 21002 },
  ]);
});

test("a later listPeers snapshot replaces the trace (no ghost merge)", () => {
  clearSeedPeers();
  saveSeedPeers([{ name: "AAAAAAAAAAAAAAAA", ip: "10.0.0.1", port: 21000 }]);
  saveSeedPeers([{ name: "BBBBBBBBBBBBBBBB", ip: "10.0.0.2", port: 21002 }]);
  assert.deepEqual(loadSeedPeers().map((p) => p.name), ["BBBBBBBBBBBBBBBB"]);
});

test("a node that moved keeps its name and gains its new address", () => {
  clearSeedPeers();
  saveSeedPeers([{ name: "AAAAAAAAAAAAAAAA", ip: "10.0.0.1", port: 21000 }]);
  saveSeedPeers([{ name: "AAAAAAAAAAAAAAAA", ip: "10.9.9.9", port: 21099 }]);
  assert.deepEqual(loadSeedPeers(), [
    { name: "AAAAAAAAAAAAAAAA", ip: "10.9.9.9", port: 21099 },
  ]);
});

test("contacts without a name, address or port are refused", () => {
  clearSeedPeers();
  saveSeedPeers([
    { name: "AAAAAAAAAAAAAAAA", ip: "10.0.0.1", port: 21000 },
    { name: "", ip: "10.0.0.2", port: 21002 },
    { name: "CCCCCCCCCCCCCCCC", ip: "", port: 21003 },
    { name: "DDDDDDDDDDDDDDDD", ip: "10.0.0.4", port: 0 },
    { name: "EEEEEEEEEEEEEEEE", ip: "10.0.0.5", port: "nope" },
    null,
  ]);
  assert.deepEqual(loadSeedPeers(), [
    { name: "AAAAAAAAAAAAAAAA", ip: "10.0.0.1", port: 21000 },
  ]);
});

test("a trace older than its window is dropped rather than trusted", () => {
  clearSeedPeers();
  store.set(
    PEER_STORE_KEY,
    JSON.stringify({
      savedAt: Date.now() - PEER_STORE_MAX_AGE_MS - 1000,
      peers: [{ name: "AAAAAAAAAAAAAAAA", ip: "10.0.0.1", port: 21000 }],
    })
  );
  assert.deepEqual(loadSeedPeers(), []);
  assert.equal(store.has(PEER_STORE_KEY), false, "expired trace is cleaned up");
});

test("junk in storage reads as no trace", () => {
  clearSeedPeers();
  store.set(PEER_STORE_KEY, "{not json");
  assert.deepEqual(loadSeedPeers(), []);
  store.set(PEER_STORE_KEY, JSON.stringify({ peers: "nope" }));
  assert.deepEqual(loadSeedPeers(), []);
  store.set(PEER_STORE_KEY, JSON.stringify({ peers: [] }));
  assert.deepEqual(loadSeedPeers(), []);
});

test("the trace stays bounded — a browser reaches fewer nodes than a node does", () => {
  clearSeedPeers();
  const many = [];
  for (let i = 0; i < PEER_STORE_MAX_PEERS + 40; i++) {
    many.push({
      name: `peer${String(i).padStart(11, "0")}`,
      ip: `10.1.${Math.floor(i / 256)}.${i % 256}`,
      port: 21000 + i,
    });
  }
  saveSeedPeers(many);
  assert.equal(loadSeedPeers().length, PEER_STORE_MAX_PEERS);
});

test("an empty listPeers snapshot clears the trace (down peers gone)", () => {
  clearSeedPeers();
  saveSeedPeers([{ name: "AAAAAAAAAAAAAAAA", ip: "10.0.0.1", port: 21000 }]);
  saveSeedPeers([]);
  assert.equal(loadSeedPeers().length, 0);
  saveSeedPeers([{ name: "BBBBBBBBBBBBBBBB", ip: "10.0.0.2", port: 21002 }]);
  saveSeedPeers(null);
  assert.equal(loadSeedPeers().length, 1, "null is an idle tick, not a clear");
});

test("pruneSeedPeers drops names no longer in the live table", () => {
  clearSeedPeers();
  saveSeedPeers([
    { name: "AAAAAAAAAAAAAAAA", ip: "10.0.0.1", port: 21000 },
    { name: "BBBBBBBBBBBBBBBB", ip: "10.0.0.2", port: 21002 },
  ]);
  pruneSeedPeers(["BBBBBBBBBBBBBBBB"]);
  assert.deepEqual(loadSeedPeers().map((p) => p.name), ["BBBBBBBBBBBBBBBB"]);
});

test("a manually forgotten peer is removed from the next session", () => {
  clearSeedPeers();
  saveSeedPeers([
    { name: "AAAAAAAAAAAAAAAA", ip: "10.0.0.1", port: 21000 },
    { name: "BBBBBBBBBBBBBBBB", ip: "10.0.0.2", port: 21002 },
  ]);

  assert.equal(forgetSeedPeer("AAAAAAAAAAAAAAAA"), true);
  assert.deepEqual(loadSeedPeers(), [
    { name: "BBBBBBBBBBBBBBBB", ip: "10.0.0.2", port: 21002 },
  ]);
  assert.equal(forgetSeedPeer("BBBBBBBBBBBBBBBB"), true);
  assert.deepEqual(loadSeedPeers(), []);
  assert.equal(store.has(PEER_STORE_KEY), false);
});

test("peer traces are isolated by network id", () => {
  clearSeedPeers("network-a");
  clearSeedPeers("network-b");
  saveSeedPeers(
    [{ name: "AAAAAAAAAAAAAAAA", ip: "10.0.0.1", port: 21000 }],
    "network-a",
  );
  saveSeedPeers(
    [{ name: "BBBBBBBBBBBBBBBB", ip: "10.0.0.2", port: 21000 }],
    "network-b",
  );
  assert.deepEqual(loadSeedPeers("network-a").map((peer) => peer.name), [
    "AAAAAAAAAAAAAAAA",
  ]);
  assert.deepEqual(loadSeedPeers("network-b").map((peer) => peer.name), [
    "BBBBBBBBBBBBBBBB",
  ]);
});
