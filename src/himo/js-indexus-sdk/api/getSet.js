import axios from "axios";

import { Peer } from "../network/peer.js";
import { getHostFromIP } from "../utilities/network.js";
import { parseSetMap } from "./parseSetMap.js";
import { authHeaders } from "./authHeaders.js";

/**
 * Retrieves a set from a collection at a specified location.
 *
 * @param {string} protocol - Protocol to use to contact the peer http/https.
 * @param {Peer} peer - The peer to contact.
 * @param {string} collection - The ID of the collection.
 * @param {string} location - The location within the collection.
 * @returns {Promise<Object>} - The response from the server, including the set data.
 */
export async function getSet(protocol, peer, collection, location, deep = true) {
  // Construct the GET request URL
  const url = `${protocol}://${getHostFromIP(
    peer.ip()
  )}:${peer.port()}/set?collection=${encodeURIComponent(
    collection
  )}&location=${encodeURIComponent(location)}&deep=${deep ? "true" : "false"}`;

  try {
    // Make the GET request to retrieve the set from the collection
    const response = await axios.get(url, {
      headers: authHeaders(),
    });

    // Parse the JSON response
    const data = response.data;

    // Create a Peer instance from the contact data
    const contactData = data.contact;
    const contactPeer = new Peer(
      contactData.name,
      contactData.ips,
      contactData.port,
      contactData.ip
    );

    // Parse the set data into Element instances
    const elements =
      data.set !== null ? parseSetMap(data.set, collection) : null;

    // Return the structured object
    return {
      contact: contactPeer,
      set: elements,
    };
  } catch (error) {
    // Handle and log errors
    console.error(`Error retrieving set from peer ${peer.hash()}:`, error);
    throw error;
  }
}
