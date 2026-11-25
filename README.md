# soFUSE Tracker

A self-hosted, read-only dashboard for Solid's soFUSE vault on Fuse. Enter a public Fuse wallet address to see liquid shares, tier locks, unlock dates, and verified liquid earnings. No wallet connection or API key is required.

## Before you start

Install Node.js 22 or newer on Windows, macOS, or Linux. Android users can install Node.js through Termux using the steps below. The tracker has no packages to install. [Download Node.js](https://nodejs.org/en/download)

Download the project with **Code → Download ZIP** and extract it, or use an existing Git clone. The project folder contains `server.mjs`. [Tracker repository](https://github.com/SIKKcrypto/soFuse-tracker)

The dashboard runs at [http://127.0.0.1:4173/](http://127.0.0.1:4173/) by default. Enter a public Fuse wallet address and select **Look up**. Keep the launcher or terminal open while using the tracker. Live wallet lookups require internet access.

## Run on a Windows PC

### Express install

Open the project folder and double-click **Start Tracker.bat**. Close the launcher window or press **Ctrl+C** to stop it.

### Manual install

1. In File Explorer, open the folder containing `server.mjs`. Type `powershell` in the address bar and press **Enter**.
2. Check Node.js and start the tracker.

   ```powershell
   node --version
   node server.mjs
   ```

3. Press **Ctrl+C** in PowerShell to stop the tracker.

## Run on macOS or Linux

Open a terminal in the project folder and run:

```sh
node --version
node server.mjs
```

Press **Ctrl+C** to stop the tracker.

## Open it on a phone over Wi-Fi

1. Connect your phone and computer to the same trusted Wi-Fi network. If the tracker is already running, stop it with **Ctrl+C**.
2. Start the tracker from the project folder. On Windows, use PowerShell:

   ```powershell
   $env:HOST = '0.0.0.0'
   node server.mjs
   ```

   On macOS or Linux, use a terminal:

   ```sh
   HOST=0.0.0.0 node server.mjs
   ```

3. Find the computer’s local IPv4 address in its network settings. On Windows, you can also run `ipconfig` in another PowerShell window and read the **IPv4 Address** for the active adapter.
4. Open that address with port `4173` on your phone. For example, if the computer’s address is `192.168.1.42`, visit `http://192.168.1.42:4173/`. Keep the computer awake. If Windows Firewall prompts you, allow access on **Private networks** only.

### Add the tracker to your Android home screen

Open the tracker in Chrome on Android. In the **⋮** menu, look for **Install and create shortcut**, then choose **Install** if available. On a plain HTTP Wi-Fi address, Chrome may offer **Create shortcut**. The home-screen icon opens the dashboard, which relies on the running tracker server. [Chrome's Android install instructions](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid)

## Run entirely on Android

This option runs the same tracker server in Termux on your phone. You can use it without a PC.

1. Install Termux from a source listed in its [official installation guide](https://github.com/termux/termux-app#installation).
2. Download the tracker ZIP from GitHub on your phone. The commands below assume the ZIP is named `soFuse-tracker-main.zip` in Downloads.
3. In Termux, install Node.js and let Termux read the ZIP from Downloads. Allow the Android storage prompt before continuing.

   ```sh
   pkg install nodejs-lts unzip
   termux-setup-storage
   ```

4. Extract the ZIP into your Termux home directory and start the tracker.

   ```sh
   mkdir -p "$HOME/sofuse"
   unzip "$HOME/storage/downloads/soFuse-tracker-main.zip" -d "$HOME/sofuse"
   cd "$HOME/sofuse/soFuse-tracker-main"
   sh start-android.sh
   ```

5. Open [http://127.0.0.1:4173/](http://127.0.0.1:4173/) on that phone. Leave Termux running while you use the tracker. If Android stops it, reopen Termux and run `sh "$HOME/sofuse/soFuse-tracker-main/start-android.sh"` again.

## Configuration

The tracker listens on your device only by default. Enable the Wi-Fi setup above when you want other devices on the network to connect.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address. Use `0.0.0.0` for local-network access on a computer. The Android launcher uses `127.0.0.1`. |
| `PORT` | `4173` | Listen port. |
| `HISTORY_CACHE_FILE` | `.cache/sofuse-history.json` | Cache path relative to the launch directory, or an absolute path. The Android launcher defaults to `$HOME/.cache/sofuse-tracker/sofuse-history.json`. |

## Troubleshooting

- **`node` command missing.** Install Node.js 22 or newer and open a fresh terminal.
- **Windows shows “Unknown Publisher.”** The batch file is unsigned. You can inspect the launcher on GitHub or use the manual startup instructions. [View the batch file](https://github.com/SIKKcrypto/soFuse-tracker/blob/main/Start%20Tracker.bat)
- **`EADDRINUSE`.** Check whether the tracker is already open at the default address. To use port `4174`, set `$env:PORT = '4174'` in PowerShell before starting the tracker, or prefix the command with `PORT=4174` in a POSIX shell. Open `http://127.0.0.1:4174/`.
- **Wallet data temporarily unavailable.** Check the internet connection on the host device and retry later. Public Fuse endpoints can rate-limit individual installations.

## History cache

Verified wallet history is reused for five minutes while the live share balance matches. Later lookups refresh the transfer list and reuse decoded receipts held in memory. If an upstream request fails, the tracker can show the last reconciled activity for up to seven days, labeled with its block number.

Each installation keeps its own disk cache of up to 500 history summaries keyed by wallet fingerprints. Give each running server its own cache file.

## Update your copy

Stop the tracker. For a ZIP download, extract the new version into a separate folder and launch it there. If you want to keep the previous history cache, copy `.cache/sofuse-history.json` into the same location in the new folder if it exists. The Android launcher’s default cache lives outside the project folder.

For a Git clone, run `git pull --ff-only` from the project folder and start the tracker again.

## What the numbers mean

- **Conversion rate history** charts published updates from the soFUSE vault. It shows how much FUSE one soFUSE represented at each update, independently of the wallet selected.
- **Total position value** is the value of wallet-held shares plus shares still held in Solid's tier locker. Both use the vault conversion rate at the same Fuse block.
- **Liquid net gain** is liquid position value plus verified withdrawal proceeds minus verified deposits. It includes shares received from the recognized Yield boost distributor. Tier-locked positions are outside this calculation.
- **Unlock dates** come from the tier locker and are displayed in the browser's local time. Matured shares remain in the locked position until they leave the locker.
- **Incomplete history** can occur with ordinary share transfers, unresolved withdrawal requests, or upstream failures. The dashboard shows available position values and leaves net gain blank when it cannot reconcile the inputs.

## Checks

Run `npm run check` for JavaScript syntax checks and `node --test` for regression tests. Tests use local fixtures.
