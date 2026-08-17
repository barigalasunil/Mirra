# Mirra

> Lightweight screen mirroring for Android & iOS — free, open-source, no bloat.

Mirra is a tiny floating toolbar that lives beside your phone's mirrored screen. One click to screenshot, one click to record, zero clutter.

Built on [scrcpy](https://github.com/Genymobile/scrcpy) (Android) and AirPlay (iOS).

---

## Features

| | Android | iOS |
|---|---|---|
| **Mirror screen** | USB / Wi-Fi | AirPlay (same Wi-Fi) |
| **Screenshot** | Copy or Save | Copy or Save |
| **Screen recording** | MP4, H.264 | Work in progress |
| **Keep screen awake** | Yes | — |
| **Always-on-top toolbar** | Yes | Yes |

---

## Quick start

### Download

Grab `Mirra-portable.exe` from [Releases](../../releases) — no install needed, just run it.

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

## Screenshot

Click the **camera icon** in the toolbar. A popup appears on the mirrored screen:

- **Copy Image** — straight to clipboard, paste anywhere
- **Save As...** — pick a location, saves as PNG

Works for both Android and iOS.

---

## Screen Recording (Android)

1. Click the **record icon**
2. Pick where to save the MP4
3. Record as long as you want — mirroring continues
4. Click **stop** — file saves and folder opens

iOS recording is coming soon.

---

## Settings

Open the **3-dot menu** at the bottom of the toolbar:

- **Connect via Wi-Fi** — go wireless with your Android device
- **Dark / Light Mode** — switch themes
- **Pin to Top** — keep the toolbar above all windows

---

## Requirements

**Windows 10 / 11 (64-bit)**

| | Android | iOS |
|---|---|---|
| Connection | USB cable (or Wi-Fi) | Same Wi-Fi network |
| Phone | Android 5.0+ with USB Debugging | iOS 12+ |
| PC software | Nothing extra — bundled | iTunes or Apple Devices app (for USB drivers) |

---

## Build from source

```bash
git clone https://github.com/barigalasunil/Mirra.git
cd Mirra
npm install
npm run dev
```

Requires Node.js 18+.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).

---

## Credits

Mirra stands on the shoulders of [scrcpy](https://github.com/Genymobile/scrcpy), [UxPlay](https://github.com/FDH2/UxPlay), and the [Electron](https://www.electronjs.org) ecosystem. Thank you to all the maintainers.
