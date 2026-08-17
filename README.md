# Mirra

Mirra is a desktop app (Electron) that mirrors and controls an Android device on your computer by streaming the device's H.264 screen over a WebSocket and decoding it with WebCodecs (or MSE). Built on a vendored fork of [scrcpy](https://github.com/Genymobile/scrcpy).

> The active custom work lives in [`mirrordesk/`](mirrordesk/) — an Electron + React app. The rest of the repo is a vendored scrcpy v4.0 tree (C client + Java Android server) that provides the foundation.

## Overview

AndroMirror is a work-in-progress desktop app for Android mirroring that takes a different decoding path than the classic scrcpy (OpenGL/SDL). Instead of rendering the video stream natively in C, an Electron main process bridges an ADB-forwarded TCP socket from the device to a WebSocket server, and the React renderer decodes the raw H.264 Annex-B NAL stream in the browser using the **WebCodecs** API (with a **Media Source Extensions** fallback). Device input (touch / scroll / keys) is sent back through the same WebSocket to the device's `scrcpy` control socket.

The app uses a [ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy)-style **forked server** (`scrcpy-server.jar`) that serves a single raw stream socket on TCP port `8886`, instead of the standard scrcpy server's dual abstract sockets. This is an experimental prototype — the mirroring pipeline is under active debugging (see [Status](#status)).

## Tech Stack

- **scrcpy fork** — [scrcpy v4.0](https://github.com/Genymobile/scrcpy) source tree
  - **C client** (Meson / Ninja build, FFmpeg + SDL2) in [`app/`](app/)
  - **Android server** (Java, Gradle + AGP 9.1, minSdk 21 / targetSdk 36) in [`server/`](server/)
  - **ws-scrcpy forked server** binary (`scrcpy-server.jar`) bundled in [`mirrordesk/resources/scrcpy/`](mirrordesk/resources/scrcpy/)
- **MirrorDesk app** (`mirrordesk/`)
  - TypeScript, **Electron 42**, **React 19**, **Vite 8**
  - **Tailwind CSS** UI, **lucide-react** icons, `clsx`/`tailwind-merge`
  - **`ws`** WebSocket server in the main process, **`electron-store`** for persistence
  - `h264-converter`, `electron-builder` (NSIS Windows installer)
  - Video decoding: **WebCodecs** (`VideoDecoder`) primary, **MSE** (`MediaSource`/`SourceBuffer`) fallback

## Features

From the app code (`mirrordesk/`):

- **Device discovery** over ADB — lists connected devices (USB and Wi-Fi) with model, battery level, connection type, and IP (`main.ts` IPC `adb:devices` / `adb:device-status`)
- **Wi-Fi connection** — connect to an IP:port, auto-discover the device's IP, and enable wireless debugging via `adb tcpip 5555`
- **Real-time mirroring** — WebSocket bridge forwards the raw H.264 stream; decoded via WebCodecs onto a canvas (MSE fallback for browsers/run-times without WebCodecs)
- **Interactive control** — touch / scroll / key input is serialized (`control/ControlMessage.ts`) and forwarded back to the device control socket
- **Streaming settings** — resolution (Original/1440p/1080p/720p/480p), video bitrate, and frame-rate presets
- **Screenshot** — capture, then copy to clipboard or save via a save dialog
- **Keep-awake** toggle (`settings put global stay_on_while_plugged_in`)
- **Auto-reconnect** with bounded retry (up to 5 attempts) when the device socket drops
- **Stream diagnostics panel** — live NAL-unit counts (SPS/PPS/IDR/SEI), decoder state, bytes/sec, WebSocket state, and a downloadable `.h264` stream dump for debugging
- **Dark / light theme**, persisted window size and settings (`electron-store`)
- An **Annex-B NAL stream parser** (`StreamParser.ts`) that splits the byte stream into NAL units by 3/4-byte start codes, used by both players

## Project Structure

```
AndroMirror/
├── mirrordesk/              # ★ The actual app (Electron + React + Vite)
│   ├── src/main/            # Electron main process
│   │   ├── main.ts          # Window, ADB IPC handlers, settings store
│   │   ├── scrcpy-ws.ts     # WebSocket server ↔ ADB-forwarded device bridge
│   │   └── preload.ts       # contextBridge API surface
│   ├── src/renderer/        # React UI (Tailwind)
│   │   ├── components/MirrorView.tsx  # WS client, stream diagnostics UI
│   │   ├── player/          # WebCodecsPlayer, MsePlayer, StreamParser (NAL parser)
│   │   └── control/         # ControlMessage + touch/scroll/key serializers
│   ├── src/shared/types.ts  # Shared TS types (device, settings, control)
│   ├── resources/scrcpy/    # Bundled adb.exe + forked scrcpy-server.jar
│   ├── download.ps1         # Fetches scrcpy win64 tools into resources/
│   └── electron-builder.yml # NSIS packaging config
├── app/                     # Vendored scrcpy C client (Meson build)
├── server/                  # Vendored scrcpy Android server (Gradle build)
├── config/                  # Checkstyle config for the server
├── doc/                     # Upstream scrcpy documentation (build.md, etc.)
├── release/                 # Upstream release/packaging scripts
├── meson.build              # scrcpy client build entry
├── build.gradle             # Root Gradle config (server module)
└── run                      # Helper: ./run BUILDDIR <scrcpy options>
```

## Getting Started

### MirrorDesk (Electron app) — the primary way to run this

Prerequisites: Node.js (with npm). Windows is the target platform (electron-builder NSIS, bundled `adb.exe`).

```bash
cd mirrordesk
npm install

# Fetch scrcpy tools (adb.exe, DLLs) into resources/scrcpy/ if not already present:
powershell -ExecutionPolicy Bypass -File download.ps1
```

Run in development:

```bash
npm run dev
```

This starts the Vite renderer (port 5173) and Electron main process. Plug in an Android device with USB debugging enabled (or connect over Wi-Fi), select it, and click **Start Mirroring**.

Build an installer:

```bash
npm run build          # tsc (main + renderer) → vite build → electron-builder (NSIS)
```

> The app expects `adb.exe` and `scrcpy-server.jar` in `resources/scrcpy/`. The checked-in `scrcpy-server.jar` (114 KB) is the ws-scrcpy fork; `adb.exe` can be refreshed with `download.ps1`.

### Building the vendored scrcpy (optional, from source)

The classic scrcpy client/server build still works as upstream:

```bash
# Client (C):
meson setup build-auto --buildtype=release
ninja -C build-auto
# Run: ./run build-auto -m1024

# Server (Java): produces server/build/outputs/apk/release/server-release-unsigned.apk
./gradlew -p server assembleRelease
```

See [`doc/build.md`](doc/build.md) for full system-specific instructions.

## Usage

1. Launch the app (or run `npm run dev`).
2. With a device selected, click **Start Mirroring**.
3. The toolbar shows battery, connection type (USB/Wi-Fi), and IP.
4. The on-screen diagnostics panel exposes live stream stats and lets you switch between the WebCodecs and MSE players or download a raw `.h264` dump.
5. Use **Screenshot**, **Keep Awake**, and the **Settings** panel (resolution / bitrate / FPS) from the toolbar.

## Status

**Experimental / work-in-progress.** The git history is short (4 commits, all on 2026-05-25) and reads like a debugging session:

- `f00185c` initial import of scrcpy v4.0 + MirrorDesk app ("Fix blank mirroring…")
- `68650c4` "Switch to ws-scrcpy forked server protocol"
- `2adeab7` "Fix blank screen: Annex-B stream parser + decoder config timing"
- `a9ea824` "Fix server path: use scrcpy-server.jar (ws-scrcpy fork)"

Heavy debug instrumentation remains throughout (`console.log` per NAL/frame, hex dumps, downloadable stream dumps, live diagnostics overlays), the app version is `0.0.0`, and the mirroring pipeline was still being stabilized at the last commit. The vendored scrcpy tree is unmodified upstream code; **audio and the other advanced upstream scrcpy features are not wired into MirrorDesk** (video-only streaming, H.264).

## License

Apache License 2.0 — see [LICENSE](LICENSE). scrcpy is Copyright (C) 2018 Genymobile and 2018-2026 Romain Vimont.
