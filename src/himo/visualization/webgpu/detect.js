// WebGPU capability detection.
//
// detectWebGPU() is idempotent and cached. Returns:
//   { supported: true,  device, adapter, features, reason: null }
//   { supported: false, device: null, adapter: null, features: null, reason: <string> }

let cached = null;
let inflight = null;

export async function detectWebGPU() {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    if (typeof navigator === "undefined" || !("gpu" in navigator)) {
      cached = {
        supported: false,
        device: null,
        adapter: null,
        reason: "no-navigator-gpu",
      };
      return cached;
    }

    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        cached = {
          supported: false,
          device: null,
          adapter: null,
          reason: "no-adapter",
        };
        return cached;
      }

      // Opt into 32-bit float blending if the adapter supports it. This is
      // what allows the heatmap accumulation target to be rgba32float instead
      // of rgba16float, matching the WebGL pipeline's FLOAT accumulation FBO.
      // Without this feature, half-float blending loses mantissa bits and can
      // overflow to Inf in dense areas (every pixel snaps to the last color
      // bucket).
      const wantedOptional = ["float32-blendable"];
      const requiredFeatures = wantedOptional.filter((f) =>
        adapter.features.has(f)
      );

      const device = await adapter.requestDevice({ requiredFeatures });
      device.lost.then((info) => {
        console.warn("[WebGPU] device lost:", info?.reason || info);
        cached = null;
      });

      const features = {
        float32Blendable: device.features.has("float32-blendable"),
      };

      cached = {
        supported: true,
        device,
        adapter,
        features,
        reason: null,
      };
      return cached;
    } catch (err) {
      cached = {
        supported: false,
        device: null,
        adapter: null,
        features: null,
        reason: err?.message || "init-failed",
      };
      return cached;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
