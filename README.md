# soFUSE Tracker

A self-hosted, read-only dashboard for Solid's soFUSE vault on Fuse. Enter a public Fuse wallet address to see liquid shares, tier locks, unlock dates, and verified liquid earnings. No wallet connection or API key is required.

## Run locally

Requires Node.js 22 or newer and outbound HTTPS access to the Fuse RPC and explorer. There are no packages to install.

```sh
node server.mjs
```

Open [the local dashboard](http://127.0.0.1:4173/) and enter a Fuse address. An `address` query parameter opens the dashboard with that wallet selected.

## Self-host

Run the same Node process on your own machine. For internet access, put it behind an HTTPS reverse proxy with per-client request limits and keep the Node process on loopback when the proxy runs on the same host. Serve the app at the root of its own origin. The proxy's access logs may record wallet addresses in lookup URLs.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address. Use `0.0.0.0` for LAN or container access. |
| `PORT` | `4173` | Listen port. |
| `HISTORY_CACHE_FILE` | `.cache/sofuse-history.json` | Cache path relative to the launch directory, or an absolute path. |

## History cache

Verified wallet history is reused for five minutes while the live share balance matches. Later lookups refresh the transfer list and reuse decoded receipts held in memory. If an upstream request fails, the tracker can show the last reconciled activity for up to seven days, labeled with its block number.

The disk cache stores up to 500 history summaries keyed by wallet fingerprints. Keep it outside the public web root and give each running server its own cache file.

## What the numbers mean

- **Total position value** is the value of wallet-held shares plus shares still held in Solid's tier locker. Both use the vault conversion rate at the same Fuse block.
- **Liquid net gain** is liquid position value plus verified withdrawal proceeds minus verified deposits. It includes shares received from the recognized Yield boost distributor. Tier-locked positions are outside this calculation.
- **Unlock dates** come from the tier locker and are displayed in the browser's local time. Matured shares remain in the locked position until they leave the locker.
- **Incomplete history** can occur with ordinary share transfers, unresolved withdrawal requests, or upstream failures. The dashboard shows available position values and leaves net gain blank when it cannot reconcile the inputs.

## Checks

Run `npm run check` for JavaScript syntax checks and `node --test` for regression tests. Tests use local fixtures.
