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

Requirement: [Node.js](https://nodejs.org) 18 or newer. The project has no npm dependencies.

1. Double-click **`Install.cmd`**.
2. If Deezer is open, the program offers to close it, then relaunches it once the patch is applied.

In Deezer, a **Pitch** button appears at the bottom right (drag it to move it):

- **click** or **Alt+P**: open or close the panel;
- **Alt+Shift+P**: turn the effect on or off;
- **mouse wheel on the slider**: fine adjustment; **double-click**: back to the neutral value.

Settings are remembered between sessions.

> **After a Deezer update**, the patch is gone (the update replaces `app.asar`). Just run `Install.cmd` again.

## Uninstall

Double-click **`Uninstall.cmd`**: the original `app.asar` is restored.

## Command line

```
node src/cli.js install     [--path <Deezer folder>] [--yes] [--no-launch]
node src/cli.js uninstall   [--path <Deezer folder>] [--yes] [--no-launch]
node src/cli.js status
```

The folder is detected automatically (`%LOCALAPPDATA%\Programs\deezer-desktop` by default).

## How it works

The Deezer app is an Electron shell that displays the `deezer.com` web player.

- **`src/patcher.js`** appends a block to `build/preload.js` inside `resources/app.asar`. It is the only file modified, and a backup `app.asar.pitch-changer-backup` is created.
- **`src/asar.js`** rewrites the archive, replacing only that file. Every other file keeps its bytes and offsets.
- **The block added to the preload** runs **`src/inject/pitch-changer.js`** in the page through `webFrame.executeJavaScript`. That script:
  - finds the player's `<audio>` element;
  - sets `playbackRate` and `preservesPitch`;
  - in Pitch mode, routes the audio through **`src/inject/pitch-worklet.js`**;
  - renders the panel (inside a Shadow DOM, so Deezer's styles are untouched).
- **The pitch shifter** is a phase vocoder with phase locking around spectral peaks (Laroche & Dolson). Both channels share the same phase rotation, which preserves the stereo image. Latency: about 85 ms. CPU: about 3% of one core.

## Limitations

- **Pitch** mode has the typical quality of a phase vocoder: very good for small shifts (±3 semitones), more "metallic" beyond that, with slightly softened drum attacks.
- If Deezer changes the structure of its app, the patch may need to be updated.

## Development

```
npm test                       # pitch shifter and asar patch tests
set DZ_DEVTOOLS=yes && "%LOCALAPPDATA%\Programs\deezer-desktop\Deezer.exe"   # Deezer with DevTools
```

In the DevTools console, `window.__deezerPitchChanger` exposes the current state (settings, tracked audio elements, engine).

## Disclaimer

This is an independent, community-made project and is not affiliated with, endorsed by, or sponsored by Deezer.

This project does not redistribute the Deezer application or its proprietary source code. It only modifies the copy already installed on the user's computer. Users must obtain Deezer through its official channels.

Modifying the Deezer client is not covered by Deezer's terms of use. This project is intended for personal use and is provided as is, without warranty: use it at your own risk.

Deezer is a trademark of its respective owner.
