import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createNetworkRegistry,
  slugifyNetworkId,
  uniqueNetworkId,
} from "./networkRegistry.js";

function registry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "indexus-networks-"));
  return createNetworkRegistry(path.join(dir, "networks.json"), {
    id: "primary",
    label: "Primary",
    kind: "aws",
    boot_ip: "10.0.0.1",
  });
}

test("registry persists networks, active selection and collections", () => {
  const first = registry();
  first.upsert({
    id: "lab",
    label: "Lab",
    kind: "local",
    boot_ip: "127.0.0.1",
    mon_port: 19100,
    p2p_port: 21100,
  });
  first.setActive("lab");
  first.addCollection("lab", "demo");

  const second = createNetworkRegistry(first.file, {
    id: "ignored",
    kind: "aws",
  });
  assert.equal(second.active().id, "lab");
  assert.deepEqual(second.get("lab").collections, ["demo"]);
  assert.equal(second.snapshot().networks.length, 2);
});

test("registry validates network and collection names", () => {
  const store = registry();
  assert.throws(() => store.upsert({ id: "../bad" }), /network id/);
  assert.throws(() => store.addCollection("primary", "too/unsafe"), /collection/);
  assert.throws(
    () => store.addCollection("primary", "this-name-is-far-too-long"),
    /collection/,
  );
});

test("network id is the slug of the label", () => {
  assert.equal(slugifyNetworkId("Local Lab"), "local-lab");
  assert.equal(slugifyNetworkId("Réseau AWS"), "reseau-aws");
  assert.equal(uniqueNetworkId("Local Lab", ["local-lab"]), "local-lab-2");

  const store = registry();
  const created = store.upsert({
    label: "Fresh Mesh",
    kind: "local",
    boot_ip: "127.0.0.1",
  });
  assert.equal(created.id, "fresh-mesh");
  assert.equal(created.label, "Fresh Mesh");
});

test("removing active network selects a remaining network", () => {
  const store = registry();
  store.upsert({ id: "lab", kind: "local", boot_ip: "127.0.0.1" });
  store.setActive("lab");
  store.remove("lab");
  assert.equal(store.active().id, "primary");
  store.remove("primary");
  assert.equal(store.active(), null);
  assert.equal(store.snapshot().networks.length, 0);
});
