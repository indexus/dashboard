# Indexus dashboard

Vite + React ops console with map data access. Bound to **127.0.0.1**.

- **Ops:** monitoring (`:19000`) + issuer scale/snapshots (`:22000`)
- **Data:** MapLibre + `js-indexus-sdk` over mesh P2P hosts from `/api/mesh`

Expects a local mesh from `core/scripts/local/mesh_up.sh`, or set `BOOT_IP` / `ISSUER_URL` for AWS.

## Run

```bash
cd dashboard
pnpm install

# Dev: API (:3847) + Vite (:5173) — default local bootstrap
BOOT_IP=127.0.0.1 pnpm dev
# → http://127.0.0.1:5173/

# Or Run and Debug → "Dashboard" (indexus/.vscode/launch.json)

# Production (build then serve UI from :3847)
pnpm build && BOOT_IP=127.0.0.1 pnpm start
```

## Load datasets

```bash
# World population density sample
pnpm load-density:sample

# DVF purchases (CSV dir via DVF_DATA_DIR, default portfolio/himo loaders)
pnpm load-dvf:sample
# Full year (XOR-route to discovered peers):
node scripts/load_dvf.js --year 2020 --ports 21000 --route xor
```

## Env

| Variable | Default | Notes |
|----------|---------|--------|
| `BOOT_IP` | probe `127.0.0.1` | Bootstrap node IP |
| `ISSUER_URL` | `http://{BOOT_IP}:22000` | Issuer |
| `MON_PORT` | `19000` | Monitoring |
| `P2P_PORT` | `21000` | Peer port for sdk |
| `PORT` | `3847` | Dash API / static |
| `INDEXUS_CORE_ROOT` | `../core` | Local spawn metadata + `terminate.sh` |
| `DVF_DATA_DIR` | portfolio himo output | DVF CSV directory |
| `DENSITY_CSV` | `data/world_density_100k.csv` | Density points |

## Notes

- Force kill (`POST /api/terminate`) runs `core/scripts/local/terminate.sh` and clears sticky `local-N` certs.
- Collection presets: `FrGeoBenchAws00001`, himo `DENjYsMTAyLDE2ME`, DVF purchases `DvFMV2020idx0001`.
