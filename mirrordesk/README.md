# Mirra

> **Android & iOS screen mirroring for Windows** — lightweight,
> open-source, and free.

Mirra is a floating toolbar that sits beside your phone's mirrored
screen, giving you one-click screenshot, screen recording, and
device controls — without the bloat of commercial tools like Vysor.

---

## Features

| Feature | Android | iOS |
|---------|---------|-----|
| Screen Mirroring | via scrcpy | via AirPlay (UxPlay) |
| Screenshot | Copy or Save | Copy or Save |
| Screen Recording | MP4 | Coming soon |
| Keep Screen Awake | Yes | — |
| Wi-Fi Connect | Yes | Same network |
| Always-on-top toolbar | Yes | Yes |

---

## Requirements

**Windows 10/11 (64-bit)**

### For Android
- USB cable + USB Debugging enabled on your Android device
- Android 5.0+ (API 21+)

### For iOS
- iPhone and PC on the **same Wi-Fi network**
- iTunes installed (for USB drivers) — get it from Microsoft Store
- iOS 12 or later

---

## Quick Start

### Option A — Portable (no install)
1. Download `Mirra-portable.exe` from [Releases](../../releases)
2. Double-click to run — no installation needed
3. Plug in your Android device via USB

### Option B — Installer
1. Download `Mirra-Setup.exe` from [Releases](../../releases)
2. Run the installer, follow the steps
3. Launch Mirra from the Start Menu or Desktop shortcut

---

## Android Setup

1. On your Android phone, go to **Settings > Developer Options**
2. Enable **USB Debugging**
3. Connect phone to PC via USB cable
4. Tap **"Allow"** on the USB Debugging prompt on your phone
5. Open Mirra — your device will appear automatically
6. Click **Start Mirroring**

> **Don't see Developer Options?**
> Go to Settings > About Phone > tap **Build Number** 7 times.

---

## iOS Setup (AirPlay Mirroring)

iOS mirroring works over Wi-Fi using Apple's AirPlay protocol.
No jailbreak or app install needed.

1. Make sure your iPhone and PC are on the **same Wi-Fi network**
2. Open Mirra and click **Start iOS Mirror**
3. On your iPhone, open **Control Center**
   (swipe down from top-right corner)
4. Tap **Screen Mirroring**
5. Select **"Mirra"** from the list
6. Your iPhone screen will appear in a new window

> **"Mirra" not appearing in the list?**
> - Check both devices are on the same Wi-Fi (not one on 2.4GHz,
>   one on 5GHz if your router isolates them)
> - Allow Mirra through Windows Firewall when prompted
> - Try toggling Wi-Fi off/on on your iPhone

---

## Screenshot

Click the **camera icon** in the toolbar.
A popup will appear on the mirrored screen with two options:
- **Copy Image** — copies to clipboard (paste in any app)
- **Save As...** — opens a save dialog (saves as PNG to your Pictures)

---

## Screen Recording (Android)

1. Click the **record icon** — a save dialog appears first
2. Choose where to save the MP4 file
3. Mirroring continues while recording
4. Click **stop icon** to end — file is saved and folder opens

> Recording saves as MP4 with H.264 video at 8 Mbps quality.

---

## Settings (via menu)

- **Connect via Wi-Fi** — connect Android wirelessly (same network)
- **Light/Dark Mode** — toggle app theme
- **Pin to Top** — keep toolbar above all windows
- **Developer Tools** — opens Chromium DevTools (separate window)

---

## Known Limitations

- **Initial launch takes 3-8 seconds** — Mirra starts a local
  development server on first run. This is a known limitation of
  the current build and will be improved in a future release.
  The app is fully functional once the toolbar icons appear.

- **iOS recording not yet supported** — AirPlay streaming is
  receive-only in UxPlay. Recording will be added in a future version.

- **iOS window size** — The mirrored iOS window opens at a fixed
  390x844 resolution. Resize it manually if needed.

- **scrcpy port warning** — You may see a Windows Firewall popup
  on first launch. Click "Allow" to enable device communication.

---

## Build from Source

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/mirra.git
cd mirra

# Install dependencies
npm run install-app

# Run in development mode (requires Android device connected)
npm run dev

# Build Windows installer + portable exe
npm run build
```

> **Note:** Run all commands from the repo root.
> The Electron app lives in `mirrordesk/` — the root `package.json`
> has convenience scripts that cd into it automatically.

### Prerequisites for building
- Node.js 18+
- npm 9+
- Git

### What gets built
After `npm run build`:
- `mirrordesk/release/Mirra Setup 0.1.0.exe` — NSIS installer
- `mirrordesk/release/Mirra 0.1.0.exe` — Portable executable

---

## Project Structure

```
mirra/
  mirrordesk/          <- Electron app (main project)
    src/
      main/            <- Electron main process
        main.ts            <- App entry, IPC handlers
        ios-utils.ts       <- iOS device detection
        scrcpyWindow.ts    <- Mirror window tracker
      renderer/        <- React UI
        App.tsx            <- Toolbar + all UI
      shared/          <- Shared TypeScript types
    resources/
      scrcpy/          <- Bundled scrcpy 2.4 + adb (Windows)
      ios/             <- UxPlay + pymobiledevice3
    electron-builder.yml
  package.json         <- Root convenience scripts
  README.md
```

---

## License & Credits

Mirra is built on top of these amazing open-source projects:

| Project | License | Used for |
|---------|---------|----------|
| [scrcpy](https://github.com/Genymobile/scrcpy) | Apache 2.0 | Android mirroring |
| [UxPlay](https://github.com/FDH2/UxPlay) | GPL 3.0 | iOS AirPlay receiver |
| [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) | GPL 3.0 | iOS device detection |
| [Electron](https://www.electronjs.org) | MIT | Desktop app framework |
| [React](https://react.dev) | MIT | UI |

---

## Contributing

PRs welcome! Please open an issue first to discuss major changes.
