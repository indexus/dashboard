/* global GPUBufferUsage */

// GeoJSON → mask buffers. The CPU-side triangulation is identical to the
// WebGL layer's (earcut on Mercator-projected polygons). Splitting it out
// keeps the renderer itself free of map-projection plumbing.

import maplibregl from "maplibre-gl";
import earcut from "earcut";

export function buildMaskGeometry(geojson) {
  const vertices = [];
  const indices = [];
  let globalOffset = 0;

  geojson.features.forEach((feature) => {
    const geometry = feature.geometry;
    if (!geometry) return;

    const processPolygon = (rings) => {
      const flattened = [];
      const holeIndices = [];

      rings.forEach((ring, ringIndex) => {
        if (ring.length < 3) return;

        ring.forEach((coord) => {
          const merc = maplibregl.MercatorCoordinate.fromLngLat({
            lng: coord[0],
            lat: coord[1],
          });
          flattened.push(merc.x, merc.y);
        });

        if (ringIndex !== 0) {
          holeIndices.push(flattened.length / 2 - ring.length);
        }
      });

      const localIndices = earcut(flattened, holeIndices, 2);

      for (let i = 0; i < flattened.length; i++) {
        vertices.push(flattened[i]);
      }
      for (let i = 0; i < localIndices.length; i++) {
        indices.push(localIndices[i] + globalOffset);
      }

      globalOffset += flattened.length / 2;
    };

    if (geometry.type === "Polygon") {
      processPolygon(geometry.coordinates);
    } else if (geometry.type === "MultiPolygon") {
      geometry.coordinates.forEach(processPolygon);
    }
  });

  return { vertices, indices };
}

// Builds + uploads mask vertex/index buffers in one shot. Returns the new
// buffers and the index count, plus a `dispose()` helper. The caller owns
// the lifetime.
export function uploadMaskGeometry(device, geojson) {
  const { vertices, indices } = buildMaskGeometry(geojson);
  if (indices.length === 0) {
    return { vertexBuffer: null, indexBuffer: null, indexCount: 0, dispose() {} };
  }

  const vertexData = new Float32Array(vertices);
  const vertexBuffer = device.createBuffer({
    size: vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, vertexData);

  // WebGPU index buffers must be 4-byte aligned for u16 — pad if necessary.
  const padded = indices.length % 2 === 0 ? indices : indices.concat([0]);
  const indexData = new Uint16Array(padded);
  const indexBuffer = device.createBuffer({
    size: indexData.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, indexData);

  return {
    vertexBuffer,
    indexBuffer,
    indexCount: indices.length,
    dispose() {
      vertexBuffer.destroy();
      indexBuffer.destroy();
    },
  };
}
