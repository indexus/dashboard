import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  itemOrigin,
  itemZoneKey,
  mergePeerTables,
  nearestForKey,
  nextReadyBase,
  newRoutingKey,
  originBucket,
  peerIsRoutable,
  regionOwnerBase,
  rememberRegionOwner,
} from "./mesh_route.js";

const require = createRequire(import.meta.url);
const { encodeUrl64 } = require("js-indexus-sdk");

const COL = "DvFMV2020idx0001";
const WEST = "7xmD4zoqo5mppmvz";
const WEST_KIN = "7xmD4zoqo5mppmvA";
const EAST = "1ZmK3abcde123456";
const SOUTH = "quW9xyzabc654321";

function peer(hash, base, id) {
  return { hash, base, id };
}

function ownerOnLocation(name, base, location) {
  return peer(name, base, itemZoneKey(COL, location));
}

test("mergePeerTables unions by hash and prefers the newer row", () => {
  const a = { hash: "aa", base: "http://1.1.1.1:21000", id: Buffer.from("aa") };
  const b = { hash: "bb", base: "http://2.2.2.2:21000", id: Buffer.from("bb") };
  const a2 = { hash: "aa", base: "http://1.1.1.9:21000", id: Buffer.from("aa") };
  const merged = mergePeerTables([a], [b, a2]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((p) => p.hash === "aa").base, a2.base);
  assert.ok(merged.some((p) => p.hash === "bb"));
});

test("newRoutingKey matches BASE64 identifier width", () => {
  const k = newRoutingKey();
  assert.equal(k.length, 12);
  assert.equal(encodeUrl64(k).length, 16);
});

test("itemOrigin is the item zone, not a client session seed", () => {
  const a = itemOrigin(COL, WEST);
  const b = itemOrigin(COL, WEST);
  const c = itemOrigin(COL, EAST);
  const session = encodeUrl64(newRoutingKey());
  assert.equal(a, b, "same location must reuse the same origin");
  assert.notEqual(a, c, "different locations must not share an origin");
  assert.notEqual(a, session, "must not be a random client key");
  assert.deepEqual(itemZoneKey(COL, WEST), itemZoneKey(COL, WEST));
  assert.ok(itemZoneKey(COL, WEST).length > 0);
});

test("originBucket groups sibling locations so lookup is per region", () => {
  assert.equal(originBucket(COL, WEST), originBucket(COL, WEST_KIN));
  assert.notEqual(originBucket(COL, WEST), originBucket(COL, EAST));
});

test("nearestForKey returns a peer for an encoded location", () => {
  const id = Buffer.alloc(12, 1);
  const peers = [{ hash: "p0", base: "http://10.0.0.1:21000", id }];
  const p = nearestForKey(peers, COL, WEST);
  assert.equal(p.hash, "p0");
});

test("write goes to the zone owner, not the bootstrap seed", () => {
  const seed = peer("seed", "http://seed:21000", Buffer.alloc(12, 0));
  const west = ownerOnLocation("west", "http://west:21000", WEST);
  const east = ownerOnLocation("east", "http://east:21000", EAST);
  const south = ownerOnLocation("south", "http://south:21000", SOUTH);
  const mesh = [seed, west, east, south];

  assert.equal(nearestForKey(mesh, COL, WEST).base, "http://west:21000");
  assert.equal(nearestForKey(mesh, COL, WEST_KIN).base, "http://west:21000");
  assert.equal(nearestForKey(mesh, COL, EAST).base, "http://east:21000");
  assert.equal(nearestForKey(mesh, COL, SOUTH).base, "http://south:21000");
});

test("uneven mesh: pressure follows item locations, not the seed", () => {
  const seed = peer("seed", "http://seed:21000", Buffer.alloc(12, 0xff));
  const west = ownerOnLocation("west", "http://west:21000", WEST);
  const peers = [seed, west];
  const dest = { seed: 0, west: 0 };
  for (const loc of [WEST, WEST_KIN, WEST, WEST_KIN, WEST]) {
    dest[nearestForKey(peers, COL, loc).hash]++;
  }
  assert.equal(dest.west, 5, "all west items must hit the west owner");
  assert.equal(dest.seed, 0, "seed must not absorb a region it does not own");
});

test("client_ready from ping is enough to hop (p2p has no write_ready)", () => {
  const seed = new Set(["http://seed:21000"]);
  const joiner = {
    base: "http://127.0.0.1:21010",
    clientReady: false,
    writeReady: false,
  };
  const owner = {
    base: "http://127.0.0.1:21010",
    clientReady: true,
    writeReady: true,
  };
  assert.equal(peerIsRoutable(joiner, seed), false);
  assert.equal(peerIsRoutable(owner, seed), true);
  assert.equal(
    peerIsRoutable({ base: "http://seed:21000", clientReady: false }, seed),
    true
  );
});

test("without the zone owner in the table, XOR may fall back to seed", () => {
  const seed = peer("seed", "http://seed:21000", Buffer.alloc(12, 0));
  const p = nearestForKey([seed], COL, WEST);
  assert.equal(p.hash, "seed");
});

test("201 hint merges the owner so XOR leaves the emptied donor", () => {
  const donor = peer("donor", "http://donor:21000", Buffer.alloc(12, 0xff));
  const owner = ownerOnLocation("west", "http://west:21000", WEST);
  assert.equal(nearestForKey([donor], COL, WEST).base, "http://donor:21000");
  const merged = mergePeerTables([donor], [owner]);
  assert.equal(
    nearestForKey(merged, COL, WEST).base,
    "http://west:21000",
    "hinted owner must win XOR over the emptied donor"
  );
});

test("region sticky helpers still expire (unused by pick)", () => {
  const map = new Map();
  const now = 1_000_000;
  rememberRegionOwner(map, COL, WEST, "http://west:21000", 8000, now);
  assert.equal(regionOwnerBase(map, COL, WEST, now), "http://west:21000");
  assert.equal(regionOwnerBase(map, COL, WEST, now + 8001), null);
});

test("nextReadyBase round-robins client_ready peers instead of XOR magnet", () => {
  const seed = "http://seed:21000";
  const magnet = "http://magnet:21000";
  const other = "http://other:21000";
  const seedSet = new Set([seed]);
  const peers = [
    { base: seed, clientReady: true, writeReady: true },
    { base: magnet, clientReady: true, writeReady: true },
    { base: other, clientReady: true, writeReady: true },
  ];
  assert.equal(nextReadyBase(peers, 0, null, seedSet, seed), seed);
  assert.equal(nextReadyBase(peers, 1, null, seedSet, seed), magnet);
  assert.equal(nextReadyBase(peers, 2, null, seedSet, seed), other);
  assert.equal(nextReadyBase(peers, 3, null, seedSet, seed), seed);
  const avoid = new Set([magnet]);
  assert.equal(nextReadyBase(peers, 1, avoid, seedSet, seed), other);
  const notReady = [
    ...peers.slice(0, 2),
    { base: other, clientReady: false, writeReady: false },
  ];
  assert.notEqual(nextReadyBase(notReady, 0, null, seedSet, seed), other);
  assert.notEqual(nextReadyBase(notReady, 1, null, seedSet, seed), other);
  assert.notEqual(nextReadyBase(notReady, 2, null, seedSet, seed), other);
});
