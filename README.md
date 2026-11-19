# soFUSE Tracker

A read-only dashboard for Solid's soFUSE vault on Fuse. Look up liquid and locked positions, yield boosts, net gain, and unlock dates by wallet address.

## Run locally

Requires Node.js 22 or newer and network access to the public Fuse RPC and Blockscout endpoints. There are no dependencies or API keys.

```sh
node server.mjs
```

Open http://127.0.0.1:4173 and enter a Fuse address. The address can also be supplied as an `address` query parameter. Set `PORT` to change the local port.

Run `npm run check` to check the JavaScript syntax.

## Self-host

Run the same Node process on your own machine. It listens on loopback by default. For LAN access, set `HOST=0.0.0.0`. For public access, keep it behind a reverse proxy with HTTPS and per-client request limits. The app uses public Fuse endpoints and does not require a paid service.

## History cache

Verified wallet history is reused for five minutes as long as the live share balance still matches. Later lookups refresh the transfer list and reuse decoded receipts held in memory. Wallet history is saved to `.cache/sofuse-history.json` for restart recovery. Set `HISTORY_CACHE_FILE` to place the cache on a persistent volume. The cache holds up to 500 wallet lookups. If an upstream request fails, the tracker can show the last reconciled activity for up to seven days, labeled with its block number. Keep this file outside the public web root.

## Accounting

- Position value is the on-chain share balance times the accountant's conversion rate at the same block.
- Solid tier locks are read from the tier locker at that same block. The dashboard shows shares still held by the locker, their FUSE equivalent, and each unlock date. Liquid position value and net gain cover wallet-held shares and liquid cash flows.
- Deposits use decoded vault entry events. Withdrawals require matching queue requests and settlements.
- Transfers from the observed Yield boost distributor count as boosts. Other share transfers may lack an acquisition value or disposal proceeds.
- Net gain is position value plus settled withdrawals minus deposits. It includes boosts and is withheld when share movements are unclassified, settlement is unverified, or history cannot be reconciled.

The app uses public chain reads and requires no wallet connection.
