# Aggregate WebGPU heatmap (vendored)

Canonical Aggregate visualization for the dashboard, vendored from
[himo.place](https://github.com/soupape34/himo.place) `@dev` (hooks +
`AverageGridLayerWebGPU` + grid worker + polygon WASM + worker SDK).

Import via Vite alias `@himo/*` → this directory.

Browser Nearby and Aggregate currently use the embedded SDK under
`js-indexus-sdk/`. Node loaders use `js-indexus-sdk` via `file:../sdk-js`;
`sdk-js` is the canonical synchronization target.
