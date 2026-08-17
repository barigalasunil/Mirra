<div align="center">

# Mirra

**Lightweight screen mirroring for Android & iOS — free, open-source, no bloat.**

A tiny floating toolbar that lives beside your phone's mirrored screen.
One click to screenshot, one click to record, zero clutter.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/barigalasunil/Mirra)](https://github.com/barigalasunil/Mirra/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-lightgrey)]()

</div>

---

## Features

- **Screen mirroring** — Android (USB / Wi-Fi) and iOS (AirPlay)
- **Screenshot** — capture, copy to clipboard, or save as PNG
- **Screen recording** — save as MP4, H.264
- **Keep screen awake** — prevent your Android device from sleeping
- **Always-on-top toolbar** — stays above all windows
- **Dark / Light mode** — toggle from the menu
- **Wi-Fi connect** — go wireless with your Android device
- **Device info** — battery level, connection type, IP address at a glance
- **Pin to top** — lock the toolbar above other windows

---

## Platform Matrix

| Feature | Android | iOS |
|---|---|---|
| Screen mirroring | USB / Wi-Fi | AirPlay (same Wi-Fi) |
| Screenshot | Copy or Save | Copy or Save |
| Screen recording | MP4, H.264 | MP4, H.264 |
| Keep screen awake | Yes | -- |
| Always-on-top toolbar | Yes | Yes |
| Device detection | Auto (USB / Wi-Fi) | Auto (USB / AirPlay) |
| Touch / keyboard input | Yes | -- |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Mirra Toolbar (Electron + React + Tailwind CSS)    │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │  Device List │  │ Screenshot   │  │ Recording │  │
│  │  (ADB / PM3) │  │ (PNG popup)  │  │ (MP4)     │  │
│  └──────┬──────┘  └──────┬───────┘  └─────┬─────┘  │
│         │                │                 │         │
│  ┌──────┴────────────────┴─────────────────┴──────┐  │
│  │           Electron Main Process                │  │
│  │  ┌──────────┐  ┌───────────┐  ┌─────────────┐  │  │
│  │  │ scrcpy   │  │ UxPlay /  │  │ pymobile-   │  │  │
│  │  │ (mirror) │  │ GStreamer  │  │ device3     │  │  │
│  │  └──────────┘  └───────────┘  └─────────────┘  │  │
│  └────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

**How it works:**

- **Android** — Mirra launches [scrcpy](https://github.com/Genymobile/scrcpy) which mirrors your screen over USB (or Wi-Fi via ADB). Touch, keyboard, and scroll events are sent back to the device.
- **iOS** — Mirra launches [UxPlay](https://github.com/FDH2/UxPlay) which receives AirPlay streams over Wi-Fi. Your iPhone appears in the Screen Mirroring list as "Mirra".
- **Screenshots** — Android uses `adb screencap`, iOS uses `pymobiledevice3`. A popup appears centered over the mirror window with Copy/Save options.
- **Recording** — Android recording uses scrcpy's `--record` flag. iOS recording uses UxPlay's built-in `-mp4` stream recorder. Both produce MP4 files.
- **Window management** — Win32 APIs (`FindWindowW`, `SetWindowPos`, `EnumWindows`) track and control mirror window positioning, Z-order, and graceful shutdown.

---

## Requirements

**Windows 10 / 11 (64-bit)**

| | Android | iOS |
|---|---|---|
| Connection | USB cable (or Wi-Fi) | Same Wi-Fi network |
| Phone | Android 5.0+ with USB Debugging | iOS 12+ |
| PC software | Nothing extra — bundled | iTunes or [Apple Devices](https://apps.microsoft.com/store/detail/apple-devices/9NP83LWLPZ9K) app (for USB drivers) |

---

## Installation

### Download (Recommended)

Grab `Mirra-portable.exe` from [Releases](https://github.com/barigalasunil/Mirra/releases) — no install needed, just run it.

Or download the NSIS installer for a traditional install with Start Menu shortcuts.

---

## Build from Source

**Prerequisites:** Node.js 18+, npm

```bash
# Clone the repo
git clone https://github.com/barigalasunil/Mirra.git
cd Mirra/mirrordesk

# Install dependencies
npm install

# Start development mode
npm run dev
```

### Build commands

| Command | Description |
|---|---|
| `npm run dev` | Start dev mode (Vite + TypeScript watcher + Electron) |
| `npm run build` | Build everything (TypeScript + Vite + electron-builder) |
| `npm run build:main` | Build only the main process (TypeScript) |
| `npm run build:renderer` | Build only the renderer (TypeScript + Vite) |

### Build output

The packaged app is output to `mirrordesk/release/`:
- `Mirra-Setup-0.1.0.exe` — NSIS installer
- `Mirra-portable-0.1.0.exe` — Portable (no install required)

---

## Quick Start

### Android

1. Enable **USB Debugging** on your phone (Settings > Developer Options)
2. Plug in via USB, tap "Allow" on the prompt
3. Mirra detects your device automatically — click **Start Mirroring**

> Don't see Developer Options? Go to Settings > About Phone > tap **Build Number** 7 times.

### iOS

1. Connect your iPhone and PC to the **same Wi-Fi network**
2. Click **Start iOS Mirror** in Mirra
3. On iPhone: **Control Center > Screen Mirroring > Mirra**

> If "Mirra" doesn't appear, allow it through Windows Firewall when prompted.

---

## Usage

### Mirror Controls

| Action | How |
|---|---|
| Start mirroring | Click the **Play** button |
| Stop mirroring | Click the **Stop** button |
| Screenshot | Click the **Camera** icon |
| Start recording | Click the **Record** icon while mirroring |
| Stop recording | Click the **Record** icon again |
| Keep awake | Click the **Sun** icon (Android only) |
| Pin toolbar | Click the **Pin** icon |
| More options | Click the **3-dot** menu |

### Screenshot

Click the **camera icon** in the toolbar. A popup appears on the mirrored screen:

- **Copy Image** — straight to clipboard, paste anywhere
- **Save As...** — pick a location, saves as PNG

The popup auto-dismisses after 10 seconds. Press **Escape** to close it early.

### Screen Recording (Android)

1. Click the **record icon**
2. Pick where to save the MP4
3. Record as long as you want — mirroring continues
4. Click **stop** — file saves and folder opens

### Screen Recording (iOS)

1. Start iOS mirroring first
2. Click the **record icon**
3. Recording begins — UxPlay restarts with the `-mp4` flag
4. Click **stop** — save dialog appears, file saves as MP4

### Wi-Fi Connection (Android)

Open the **3-dot menu** > **Connect via Wi-Fi**:

- Enter your device's IP:port (e.g. `192.168.1.5:5555`)
- Or click **Auto discover device IP** to detect it automatically
- Or click **Enable Wireless Debugging** to run `adb tcpip 5555` on the device

---

## Configuration

Settings are persisted via `electron-store` and survive restarts:

| Setting | Location | Description |
|---|---|---|
| Theme | 3-dot menu | Dark / Light mode |
| Always on top | 3-dot menu | Pin toolbar above all windows |
| Window position | Automatic | Saved and restored on launch |
| Video settings | Hardcoded | 1080p max, 8 Mbps, 60 fps, OpenGL renderer |

---

## Project Structure

```
Mirra/
├── .github/
│   ├── workflows/
│   │   ├── build.yml              # CI: build on tag push
│   │   └── release.yml            # Full scrcpy release workflow
│   ├── FUNDING.yml
│   └── ISSUE_TEMPLATE/
├── mirrordesk/                    # Electron app root
│   ├── src/
│   │   ├── main/                  # Electron main process
│   │   │   ├── main.ts            # App entry, IPC handlers, process management
│   │   │   ├── preload.ts         # Context bridge (60+ API methods)
│   │   │   ├── scrcpyWindow.ts    # Win32 API: mirror window tracking, Z-order
│   │   │   └── ios-utils.ts       # pymobiledevice3 wrapper, iOS screenshots
│   │   ├── renderer/              # React UI (Vite)
│   │   │   ├── App.tsx            # Toolbar, modals, toasts, screenshot popup
│   │   │   ├── components/
│   │   │   │   ├── MirrorView.tsx  # Video player, WebSocket, touch input
│   │   │   │   └── RecordingManager.ts  # MP4 muxing (mp4-muxer)
│   │   │   ├── player/            # Video decoding
│   │   │   │   ├── BasePlayer.ts
│   │   │   │   ├── BaseCanvasBasedPlayer.ts
│   │   │   │   ├── WebCodecsPlayer.ts   # WebCodecs API (preferred)
│   │   │   │   ├── MsePlayer.ts         # Media Source Extensions (fallback)
│   │   │   │   ├── StreamParser.ts      # H.264 Annex-B parser
│   │   │   │   ├── VideoSettings.ts
│   │   │   │   ├── ScreenInfo.ts
│   │   │   │   ├── Point.ts / Position.ts / Rect.ts / Size.ts
│   │   │   └── control/           # Input messages
│   │   │       ├── ControlMessage.ts
│   │   │       ├── TouchControlMessage.ts
│   │   │       ├── ScrollControlMessage.ts
│   │   │       ├── KeyCodeControlMessage.ts
│   │   │       └── InteractionHandler.ts
│   │   └── shared/
│   │       └── types.ts           # Shared TypeScript types
│   ├── resources/
│   │   ├── scrcpy/                # Bundled scrcpy binaries (adb, scrcpy, SDL2, FFmpeg)
│   │   └── ios/                   # UxPlay + GStreamer + pymobiledevice3
│   ├── electron-builder.yml       # Build config (NSIS + portable)
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── tsconfig.main.json
├── LICENSE                        # Apache 2.0
├── FAQ.md
└── README.md
```

---

## Development

### Tech stack

- **Electron 42** — Desktop shell
- **React 19** — UI framework
- **Vite 8** — Build tool
- **TypeScript 6** — Type safety
- **Tailwind CSS 3** — Styling
- **koffi** — Win32 API FFI (window management)
- **mp4-muxer** — MP4 recording
- **electron-store** — Persistent settings
- **lucide-react** — Icons

### Key architecture decisions

- **WebCodecs preferred, MSE fallback** — The renderer tries WebCodecs API first for hardware-accelerated H.264 decoding. Falls back to Media Source Extensions if unavailable.
- **Native mirror windows** — scrcpy and UxPlay open their own native windows. Mirra tracks them via Win32 APIs (`FindWindowW`, `GetWindowRect`) for screenshot positioning and Z-order control.
- **IPC via context bridge** — 60+ methods exposed through a context-isolated preload script. No `nodeIntegration` in the renderer.
- **GStreamer sink fallback chain** — iOS mirroring tries `d3d11videosink` -> `glimagesink` -> `autovideosink` automatically on pipeline errors.

### Running in development

```bash
cd mirrordesk
npm run dev
```

This starts:
1. Vite dev server on `localhost:5173`
2. TypeScript compiler in watch mode
3. Electron with `NODE_ENV=development`

---

## Roadmap

- [ ] Linux and macOS support
- [ ] Touch / keyboard input for iOS mirrors
- [ ] Audio mirroring
- [ ] Multi-device mirroring
- [ ] Custom video quality settings UI
- [ ] OTA update mechanism

---

## Limitations

- **Windows only** — Currently built and tested on Windows 10/11 x64
- **iOS mirroring requires Wi-Fi** — AirPlay needs both devices on the same network
- **iOS no touch input** — UxPlay does not support reverse touch/control
- **iOS screenshots need pymobiledevice3** — Requires the bundled binary or manual install
- **iOS drivers** — Windows users need iTunes or the Apple Devices app for USB communication

---

## Troubleshooting

### Android

| Problem | Solution |
|---|---|
| Device not detected | Enable USB Debugging, try a different cable/port |
| "unauthorized" prompt | Tap "Allow" on the phone's USB debugging prompt |
| Multiple devices | Only connect one device at a time, or use `adb connect <ip:port>` |
| Mirror window doesn't appear | Check if another scrcpy instance is running, close it |
| Touch doesn't work | Enable "USB debugging (Security settings)" in Developer Options |

### iOS

| Problem | Solution |
|---|---|
| "Mirra" not in Screen Mirroring list | Allow Mirra through Windows Firewall; ensure same Wi-Fi |
| No iOS devices listed | Install [Apple Devices](https://apps.microsoft.com/store/detail/apple-devices/9NP83LWLPZ9K) from Microsoft Store |
| "Bonjour service" error | Install iTunes or Apple Devices app |
| Mirror window behind toolbar | Mirra auto-raises it; if stuck, stop and restart mirroring |
| Video pipeline failed | Mirra auto-falls back to alternative renderers; restart if all fail |

### General

| Problem | Solution |
|---|---|
| App won't start | Run as administrator; check Windows Defender exclusions |
| Recording won't save | Ensure write permissions to the save location |
| High CPU usage | Reduce video quality in scrcpy settings (bitrate, fps) |

---

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

Please ensure your code follows the existing style and passes `tsc` type checking.

---

## License

This project is licensed under the Apache License 2.0 — see the [LICENSE](LICENSE) file for details.

---

## Acknowledgements

Mirra stands on the shoulders of:

- [scrcpy](https://github.com/Genymobile/scrcpy) — Android screen mirroring (Genymobile)
- [UxPlay](https://github.com/FDH2/UxPlay) — AirPlay mirroring receiver
- [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) — iOS device communication
- [Electron](https://www.electronjs.org) — Desktop app framework
- [Vite](https://vitejs.dev) — Build tool
- [Tailwind CSS](https://tailwindcss.com) — Utility-first CSS

Thank you to all the maintainers and contributors of these projects.
