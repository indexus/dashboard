// Network.js

import { Network as BaseNetwork, API } from "../model/index.js";
import { Table } from "./table.js";
import { Peer } from "./peer.js";
import { Throttler } from "./throttler.js";
import { parent, ROOT, transform } from "../utilities/encoding.js";
import { distributeElementsByParent } from "../api/decodeSetsBinary.js";
import { SetsCoalescePool } from "./setsCoalescePool.js";

function randomRoutingKey(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLength; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

/**
 * Represents the network abstraction that manages peer-to-peer interactions.
 * This class extends the base Network class and handles peer selection, retries,
 * and maintaining the routing table with throttled network calls.
 */
class Network extends BaseNetwork {
  /**
   * Constructs a new Network instance.
   * @param {string} protocol - The protocol identifier.
   * @param {API} api - The API instance used for network requests.
   * @param {string[]} hosts - An array of bootstrap hosts to initialize the network.
   * @param {number} concurrency - The maximum number of concurrent network calls.
   * @param {number} cacheSize - The maximum number of sets to keep in the cache.
   * @param {{
   *   setsMaxChunkSize?: number,
   *   setsMaxParallelChunks?: number,
   * }} [setsPoolOptions] - tuning for merged `/sets` batching (see SetsCoalescePool).
   */
  constructor(
    protocol,
    api,
    hosts,
    concurrency = 50,
    cacheSize = 1000,
    setsPoolOptions = {}
  ) {
    super();

    this._protocol = protocol;
    this._api = api;
    this._hosts = hosts;
    this._table = new Table();
    this._attempts = 3;

    this._concurrency = concurrency;

    // Initialize the throttler with the specified concurrency limit
    this._throttler = new Throttler(this._concurrency);

    // Session seed: XOR-nearest peer is the read ingress (traffic spread).
    this._routingKey = randomRoutingKey(16);

    // Initialize the cache with a maximum size
    this._cache = new Map();
    this._cacheSize = cacheSize;

    const poolCfg =
      setsPoolOptions && typeof setsPoolOptions === "object" ? setsPoolOptions : {};

    this._setsPool = new SetsCoalescePool({
      maxChunkSize:
        Number(poolCfg.setsMaxChunkSize) > 0
          ? Math.floor(poolCfg.setsMaxChunkSize)
          : 96,
      maxParallelChunks:
        Number(poolCfg.setsMaxParallelChunks) > 0
          ? Math.floor(poolCfg.setsMaxParallelChunks)
          : Math.min(this._concurrency, 16),
      fetchChunk: (coll, locs) => this._fetchSetsChunk(coll, locs),
      finalizeWaiter: (coll, waiter) => this._finalizeSetsWaiter(coll, waiter),
    });

    // Initialize the network by searching for peers (await via whenReady / getSet).
    this._ready = this.discoverPeers();
  }

  /**
   * Resolves once the initial bootstrap peer discovery attempt finishes.
   * @returns {Promise<void>}
   */
  whenReady() {
    return this._ready ?? Promise.resolve();
  }

  getConcurrency() {
    return this._concurrency;
  }

  /**
   * Initializes the network by searching for peers and populating the routing table.
   */
  async discoverPeers() {
    try {
      const bootstraps = [];

      // Wrap each pingPeer call with the throttler's enqueue method
      const tasks = this._hosts.map((host) =>
        this._throttler.enqueue(`pingPeer:${host}`, async () => {
          try {
            const [ip, port] = host.split("|");
            const peer = await this._api.pingPeer(this._protocol, ip, port);
            bootstraps.push(peer);
          } catch (error) {
            console.warn(`Failed to add bootstrap peer with host ${host}.`);
          }
        })
      );

      // Wait for all throttled pingPeer tasks to complete
      await Promise.all(tasks);

      if (bootstraps.length === 0) {
        // If all attempts fail, throw an error
        throw new Error("Failed to find peers with bootstrap hosts.");
      }
      bootstraps.forEach((peer) => this._table.insert(peer.id(), peer));
    } catch (error) {
      console.error("Error initializing peers:", error);
    }
  }

  /**
   * Adds an item to a collection at a specific location in the network.
   * If the operation fails, it retries with a different peer.
   * @param {string} collection - The name of the collection.
   * @param {string} root - The targeted root set.
   * @param {string} location - The location identifier within the collection.
   * @param {number[]} metrics - The metrics of the item to add.
   * @param {string} reference - The unique identifier of the item to add.
   * @returns {Promise<void>}
   */
  async addItem(collection, root, location, metrics, reference) {
    let attempts = this._attempts;

    const id = transform(collection, location);

    while (true) {
      // Find the nearest peer to the id
      let peer = this._table.nearest(id);

      if (!peer) {
        await this.discoverPeers();
        peer = this._table.nearest(id);
      }

      try {
        // Generate a unique key for addItem
        const addItemKey = `addItem:${collection}:${root}:${location}:${reference}`;

        // Wrap the addItem API call with the throttler's enqueue method
        await this._throttler.enqueue(addItemKey, () =>
          this._api.addItem(
            this._protocol,
            peer,
            collection,
            root,
            location,
            metrics,
            reference
          )
        );
        return;
      } catch (error) {
        // If the request fails, remove the peer from the table and retry
        this._table.remove(peer.id());
        console.warn(
          `Failed to add item via peer ${peer.hash()}. Retrying with a different peer...`
        );

        attempts--;
        if (attempts === 0) {
          // If all attempts fail, throw an error
          throw new Error("Failed to add item after multiple attempts.");
        }
      }
    }
  }

  /**
   * Retrieves a set of items from a collection at a specific location in the network.
   * If the operation fails, it retries with a different peer.
   * Implements caching to store and retrieve sets efficiently.
   * Prevents multiple simultaneous getSet calls with the same collection and location.
   * @param {string} collection - The name of the collection.
   * @param {string} location - The location identifier within the collection.
   * @returns {Promise<any>} - A promise that resolves with the retrieved set of items.
   */
  async getSet(collection, location) {
    let attempts = this._attempts;
    let next = location;

    const cacheKey = `${collection}:${location}`;

    // Check the cache before making a network request
    if (this._cache.has(cacheKey)) {
      // Move the key to the end to mark it as recently used
      const cachedSet = this._cache.get(cacheKey);
      this._cache.delete(cacheKey);
      this._cache.set(cacheKey, cachedSet);
      return cachedSet;
    }

    // Generate a unique key for getSet based on collection and location
    const getSetKey = `getSet:${collection}:${location}`;

    // Use the throttler's enqueue method with the unique key
    return this._throttler.enqueue(getSetKey, async () => {
      await this.whenReady();

      while (true) {
        const id = transform(collection, next);

        // Find the nearest peer to the id
        let peer = this._table.nearest(id);

        if (!peer) {
          await this.discoverPeers();
          peer = this._table.nearest(id);
        }

        if (!peer) {
          throw new Error("Failed to find peers with bootstrap hosts.");
        }

        try {
          // Wrap the getSet API call with the throttler's enqueue method
          const response = await this._api.getSet(
            this._protocol,
            peer,
            collection,
            location
          );

          if (
            response.contact instanceof Peer &&
            response.contact.hash() !== peer.hash()
          ) {
            this._table.insert(response.contact.id(), response.contact);
            if (response.set === null) continue;
          }

          if (response.set !== null) {
            // Before adding to cache, check if cache is at capacity
            if (this._cache.size >= this._cacheSize) {
              // Remove the least recently used (first inserted) item
              const firstKey = this._cache.keys().next().value;
              this._cache.delete(firstKey);
            }
            // Add the new set to the cache and mark it as recently used
            this._cache.set(cacheKey, response.set);
            return response.set;
          }

          if (next === ROOT) {
            return [];
          }
          next = parent(next);
        } catch (error) {
          // If the request fails, remove the peer from the table and retry
          this._table.remove(peer.id());
          console.warn(
            `Failed to get set via peer ${peer.hash()}. Retrying with a different peer...`
          );

          attempts--;
          if (attempts === 0) {
            // If all attempts fail, throw an error
            throw new Error("Failed to retrieve set after multiple attempts.");
          }
        }
      }
    });
  }

  /**
   * LRU bump for an existing cache entry; undefined if absent.
   * @param {string} cacheKey
   * @returns {any[] | undefined}
   */
  _touchCacheEntry(cacheKey) {
    if (!this._cache.has(cacheKey)) {
      return undefined;
    }
    const cached = this._cache.get(cacheKey);
    this._cache.delete(cacheKey);
    this._cache.set(cacheKey, cached);
    return cached;
  }

  /**
   * @param {string} cacheKey
   * @param {any[]} bucket
   */
  _putCacheChildren(cacheKey, bucket) {
    if (this._cache.size >= this._cacheSize) {
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
    }
    this._cache.set(cacheKey, bucket);
  }

  /**
   * Single `/sets` HTTP round-trip for one chunk of parent locations (after cache filtering).
   * @param {string} collection
   * @param {string[]} locations
   */
  async _fetchSetsChunk(collection, locations) {
    const stillMissing = [];
    for (let i = 0; i < locations.length; i++) {
      const loc = locations[i];
      const ck = `${collection}:${loc}`;
      if (!this._cache.has(ck)) {
        stillMissing.push(loc);
      }
    }
    if (stillMissing.length === 0) {
      return;
    }

    let attempts = this._attempts;

    while (true) {
      await this.whenReady();

      const id = this._routingKey;

      let peer = this._table.nearest(id);

      if (!peer) {
        await this.discoverPeers();
        peer = this._table.nearest(id);
      }

      if (!peer) {
        throw new Error("Failed to find peers with bootstrap hosts.");
      }

      try {
        const { elements } = await this._api.getSets(
          this._protocol,
          peer,
          collection,
          stillMissing,
          { deep: true }
        );

        const byParent = distributeElementsByParent(stillMissing, elements);

        for (let i = 0; i < stillMissing.length; i++) {
          const loc = stillMissing[i];
          const bucket = byParent.get(loc) ?? [];
          this._putCacheChildren(`${collection}:${loc}`, bucket);
        }

        return;
      } catch (error) {
        this._table.remove(peer.id());
        console.warn(
          `Failed to get sets via peer ${peer.hash()}. Retrying with a different peer...`
        );

        attempts--;
        if (attempts === 0) {
          throw new Error("Failed to retrieve sets after multiple attempts.");
        }
      }
    }
  }

  /**
   * @param {string} collection
   * @param {{ partialPrefix: Map<string, any[]>, uniqInput: string[] }} waiter
   */
  _finalizeSetsWaiter(collection, waiter) {
    const out = new Map(waiter.partialPrefix);
    const uniqInput = waiter.uniqInput;
    for (let i = 0; i < uniqInput.length; i++) {
      const loc = uniqInput[i];
      if (!loc || loc === ROOT) {
        out.set(loc, []);
        continue;
      }
      if (!out.has(loc)) {
        const ck = `${collection}:${loc}`;
        const cached = this._touchCacheEntry(ck);
        out.set(loc, Array.isArray(cached) ? cached : []);
      }
    }
    return out;
  }

  /**
   * Batch retrieval via GET `/sets` (binary). Populates the same LRU cache as {@link getSet}
   * per parent location. Concurrent callers for the same collection are merged into shared
   * HTTP batches (see SetsCoalescePool). Returns a map parent hash → children.
   *
   * @param {string} collection
   * @param {string[]} locations
   * @returns {Promise<Map<string, import("../entities/item.js").Item[] | import("../entities/set.js").Set[]>>}
   */
  async getSets(collection, locations) {
    if (!Array.isArray(locations) || locations.length === 0) {
      return new Map();
    }

    const uniqInput = [...new Set(locations.map((s) => String(s)))];
    /** @type {Map<string, any[]>} */
    const result = new Map();

    const missingForFetch = [];

    for (let i = 0; i < uniqInput.length; i++) {
      const loc = uniqInput[i];
      if (!loc || loc === ROOT) {
        result.set(loc, []);
        continue;
      }
      const cacheKey = `${collection}:${loc}`;
      if (this._cache.has(cacheKey)) {
        const cached = this._touchCacheEntry(cacheKey);
        result.set(loc, Array.isArray(cached) ? cached : []);
      } else {
        missingForFetch.push(loc);
      }
    }

    if (missingForFetch.length === 0) {
      return result;
    }

    return this._setsPool.submit(collection, result, uniqInput, missingForFetch);
  }
}

export { Network };
