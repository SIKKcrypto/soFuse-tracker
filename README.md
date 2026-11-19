# soFUSE Tracker

A self-hosted, read-only dashboard for Solid's soFUSE vault on Fuse. Enter a public Fuse wallet address to see liquid shares, tier locks, unlock dates, and verified liquid earnings. No wallet connection or API key is required.

## Run on a Windows PC

Both options require the Windows **LTS** release of Node.js, version 22 or newer. [Download Node.js](https://nodejs.org/en/download)

Get the project from **Code → Download ZIP** and extract it, or use an existing clone. No packages need to be installed. [Tracker repository](https://github.com/SIKKcrypto/soFuse-tracker)

### Express install

1. Open the extracted folder and double-click **Start Tracker.bat**.
2. Leave the launcher window open and visit [http://127.0.0.1:4173/](http://127.0.0.1:4173/). Paste a public Fuse wallet address and select **Look up**. The PC needs internet access to read Fuse data.
3. Close the launcher window or press **Ctrl+C** to stop the tracker.

### Manual install

1. In File Explorer, open the folder containing `server.mjs`. Type `powershell` in the address bar and press **Enter**.
2. Check Node.js and start the tracker.

   ```powershell
   node --version
   node server.mjs
   ```

3. Keep PowerShell open while you use [http://127.0.0.1:4173/](http://127.0.0.1:4173/). Press **Ctrl+C** in PowerShell to stop the tracker.

If Node reports `EADDRINUSE`, the port is already in use. Try the dashboard link first in case the tracker is already running. To start a separate instance, run `$env:PORT = '4174'` before `node server.mjs` and use port `4174` in the browser.

## Open it on a phone over Wi-Fi

1. Connect your phone and PC to the same trusted Wi-Fi network. If the tracker is already running, stop it with **Ctrl+C**.
2. In PowerShell, from the tracker folder, run:

   ```powershell
   $env:HOST = '0.0.0.0'
   node server.mjs
   ```

3. In a second PowerShell window, run `ipconfig` and find the **IPv4 Address** under your active Wi-Fi adapter. For example, if the address is `192.168.1.42`, open `http://192.168.1.42:4173/` in your phone’s browser.
4. If Windows Firewall prompts you, allow access on **Private networks** only. If the phone still can’t reach the dashboard, check that the PC is awake and both devices are on the same network.

### Add the tracker to your Android home screen

Open the tracker in Chrome on Android. In the **⋮** menu, look for **Install and create shortcut**, then choose **Install** if available. On a plain HTTP Wi-Fi address, Chrome may offer **Create shortcut** instead. The PC still serves the dashboard in either case. [Chrome's Android install instructions](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid)

An HTTPS self-hosted address supports the installable web app when Chrome offers it. Live wallet data requires a running tracker server and internet access.

## Run entirely on Android

This option runs the same tracker server in Termux on your phone. You can use it without a PC.

1. Install Termux from a source listed in its [official installation guide](https://github.com/termux/termux-app#installation).
2. Download the tracker ZIP from GitHub on your phone. While the repo is private, sign in to GitHub with an account that can access it. The commands below assume the ZIP is named `soFuse-tracker-main.zip` in Downloads.
3. In Termux, run the following commands. When Android prompts for storage access, allow it so Termux can read the ZIP from Downloads.

   ```sh
   pkg install nodejs-lts unzip
   termux-setup-storage
   mkdir -p "$HOME/sofuse"
   unzip "$HOME/storage/downloads/soFuse-tracker-main.zip" -d "$HOME/sofuse"
   cd "$HOME/sofuse/soFuse-tracker-main"
   sh start-android.sh
   ```

4. On that phone, open [http://127.0.0.1:4173/](http://127.0.0.1:4173/) in Chrome. Use the home-screen steps above if Chrome offers them. The launcher keeps the server on the phone’s loopback address, and the wallet cache stays in Termux’s private storage.
5. Leave Termux running while you use the tracker. If Android stops it, reopen Termux and run `sh "$HOME/sofuse/soFuse-tracker-main/start-android.sh"` again. The home-screen icon opens the dashboard and relies on the Termux server.

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
