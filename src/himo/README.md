# Aggregate WebGPU heatmap (vendored)

Canonical Aggregate visualization for the dashboard, vendored from
[himo.place](https://github.com/soupape34/himo.place) `@dev` (hooks +
`AverageGridLayerWebGPU` + grid worker + polygon WASM + worker SDK).

Import via Vite alias `@himo/*` → this directory.

Nearby Data mode still uses the package `js-indexus-sdk` (`file:../sdk-js`).
The copy under `js-indexus-sdk/` here is only for the Aggregate worker.
