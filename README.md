# Deezer Pitch Changer

An unofficial JavaScript plugin that lets you adjust the **speed** and **pitch** of the audio during playback in the **Deezer Desktop app for Windows**.

![Pitch changer panel inside Deezer](screenshot.png)

Three modes:

| Mode | Effect | Engine |
|---|---|---|
| **Speed + pitch** | Like a sped-up / slowed-down vinyl (nightcore, slowed…) | Native `playbackRate`, no pitch correction |
| **Speed** | Faster or slower, same key | Native `playbackRate` + `preservesPitch` (Chromium's time-stretching) |
| **Pitch** | Changes the key, same tempo (−12 to +12 semitones, 432 Hz…) | Pitch-shifting AudioWorklet (phase vocoder) |

## Installation

1. Download **`DeezerPitchChanger.exe`** from the [latest release](https://github.com/valuthringer/deezer-pitch-changer-windows/releases/latest).
2. Double-click it and confirm. If Deezer is open, it offers to close it, then relaunches it once the patch is applied.

> The executable isn't signed: Windows SmartScreen may show "Windows protected your PC". Click **More info** → **Run anyway**.

It installs itself for your Windows account (in `%LOCALAPPDATA%\Programs\deezer-pitch-changer`, no administrator rights needed) and then runs hidden in the background:

- **after a Deezer update** (which removes the patch), it patches Deezer again on its own;
- **when a new version is published** here, it updates itself (checked at logon, then every 6 hours) and applies it the next time Deezer is closed.

In Deezer, a **Pitch** button appears at the bottom right (drag it to move it):

- **click** or **Alt+P**: open or close the panel;
- **Alt+Shift+P**: turn the effect on or off;
- **mouse wheel on the slider**: fine adjustment; **double-click**: back to the neutral value;
- **click the value** to type an exact one (`1.024`, `-2.3`, `110 %`, or `3 st` in Speed + pitch mode, up to 3 decimals), then **Enter** to apply or **Esc** to cancel. **↑ / ↓** in the field step the value (**Shift** for fine steps).

Settings are remembered between sessions.

## Uninstall

**Settings** → **Apps** → **Installed apps** → **Deezer Pitch Changer** → **Uninstall** (or run `DeezerPitchChanger.exe` again and choose **U**). The original Deezer is restored.

## Command line

```
DeezerPitchChanger.exe install     [--path <Deezer folder>] [--yes] [--no-launch]
DeezerPitchChanger.exe uninstall   [--path <Deezer folder>] [--yes] [--no-launch]
DeezerPitchChanger.exe status
```

The folder is detected automatically (`%LOCALAPPDATA%\Programs\deezer-desktop` by default). A custom `--path` is remembered for the automatic re-patching.

### From the sources

With [Node.js](https://nodejs.org) 18 or newer, `Install.cmd` / `Uninstall.cmd` (or `node src/cli.js install | uninstall | status`) only patch / restore Deezer, without the background updates: run `Install.cmd` again after each Deezer update.

## How it works

The Deezer app is an Electron shell that displays the `deezer.com` web player.

- **`src/patcher.js`** appends a block to `build/preload.js` inside `resources/app.asar`. It is the only file modified, and a backup `app.asar.pitch-changer-backup` is created.
- **`src/asar.js`** rewrites the archive, replacing only that file. Every other file keeps its bytes and offsets.
- **The block added to the preload** runs **`src/inject/pitch-changer.js`** in the page through `webFrame.executeJavaScript`. That script:
  - finds the player's `<audio>` element;
  - sets `playbackRate` and `preservesPitch`;
  - in Pitch mode, routes the audio through **`src/inject/pitch-worklet.js`**;
  - renders the panel (inside a Shadow DOM, so Deezer's styles are untouched).
- **`src/app.js`** is the entry point of the executable, a [Node.js single executable application](https://nodejs.org/api/single-executable-applications.html) built by **`scripts/build.js`** (no runtime dependencies). **`src/setup.js`** installs it: a copy marked as a GUI app (so no console window) starts at logon from the `HKCU\…\Run` key, and an entry is added to Windows' installed apps.
- **`src/background.js`** is that hidden copy. It watches `app.asar`: once a Deezer update has replaced it, it patches it again when Deezer is closed, or restarts Deezer patched if its updater has just relaunched it. **`src/updater.js`** fetches newer builds from the GitHub releases (checked against their size and SHA-256).
- **`.github/workflows/release.yml`** builds the executable and publishes a release (`build-<n>`) on every push to `main`, keeping the last 5.
- **The pitch shifter** is a phase vocoder with phase locking around spectral peaks (Laroche & Dolson). Both channels share the same phase rotation, which preserves the stereo image. Latency: about 85 ms. CPU: about 3% of one core.

## Limitations

- **Pitch** mode has the typical quality of a phase vocoder: very good for small shifts (±3 semitones), more "metallic" beyond that, with slightly softened drum attacks.
- If Deezer changes the structure of its app, the patch may need to be updated.
- The executable embeds the Node.js runtime, hence its size (about 80 MB, downloaded again for each update).

## Development

```
npm install                    # build tools only (postject, rcedit)
npm test                       # pitch shifter, asar patch and bundling tests
npm run build                  # dist\DeezerPitchChanger.exe (Node.js 22 on Windows)
set DZ_DEVTOOLS=yes && "%LOCALAPPDATA%\Programs\deezer-desktop\Deezer.exe"   # Deezer with DevTools
```

The background process logs to `%LOCALAPPDATA%\Programs\deezer-pitch-changer\log.txt`.

In the DevTools console, `window.__deezerPitchChanger` exposes the current state (settings, tracked audio elements, engine).

## Disclaimer

This is an independent, community-made project and is not affiliated with, endorsed by, or sponsored by Deezer.

This project does not redistribute the Deezer application or its proprietary source code. It only modifies the copy already installed on the user's computer. Users must obtain Deezer through its official channels.

Modifying the Deezer client is not covered by Deezer's terms of use. This project is intended for personal use and is provided as is, without warranty: use it at your own risk.

Deezer is a trademark of its respective owner.
