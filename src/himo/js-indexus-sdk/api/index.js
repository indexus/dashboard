import { API as BaseAPI } from "../model/index.js";

import { pingPeer } from "./pingPeer.js";
import { getNeighbors } from "./getNeighbors.js";
import { addItem } from "./addItem.js";
import { getSets } from "./getSets.js";

/**
 * Represents the API for interacting with peers to add items and retrieve sets.
 */
class API extends BaseAPI {
  constructor() {
    super();
  }
}

API.prototype.pingPeer = pingPeer;
API.prototype.getNeighbors = getNeighbors;
API.prototype.addItem = addItem;
API.prototype.getSets = getSets;

export { API };
