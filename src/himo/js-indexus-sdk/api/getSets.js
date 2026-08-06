import axios from "axios";

import { getHostFromIP } from "../utilities/network.js";
import {
  decodeSetsBinary,
  binaryBlocksToElements,
  SETS_BINARY_PROPERTY_COUNT,
} from "./decodeSetsBinary.js";
import { authHeaders } from "./authHeaders.js";

/**
 * Batch fetch equivalent to multiple `/set` calls via GET `/sets` (binary octet-stream).
 * No JSON contact envelope — routing stays with the caller-chosen peer (same as Node fan-out).
 *
 * @param {string} protocol
 * @param {import("../network/peer.js").Peer} peer
 * @param {string} collection
 * @param {string[]} locations
 * @param {{ propertyCount?: number, deep?: boolean }} [options]
 */
export async function getSets(protocol, peer, collection, locations, options = {}) {
  const cleaned = Array.isArray(locations)
    ? locations.map((s) => String(s).trim()).filter(Boolean)
    : [];

  if (cleaned.length === 0) {
    return { elements: [] };
  }

  const deep = options.deep !== false;
  const locationsParam = cleaned.join(",");
  const url = `${protocol}://${getHostFromIP(
    peer.ip()
  )}:${peer.port()}/sets?collection=${encodeURIComponent(
    collection
  )}&location=${encodeURIComponent(locationsParam)}&deep=${
    deep ? "true" : "false"
  }`;

  const response = await axios.get(url, {
    responseType: "arraybuffer",
    headers: authHeaders(),
  });

  const raw = response.data;
  let u8 = null;
  if (raw instanceof ArrayBuffer) {
    u8 = raw.byteLength ? new Uint8Array(raw) : null;
  } else if (raw instanceof Uint8Array) {
    u8 = raw.byteLength ? raw : null;
  } else if (raw?.buffer instanceof ArrayBuffer) {
    const len = raw.byteLength ?? 0;
    u8 = len ? new Uint8Array(raw.buffer, raw.byteOffset ?? 0, len) : null;
  }

  if (!u8 || u8.byteLength === 0) {
    return { elements: [] };
  }

  const propertyCount =
    Number(options.propertyCount) > 0
      ? Math.floor(Number(options.propertyCount))
      : SETS_BINARY_PROPERTY_COUNT;

  const { blocks } = decodeSetsBinary(u8, { propertyCount });
  const elements = binaryBlocksToElements(collection, blocks);

  return { elements };
}
