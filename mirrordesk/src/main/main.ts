import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, screen } from 'electron';
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { networkInterfaces } from 'os';
import Store from 'electron-store';
import { listIosDevices, takeIosScreenshot, isPymobiledeviceInstalled } from './ios-utils';
import {
    getMirrorRect,
    refreshMirrorRect,
    setMirrorTopmost,
    restoreMirror,
    closeMirrorGracefully,
    startTracking,
    stopTracking,
    raiseIosMirrorWindow,
    startIosTracking,
    stopIosTracking,
    getIosMirrorRect,
    refreshIosMirrorRect,
    resizeIosMirrorWindow,
} from './scrcpyWindow';
const store: any = new Store();
const isDev = process.env.NODE_ENV === 'development';
let mainWindow: BrowserWindow | null = null;
let scrcpyProcess: ReturnType<typeof spawn> | null = null;
let screenshotPopupWindow: BrowserWindow | null = null;
let pendingScreenshotPath: string | null = null;
let pendingScreenshotBase64: string | null = null;
let recordingFilePath: string | null = null;
let uxplayProcess: ReturnType<typeof spawn> | null = null;
const suppressedProcs = new Set<any>();
let ipcInitialized = false;
let uxplayRaiseTimer: ReturnType<typeof setInterval> | null = null;
let isCapturingScreenshot = false;
let isTogglingRecord = false;

// --- Firewall auto-setup (Windows) ---
const AIRPLAY_RULE_NAME = 'Mirra AirPlay';
const AIRPLAY_PORTS = '7000-7002';
let firewallChecked = false;

function checkFirewallRule(ruleName: string): boolean {
    try {
        const out = execSync(
            `netsh advfirewall firewall show rule name="${ruleName}"`,
            { windowsHide: true, timeout: 5000 }
        ).toString();
        return out.includes(ruleName);
    } catch {
        return false;
    }
}

function addFirewallRuleElevated(ruleName: string, protocol: string, ports: string): boolean {
    const psCmd = `Start-Process -FilePath netsh -ArgumentList 'advfirewall firewall add rule name=\\"${ruleName}\\" dir=in action=allow protocol=${protocol} localport=${ports}' -Verb RunAs -WindowStyle Hidden -Wait`;
    try {
        execSync(psCmd, { windowsHide: true, timeout: 15000 });
        return true;
    } catch {
        return false;
    }
}

function ensureFirewallRulesSync(): { tcpExists: boolean; udpExists: boolean; created: boolean } {
    const tcpExists = checkFirewallRule(`${AIRPLAY_RULE_NAME} TCP`);
    const udpExists = checkFirewallRule(`${AIRPLAY_RULE_NAME} UDP`);

    if (tcpExists && udpExists) {
        console.log('[firewall] AirPlay rules already exist');
        return { tcpExists, udpExists, created: true };
    }

    let created = false;
    if (!tcpExists) {
        const ok = addFirewallRuleElevated(`${AIRPLAY_RULE_NAME} TCP`, 'TCP', AIRPLAY_PORTS);
        console.log('[firewall] TCP rule:', ok ? 'created' : 'failed');
        if (ok) created = true;
    }
    if (!udpExists) {
        const ok = addFirewallRuleElevated(`${AIRPLAY_RULE_NAME} UDP`, 'UDP', AIRPLAY_PORTS);
        console.log('[firewall] UDP rule:', ok ? 'created' : 'failed');
        if (ok) created = true;
    }

    return { tcpExists: tcpExists || created, udpExists: udpExists || created, created };
}

function ensureFirewallRules(): void {
    if (firewallChecked || process.platform !== 'win32') return;
    firewallChecked = true;

    (async () => {
        const result = ensureFirewallRulesSync();
        if (!result.created) {
            mainWindow?.webContents.send('ios:mirror-instruction', {
                msg: 'Windows Firewall blocked AirPlay ports. Please allow Mirra when prompted, or run as Administrator once.'
            });
        }
    })();
}

const ts = () => {
    const d = new Date();
    return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
};

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

const getAdbPath = () => {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'scrcpy', 'adb.exe')
        : path.join(__dirname, '../../resources/scrcpy/adb.exe');
};

const getScrcpyPath = () => {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'scrcpy', 'scrcpy.exe')
        : path.join(__dirname, '../../resources/scrcpy/scrcpy.exe');
};

async function loadWithRetry(win: BrowserWindow, url: string, maxRetries = 15, delayMs = 300) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await win.loadURL(url);
            return;
        } catch (err) {
            console.log(`[main] loadURL attempt ${i + 1} failed, retrying...`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    await win.loadURL(url);
}

async function detectDevPort(): Promise<number> {
    const ports = [5173, 5174, 5175, 5176, 5177];
    const net = await import('net');
    for (const port of ports) {
        try {
            await new Promise<void>((resolve, reject) => {
                const socket = new net.Socket();
                socket.once('connect', () => { socket.destroy(); resolve(); });
                socket.once('error', () => { socket.destroy(); reject(new Error('no')); });
                socket.connect(port, '127.0.0.1');
            });
            console.log('[main] detected Vite dev server on port', port);
            return port;
        } catch { /* port not available, try next */ }
    }
    return 5173;
}

async function createWindow() {
    console.time('[main] window-to-visible');
    mainWindow = new BrowserWindow({
        width: 64,
        height: 500,
        minWidth: 64,
        maxWidth: 64,
        resizable: false,
        autoHideMenuBar: true,
        title: 'Mirra',
        frame: false,
        backgroundColor: store.get('theme', 'dark') === 'light' ? '#f7f7f8' : '#111114',
        show: false,
        roundedCorners: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.setAutoHideMenuBar(true);

    const savedBounds = store.get('windowBounds') as { x: number; y: number; width: number; height: number } | undefined;
    if (savedBounds) {
        mainWindow.setBounds({
            x: savedBounds.x,
            y: savedBounds.y,
            width: 64,
            height: 500,
        });
    }

    const savedAlwaysOnTop = store.get('alwaysOnTop', false) as boolean;
    mainWindow.setAlwaysOnTop(savedAlwaysOnTop);

    mainWindow.on('moved', () => {
        if (mainWindow) {
            const b = mainWindow.getBounds();
            store.set('windowBounds', { x: b.x, y: b.y, width: b.width, height: b.height });
        }
    });

    mainWindow.on('restore', () => restoreMirror());
    mainWindow.on('focus', () => restoreMirror());

    // Show the toolbar shell immediately — never hold the window hostage
    // to page load. Vite dev-server loads can hang 10-70s without erroring;
    // content paints whenever the load resolves (loadWithRetry keeps
    // retrying failures in dev). Packaged builds load from disk in ~200ms.
    mainWindow.show();
    mainWindow.focus();
    console.timeEnd('[main] window-to-visible');
    console.log('[main] window shown (content loads in background)');

    if (isDev) {
        try {
            const port = await detectDevPort();
            await loadWithRetry(mainWindow, `http://localhost:${port}`);
        } catch (err) {
            console.error('[main] load failed:', err);
        }
    } else {
        try {
            await mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
        } catch (err) {
            console.error('[main] load failed:', err);
        }
    }

    // Push the saved theme once the renderer is up (renderer's own
    // initTheme on mount is the primary path; this is a sync safety net).
    setTimeout(() => {
        mainWindow?.webContents.send('theme:changed', store.get('theme', 'dark'));
    }, 500);
}

app.whenReady().then(() => {
    createWindow();
    ensureFirewallRules();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

function clearUxplayRaiseTimer(): void {
    if (uxplayRaiseTimer) {
        clearInterval(uxplayRaiseTimer);
        uxplayRaiseTimer = null;
    }
}

app.on('before-quit', () => {
    clearUxplayRaiseTimer();
    stopIosTracking();
    if (scrcpyProcess) {
        scrcpyProcess.kill();
        scrcpyProcess = null;
    }
    if (uxplayProcess) {
        uxplayProcess.kill();
        uxplayProcess = null;
    }
});

function runAdbCommand(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const adbPath = getAdbPath();
        const proc = spawn(adbPath, args);
        let out = '';
        let err = '';
        proc.stdout.on('data', (d) => out += d.toString());
        proc.stderr.on('data', (d) => err += d.toString());
        proc.on('close', (code) => {
            if (code === 0) resolve(out);
            else reject(err || out);
        });
    });
}

// IPC Handlers
if (!ipcInitialized) {
ipcMain.handle('adb:devices', async () => {
    try {
        const out = await runAdbCommand(['devices', '-l']);
        const lines = out.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('List of'));
        return lines.map(line => {
            const [id] = line.split(/\s+/);
            const isWifi = id.includes(':');
            const modelMatch = line.match(/model:(\S+)/);
            return {
                id,
                isWifi,
                model: modelMatch ? modelMatch[1] : 'Unknown'
            };
        }).filter(d => d.id !== 'offline');
    } catch (e) {
        console.error(e);
        return [];
    }
});

ipcMain.handle('adb:device-status', async (_, deviceId: string) => {
    try {
        const batteryOut = await runAdbCommand(['-s', deviceId, 'shell', 'dumpsys', 'battery']);
        const batteryLevelMatch = batteryOut.match(/level:\s+(\d+)/);
        const batteryLevel = batteryLevelMatch ? parseInt(batteryLevelMatch[1], 10) : 100;

        const modelOut = await runAdbCommand(['-s', deviceId, 'shell', 'getprop', 'ro.product.model']);
        const ipOut = await runAdbCommand(['-s', deviceId, 'shell', 'getprop', 'dhcp.wlan0.ipaddress']).catch(() => '');
        const ip = ipOut.trim() || await runAdbCommand(['-s', deviceId, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0']).then((data) => {
            const match = data.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
            return match ? match[1] : '';
        }).catch(() => '');
        
        return {
            battery: batteryLevel,
            model: modelOut.trim(),
            isWifi: deviceId.includes(':'),
            ip: ip || undefined
        };
    } catch (e) {
        return null;
    }
});

ipcMain.handle('adb:enable-wifi', async (_, deviceId: string) => {
    try {
        const result = await runAdbCommand(['-s', deviceId, 'tcpip', '5555']);
        return { success: result.includes('restarting in TCP mode') || result.includes('restarting in tcp mode'), message: result };
    } catch (e: any) {
        return { success: false, message: e.toString() };
    }
});

ipcMain.handle('adb:discover-ip', async (_, deviceId: string) => {
    try {
        const ipOut = await runAdbCommand(['-s', deviceId, 'shell', 'getprop', 'dhcp.wlan0.ipaddress']).catch(() => '');
        if (ipOut.trim()) {
            return { success: true, ip: ipOut.trim() };
        }
        const fallback = await runAdbCommand(['-s', deviceId, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0']);
        const match = fallback.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
        return { success: Boolean(match), ip: match?.[1] || '' };
    } catch (e: any) {
        return { success: false, ip: '', message: e.toString() };
    }
});

ipcMain.handle('adb:connect-wifi', async (_, ipPort: string) => {
    try {
        const result = await runAdbCommand(['connect', ipPort]);
        return { success: result.includes('connected'), message: result };
    } catch (e: any) {
        return { success: false, message: e.toString() };
    }
});

ipcMain.handle('adb:keep-awake', async (_, deviceId: string, state: boolean) => {
    const val = state ? '3' : '0';
    try {
        await runAdbCommand(['-s', deviceId, 'shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', val]);
        return true;
    } catch {
        return false;
    }
});

// Open the screenshot preview popup (Copy / Save As buttons) over the mirror
// window. Shared by the Android (scrcpy) and iOS (pymobiledevice3) paths.
function showScreenshotPopup(base64Image: string, tempPath: string): void {
    // Close any existing popup first so rapid captures never stack up
    // overlapping windows with the older one stuck underneath.
    if (screenshotPopupWindow && !screenshotPopupWindow.isDestroyed()) {
        screenshotPopupWindow.close();
        screenshotPopupWindow = null;
    }

    pendingScreenshotPath = tempPath;
    pendingScreenshotBase64 = base64Image;

    const t0 = Date.now();
    const popupW = 280;
    const popupH = 200;
    let popupX = 0;
    let popupY = 0;
    // Try Android mirror rect first, then iOS mirror rect
    refreshMirrorRect();
    let rect = getMirrorRect();
    if (!rect) {
        refreshIosMirrorRect();
        rect = getIosMirrorRect();
    }
    console.log('[screenshot] mirror rect:', JSON.stringify(rect));
    if (rect) {
        // GetWindowRect returns physical pixels; BrowserWindow x/y use DIPs.
        // Convert before computing so the popup truly centers on the mirror.
        const lt = screen.screenToDipPoint({ x: rect.left, y: rect.top });
        const rb = screen.screenToDipPoint({ x: rect.right, y: rect.bottom });
        popupX = Math.round(lt.x + (rb.x - lt.x - popupW) / 2);
        popupY = Math.round(lt.y + (rb.y - lt.y - popupH) / 2);
        const display = screen.getDisplayMatching({
            x: lt.x, y: lt.y,
            width: rb.x - lt.x, height: rb.y - lt.y
        });
        const wa = display.workArea;
        popupX = Math.max(wa.x, Math.min(popupX, wa.x + wa.width - popupW));
        popupY = Math.max(wa.y, Math.min(popupY, wa.y + wa.height - popupH));
        console.log('[screenshot] popup centered over mirror window at (dip)', popupX, popupY);
    } else if (mainWindow) {
        const tb = mainWindow.getBounds();
        popupX = tb.x + tb.width + 8 + 20;
        popupY = tb.y + 100;
        console.log('[screenshot] mirror rect unavailable, using toolbar fallback');
    }

    if (!mainWindow) return;

    screenshotPopupWindow = new BrowserWindow({
        width: popupW,
        height: popupH,
        x: popupX,
        y: popupY,
        frame: false,
        transparent: true,
        type: 'toolbar',
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        show: false,
        focusable: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    // Load the popup from the built bundle, NOT the Vite dev server —
    // Vite page loads can hang for 10-40s in Electron on Windows
    // (HMR websocket/proxy/queue), which was making the popup appear
    // late or never. The built bundle loads from disk in ~200ms.
    const rendererIndex = path.join(__dirname, '../../dist/index.html');
    if (fs.existsSync(rendererIndex)) {
        screenshotPopupWindow.loadFile(rendererIndex, { hash: 'screenshot-popup' });
    } else {
        screenshotPopupWindow.loadURL('http://localhost:5173/#screenshot-popup');
    }

    // Show once the first frame is painted — showing a transparent window
    // before it has content makes it invisible on Windows (DWM never
    // composites it). By ready-to-show the image is already pushed, so
    // the popup appears fully rendered.
    screenshotPopupWindow.once('ready-to-show', () => {
        screenshotPopupWindow?.show();
        screenshotPopupWindow?.setAlwaysOnTop(true, 'screen-saver', 1);
        screenshotPopupWindow?.moveTop();
        console.log(`[${ts()}] [screenshot] popup shown on ready-to-show (+${Date.now() - t0}ms)`);
    });

    // Forward renderer console to main terminal for diagnostics
    screenshotPopupWindow.webContents.on('console-message', (event: any) => {
        console.log(`[${ts()}] [popup-console:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    });

    screenshotPopupWindow.webContents.on('did-fail-load', (_e: any, code: number, desc: string, url: string) => {
        console.error(`[${ts()}] [screenshot] popup load FAILED:`, code, desc, url);
    });

    // Push image data immediately when renderer is ready
    screenshotPopupWindow.webContents.once('did-finish-load', () => {
        console.log(`[${ts()}] [screenshot] did-finish-load, pushing base64 to renderer (+${Date.now() - t0}ms)`);
        screenshotPopupWindow?.webContents.send('screenshot:data-push', {
            base64: base64Image,
            tempPath,
        });
        // Re-assert top position after content renders
        screenshotPopupWindow?.setAlwaysOnTop(true, 'screen-saver', 1);
        screenshotPopupWindow?.moveTop();
    });

    // Force to top after Direct3D settles
    setTimeout(() => {
        if (screenshotPopupWindow && !screenshotPopupWindow.isDestroyed()) {
            screenshotPopupWindow.setAlwaysOnTop(true, 'screen-saver', 1);
            screenshotPopupWindow.moveTop();
        }
    }, 200);

    setTimeout(() => {
        if (screenshotPopupWindow && !screenshotPopupWindow.isDestroyed()) {
            screenshotPopupWindow.setAlwaysOnTop(true, 'screen-saver', 1);
            screenshotPopupWindow.moveTop();
        }
    }, 500);

    console.log(`[${ts()}] [screenshot] step 5: popup created at`, popupX, popupY, '(dip)');

    screenshotPopupWindow.on('closed', () => {
        screenshotPopupWindow = null;
        pendingScreenshotPath = null;
        pendingScreenshotBase64 = null;
    });
}

ipcMain.handle('adb:screenshot', async (_, deviceId: string) => {
    if (isCapturingScreenshot) {
        console.log('[screenshot] already capturing, ignoring duplicate request');
        return { success: false, reason: 'already_capturing' };
    }
    isCapturingScreenshot = true;
    const t0 = Date.now();
    try {
        console.log(`[${ts()}] [screenshot] step 1: screencap on device`, deviceId);
        await runAdbCommand(['-s', deviceId, 'shell', 'screencap', '-p', '/sdcard/mirra_shot.png']);
        console.log(`[${ts()}] [screenshot] step 2: pulling to temp (+${Date.now() - t0}ms)`);
        const tempPath = path.join(app.getPath('temp'), 'mirra_shot.png');
        await runAdbCommand(['-s', deviceId, 'pull', '/sdcard/mirra_shot.png', tempPath]);
        console.log(`[${ts()}] [screenshot] step 3: cleanup on device (+${Date.now() - t0}ms)`);
        await runAdbCommand(['-s', deviceId, 'shell', 'rm', '/sdcard/mirra_shot.png']);

        pendingScreenshotPath = tempPath;
        console.log(`[${ts()}] [screenshot] step 4: pending screenshot stored at`, tempPath);

        // Quick screenshot mode: skip the popup, copy straight to clipboard
        const quickMode = store.get('quickScreenshotMode', false);
        if (quickMode) {
            const img = nativeImage.createFromPath(tempPath);
            clipboard.writeImage(img);
            mainWindow?.webContents.send('toast', {
                msg: 'Screenshot copied to clipboard', type: 'success'
            });
            console.log(`[${ts()}] [screenshot] quick mode: copied to clipboard (+${Date.now() - t0}ms)`);
            return { success: true, quickMode: true };
        }

        // Read image and encode to base64 immediately
        const imgBuffer = await fs.promises.readFile(tempPath);
        const base64Image = imgBuffer.toString('base64');
        console.log(`[${ts()}] [screenshot] encoded base64 length:`, base64Image.length, `(+${Date.now() - t0}ms)`);

        showScreenshotPopup(base64Image, tempPath);

        return { success: true };
    } catch (e: any) {
        console.error('[screenshot] handler threw:', e);
        throw new Error("Screenshot failed: " + e.toString());
    } finally {
        isCapturingScreenshot = false;
    }
});

// --- Full page (long) screenshot: auto-scroll + multi-capture + stitch ---
async function stitchImagesVertically(buffers: Buffer[], outPath: string): Promise<void> {
    const sharp = require('sharp');
    const metas = await Promise.all(buffers.map((b: Buffer) => sharp(b).metadata()));
    const totalHeight = metas.reduce((sum: number, m: any) => sum + (m.height ?? 0), 0);
    const width = metas[0].width ?? 1080;

    const composite: { input: Buffer; top: number; left: number }[] = [];
    let yOffset = 0;
    for (let i = 0; i < buffers.length; i++) {
        composite.push({ input: buffers[i], top: yOffset, left: 0 });
        yOffset += metas[i].height ?? 0;
    }

    await sharp({
        create: { width, height: totalHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } }
    }).composite(composite).png().toFile(outPath);
}

async function imagesAreSimilar(a: Buffer, b: Buffer): Promise<boolean> {
    // Simple size comparison as a fast heuristic
    // (true pixel diff would need pixelmatch — keep simple for v1)
    return a.length === b.length;
}

ipcMain.handle('adb:long-screenshot', async (_e, deviceId: string) => {
    if (isCapturingScreenshot) {
        console.log('[long-screenshot] already capturing, ignoring duplicate request');
        return { success: false, reason: 'already_capturing' };
    }
    isCapturingScreenshot = true;
    try {
        const maxCaptures = 8;      // safety limit — stop after 8 scrolls
        const captures: Buffer[] = [];
        const tempDir = app.getPath('temp');

        for (let i = 0; i < maxCaptures; i++) {
            const shotPath = path.join(tempDir, `mirra_long_${i}.png`);
            await runAdbCommand(['-s', deviceId, 'shell', 'screencap', '-p', '/sdcard/mirra_long_tmp.png']);
            await runAdbCommand(['-s', deviceId, 'pull', '/sdcard/mirra_long_tmp.png', shotPath]);
            const buf = await fs.promises.readFile(shotPath);
            captures.push(buf);

            // Check if this capture is near-identical to the previous one
            // (means we've reached the bottom — stop scrolling)
            if (i > 0 && await imagesAreSimilar(captures[i - 1], buf)) {
                break;
            }

            // Scroll down using adb swipe (simulates a scroll gesture)
            await runAdbCommand(['-s', deviceId, 'shell', 'input', 'swipe', '500', '1800', '500', '400', '300']);
            await new Promise(r => setTimeout(r, 500));  // let UI settle
        }

        await runAdbCommand(['-s', deviceId, 'shell', 'rm', '/sdcard/mirra_long_tmp.png']).catch(() => {});

        // Stitch captures vertically using sharp
        const stitchedPath = path.join(tempDir, 'mirra_long_final.png');
        await stitchImagesVertically(captures, stitchedPath);

        // Reuse the exact same screenshot popup flow as regular screenshots
        const imgBuffer = await fs.promises.readFile(stitchedPath);
        showScreenshotPopup(imgBuffer.toString('base64'), stitchedPath);

        return { success: true, tempPath: stitchedPath };
    } catch (e: any) {
        console.error('[long-screenshot] failed:', e?.message ?? e);
        return { success: false, error: e?.message ?? String(e) };
    } finally {
        isCapturingScreenshot = false;
    }
});

// iOS: list connected iOS devices (via pymobiledevice3)
ipcMain.handle('ios:devices', async () => {
    const binaryPresent = isPymobiledeviceInstalled();
    const devices = await listIosDevices();
    // driversMissing: binary present but no devices enumerated — the device
    // is probably plugged in without Apple's USB drivers (e.g. missing the
    // "Apple Devices" app from the Microsoft Store).
    return { devices, binaryPresent, driversMissing: binaryPresent && devices.length === 0 };
});

// iOS: take screenshot
ipcMain.handle('ios:screenshot', async (_event, udid: string) => {
    if (isCapturingScreenshot) {
        console.log('[screenshot] already capturing, ignoring duplicate request');
        return { success: false, reason: 'already_capturing' };
    }
    isCapturingScreenshot = true;
    try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const tempPath = path.join(app.getPath('temp'), `ios_shot_${stamp}.png`);
        console.log('[ios-screenshot] request for device', udid, '->', tempPath);
        await takeIosScreenshot(udid, tempPath);
        console.log('[ios-screenshot] success:', tempPath);

        // Quick screenshot mode: skip the popup, copy straight to clipboard
        const quickMode = store.get('quickScreenshotMode', false);
        if (quickMode) {
            const img = nativeImage.createFromPath(tempPath);
            clipboard.writeImage(img);
            mainWindow?.webContents.send('toast', {
                msg: 'Screenshot copied to clipboard', type: 'success'
            });
            return { success: true, quickMode: true };
        }

        const imgBuffer = await fs.promises.readFile(tempPath);
        showScreenshotPopup(imgBuffer.toString('base64'), tempPath);
        return { success: true, tempPath };
    } catch (err: any) {
        console.error('[ios-screenshot] FAILED:', err.message);
        return { success: false, error: err.message };
    } finally {
        isCapturingScreenshot = false;
    }
});

// iOS: open the Apple Devices app page in the Microsoft Store
ipcMain.handle('ios:open-store', async () => {
    await shell.openExternal('ms-windows-store://pdp/?productid=9NP83LWLPZ9K');
});

ipcMain.handle('utils:save-file-dialog', async (_, defaultPath: string, filters: any[]) => {
    if (!mainWindow) return null;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        defaultPath,
        filters
    });
    return canceled ? null : filePath;
});

async function closeScrcpyAndWait(timeoutMs = 6000, suppress = true): Promise<void> {
    const proc = scrcpyProcess;
    if (!proc || proc.killed) return;
    scrcpyProcess = null;
    if (suppress) suppressedProcs.add(proc);
    closeMirrorGracefully();
    const killer = setTimeout(() => { if (!proc.killed) proc.kill(); }, timeoutMs);
    await new Promise<void>(resolve => proc.once('close', () => resolve()));
    clearTimeout(killer);
}

async function finalizeRecordingToFile(): Promise<string | null> {
    const temp = recordingFilePath;
    recordingFilePath = null;
    if (!temp) return null;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const result = await dialog.showSaveDialog({
        title: 'Save Recording',
        defaultPath: path.join(app.getPath('videos'), `mirra_recording_${ts}.mp4`),
        filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
    });
    if (result.canceled || !result.filePath) {
        fs.rmSync(temp, { force: true });
        return null;
    }
    fs.copyFileSync(temp, result.filePath);
    fs.rmSync(temp, { force: true });
    return result.filePath;
}

ipcMain.handle('adb:record-start', async (_e, deviceId: string) => {
    if (isTogglingRecord) {
        console.log('[recording] already toggling, ignoring duplicate request');
        return { cancelled: true };
    }
    isTogglingRecord = true;
    try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const temp = path.join(app.getPath('temp'), `mirra_recording_${ts}.mp4`);
        recordingFilePath = temp;

        await closeScrcpyAndWait();

        await launchScrcpy(deviceId, [
            '--record', temp,
            '--record-format', 'mp4',
        ]);

        return { cancelled: false, filePath: temp };
    } finally {
        isTogglingRecord = false;
    }
});

ipcMain.handle('adb:record-stop', async (_e, deviceId: string) => {
    await closeScrcpyAndWait();
    const savedPath = await finalizeRecordingToFile();
    await launchScrcpy(deviceId);
    if (savedPath) mainWindow?.webContents.send('recording:saved', { filePath: savedPath });
    return { success: true, filePath: savedPath ?? undefined };
});

ipcMain.handle('utils:read-image', (_, imgPath: string) => {
    try {
        const data = fs.readFileSync(imgPath);
        const ext = path.extname(imgPath).toLowerCase();
        const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
        return `data:${mime};base64,${data.toString('base64')}`;
    } catch (e) {
        return null;
    }
});

ipcMain.handle('utils:get-path', (_, name: 'pictures' | 'videos') => {
    return app.getPath(name);
});

ipcMain.handle('utils:copy-image-clipboard', (_, imgPath: string) => {
    const fs = require('fs');
    if (fs.existsSync(imgPath)) {
        const { nativeImage } = require('electron');
        const img = nativeImage.createFromPath(imgPath);
        clipboard.writeImage(img);
        return true;
    }
    return false;
});

ipcMain.handle('utils:open-folder', (_, folderPath: string) => {
    shell.showItemInFolder(folderPath); // Note: showItemInFolder opens and selects
});

ipcMain.handle('utils:open-file', async (_, filePath: string) => {
    const err = await shell.openPath(filePath);
    return err ? { success: false, message: err } : { success: true };
});

ipcMain.handle('utils:copy-file', (_, src: string, dest: string) => {
    const fs = require('fs');
    try {
        fs.copyFileSync(src, dest);
        return true;
    } catch {
        return false;
    }
});

ipcMain.handle('store:get', (_, key: string, def?: any) => store.get(key, def));
ipcMain.handle('store:set', (_, key: string, val: any) => store.set(key, val));

// Quick screenshot mode setting (skip popup, copy straight to clipboard)
ipcMain.handle('settings:get-quick-screenshot', () => store.get('quickScreenshotMode', false));
ipcMain.handle('settings:set-quick-screenshot', (_e, val: boolean) => {
    store.set('quickScreenshotMode', !!val);
    return true;
});

// scrcpy.exe native mirror window
async function launchScrcpy(deviceId: string, extraArgs: string[] = []): Promise<boolean> {
    if (scrcpyProcess && !scrcpyProcess.killed) {
        console.log('[scrcpy] already running, ignoring start request');
        return false;
    }
    const scrcpyPath = getScrcpyPath();
    const args = ['-s', deviceId, '--stay-awake'];
    if (store.get('alwaysOnTop', false)) args.push('--always-on-top');
    if (mainWindow) {
        const tb = mainWindow.getBounds();
        args.push('--window-x', String(tb.x + tb.width + 8));
        args.push('--window-y', String(tb.y));
    }
    args.push('--max-size', '1080');
    args.push('--video-bit-rate', '8M');
    args.push('--max-fps', '60');
    args.push('--window-title', 'Mirra Mirror');
    args.push('--render-driver', 'opengl');
    if (extraArgs.length) args.push(...extraArgs);
    console.log('[scrcpy] launching', scrcpyPath, args.join(' '));

    const proc = spawn(scrcpyPath, args, {
        windowsHide: false,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    scrcpyProcess = proc;

    startTracking();

    // Let scrcpy open its window, then briefly refocus the toolbar so
    // the always-on-top ordering settles correctly.
    setTimeout(() => {
        mainWindow?.blur();
        setTimeout(() => mainWindow?.focus(), 100);
    }, 1500);

    proc.on('error', (err) => {
        console.error('[scrcpy] spawn error:', err.message);
        if (scrcpyProcess === proc) scrcpyProcess = null;
        mainWindow?.webContents.send('scrcpy:error', err.message);
    });

    proc.stdout.on('data', (d) => {
        const text = d.toString();
        if (text.trim()) console.log('[scrcpy stdout]', text.trim());
    });

    proc.stderr.on('data', (d) => {
        const text = d.toString().trim();
        if (!text) return;
        console.error('[scrcpy stderr]', text);

        // Filter non-fatal warnings — scrcpy handles port retries itself.
        const ignoredPatterns = [
            'Could not listen on port',
            'bind:',
            'WARN:',
        ];
        const isIgnored = ignoredPatterns.some(p => text.includes(p));
        if (isIgnored) return;

        if (text.includes('ERROR:') || text.includes('error:')) {
            mainWindow?.webContents.send('scrcpy:error', text);
        }
    });

    proc.on('close', (code) => {
        console.log('[scrcpy] exited code:', code);
        if (scrcpyProcess === proc) scrcpyProcess = null;
        if (suppressedProcs.has(proc)) {
            suppressedProcs.delete(proc);
            return;
        }
        stopTracking();
        mainWindow?.webContents.send('scrcpy:stopped', { code });
    });

    return true;
}

ipcMain.handle('scrcpy:start', async (_event, deviceId: string) => {
    const ok = await launchScrcpy(deviceId);
    if (!ok) return { success: false, reason: 'already_running' };
    return { success: true };
});

ipcMain.handle('scrcpy:stop', async () => {
    if (scrcpyProcess) {
        const proc = scrcpyProcess;
        scrcpyProcess = null;
        closeMirrorGracefully();
        setTimeout(() => { if (!proc.killed) proc.kill(); }, 4000);
    }
    return { success: true };
});

ipcMain.handle('scrcpy:status', async () => {
    return { running: scrcpyProcess !== null && !scrcpyProcess.killed };
});

ipcMain.handle('window:set-always-on-top', (_e, value: boolean) => {
    mainWindow?.setAlwaysOnTop(value, 'floating');
    store.set('alwaysOnTop', value);
    setMirrorTopmost(value);
    return { success: true, value };
});

ipcMain.handle('window:get-always-on-top', () => {
    return store.get('alwaysOnTop', false) as boolean;
});

ipcMain.handle('window:close', () => {
    mainWindow?.close();
});

// Theme changes flow one way: renderer request → main flips + persists →
// 'theme:changed' broadcast → every renderer applies the class. This keeps
// the toolbar window, popup windows and the store in sync with a single
// source of truth.
ipcMain.handle('theme:toggle', () => {
    const current = store.get('theme', 'dark') as string;
    const next = current === 'dark' ? 'light' : 'dark';
    store.set('theme', next);
    mainWindow?.webContents.send('theme:changed', next);
    console.log('[theme] toggled to', next);
    return next;
});

// iOS: UxPlay AirPlay mirroring
function getUxplayPath(): string {
    const base = app.isPackaged
        ? process.resourcesPath
        : path.join(__dirname, '..', '..', 'resources');
    return path.join(base, 'ios', 'uxplay.exe');
}

function killUxplay(): void {
    clearUxplayRaiseTimer();
    stopIosTracking();
    if (uxplayProcess && !uxplayProcess.killed) {
        uxplayProcess.kill();
    }
    uxplayProcess = null;
}

async function killUxplayWithWait(): Promise<void> {
    clearUxplayRaiseTimer();
    stopIosTracking();
    if (uxplayProcess && !uxplayProcess.killed) {
        uxplayProcess.kill();
        uxplayProcess = null;
        await new Promise(r => setTimeout(r, 800));
    }
}

const UXPLAY_SINKS = ['d3d11videosink', 'glimagesink', 'autovideosink'];
let uxplaySinkIndex = 0; // 0 = d3d11videosink (most reliable on Windows); fallback: glimagesink, autovideosink
const PIPELINE_ERROR_RE = /could not link|not found|failed to create|cannot create|no element|could not create|not-negotiated|failed to initialize/i;
let uxplayRestarting = false;
let isStartingUxplay = false;
let iosRecordingBase: string | null = null;

function getWifiIP(): string | null {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        const isVirtual = /virtual|vmware|vbox|loopback|wsl|hyper/i.test(name);
        if (isVirtual) continue;
        for (const net of nets[name] ?? []) {
            if (net.family === 'IPv4' && !net.internal) {
                console.log('[ios-mirror] using network interface:', name, net.address);
                return net.address;
            }
        }
    }
    return null;
}

function spawnUxplay(mp4Base?: string): void {
    const uxplayPath = getUxplayPath();
    const args = ['-n', 'Mirra', '-s', '390x844', '-fps', '60', '-vd', 'avdec_h264', '-p', '7000'];
    const sink = uxplaySinkIndex >= 0 ? UXPLAY_SINKS[Math.min(uxplaySinkIndex, UXPLAY_SINKS.length - 1)] : null;
    if (sink) args.push('-vs', sink);
    if (mp4Base) args.push('-mp4', mp4Base);
    const uxplayDir = path.dirname(uxplayPath);
    const proc = spawn(uxplayPath, args, {
        cwd: uxplayDir,
        windowsHide: false,
        env: {
            ...process.env,
            GST_PLUGIN_PATH: path.join(uxplayDir, 'lib', 'gstreamer-1.0'),
            PATH: uxplayDir + path.delimiter + (process.env.PATH || '')
        }
    });
    uxplayProcess = proc;
    console.log('[ios-mirror] uxplay spawned, args:', args.join(' '));

    // Immediately start trying to raise UxPlay's video window. GStreamer's
    // d3d11videosink creates the window under a different PID than the UxPlay
    // process, so PID-based EnumWindows never finds it. Use title-based
    // FindWindowW ("Mirra") instead, matching how resizeIosMirrorWindow works.
    clearUxplayRaiseTimer();
    let raiseAttempts = 0;
    uxplayRaiseTimer = setInterval(() => {
        const raised = raiseIosMirrorWindow();
        console.log('[ios-mirror] raiseIosMirrorWindow returned', raised, '(attempt', raiseAttempts + 1, '/ 30)');
        if (raised) resizeIosMirrorWindow();
        if (++raiseAttempts > 30) {
            clearUxplayRaiseTimer();
        }
    }, 1000);

    // Also start tracking the UxPlay window by title ("Mirra") so that
    // getMirrorRect / refreshMirrorRect work for screenshot popup positioning.
    startIosTracking();

    const handleSinkFallback = (source: string) => {
        if (uxplaySinkIndex < UXPLAY_SINKS.length - 1) {
            mainWindow?.webContents.send('ios:mirror-error', { detail: 'Video renderer failed. Trying fallback...' });
            uxplayRestarting = true;
            uxplaySinkIndex++;
            console.log('[ios-mirror] video pipeline failed (' + source + '), restarting with sink:', UXPLAY_SINKS[uxplaySinkIndex]);
            proc.kill();
            setTimeout(() => {
                uxplayRestarting = false;
                if (!uxplayProcess || uxplayProcess.killed) spawnUxplay(iosRecordingBase ?? undefined);
            }, 600);
        } else {
            console.log('[ios-mirror] all video sinks failed');
            mainWindow?.webContents.send('ios:mirror-error', { detail: 'No video renderer available (d3d11videosink, glimagesink, autovideosink all failed).' });
        }
    };
    const onStderr = (d: Buffer) => {
        const text = d.toString();
        console.log('[uxplay stderr]', text.trim());
        if (/airplay server started|listening|running|waiting for connections|initialized/i.test(text)) {
            mainWindow?.webContents.send('ios:mirror-ready');
        }
        if (/client disconnected|disconnect/i.test(text)) {
            mainWindow?.webContents.send('ios:client-disconnected');
        }
        if (PIPELINE_ERROR_RE.test(text)) {
            handleSinkFallback('stderr');
        }
    };
    let stdoutBuffer = '';
    const onStdout = (d: Buffer) => {
        stdoutBuffer += d.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';
        for (const line of lines) {
            const text = line.trim();
            if (!text) continue;
            console.log('[uxplay stdout]', text);
            if (/server|started|listening|running/i.test(text)) {
                mainWindow?.webContents.send('ios:mirror-ready');
            }
            if (/raop_rtp_mirror starting mirroring|begin streaming|Accepted IPv4 client|Accepted IPv6 client/i.test(text)) {
                console.log('[ios-mirror] client connecting (stdout pattern matched):', text);
                clearUxplayRaiseTimer();
                raiseIosMirrorWindow();
                resizeIosMirrorWindow();
                mainWindow?.webContents.send('ios:client-connected');
            }
            if (/client disconnected|disconnect/i.test(text)) {
                mainWindow?.webContents.send('ios:client-disconnected');
            }
            if (PIPELINE_ERROR_RE.test(text)) {
                handleSinkFallback('stdout');
            }
        }
    };
    proc.stderr?.on('data', onStderr);
    proc.stdout?.on('data', onStdout);

    proc.on('error', (e: any) => {
        mainWindow?.webContents.send('ios:mirror-error', { detail: e.message });
    });
    proc.on('close', (code) => {
        clearUxplayRaiseTimer();
        if (!uxplayRestarting) {
            mainWindow?.webContents.send('ios:mirror-stopped', { code });
        }
        if (uxplayProcess === proc) uxplayProcess = null;
    });
}

ipcMain.handle('ios:mirror-start', async () => {
    if (isStartingUxplay) {
        return { success: false, reason: 'starting' };
    }
    if (uxplayProcess && !uxplayProcess.killed) {
        console.log('[ios-mirror] already running, killing existing process before restart');
        await killUxplayWithWait();
    }
    const uxplayPath = getUxplayPath();
    if (!fs.existsSync(uxplayPath)) {
        return { success: false, error: 'binary_missing' };
    }

    const nets = networkInterfaces();
    const hasNetwork = Object.values(nets).flat().some(
        (n: any) => n && n.family === 'IPv4' && !n.internal
    );
    if (!hasNetwork) {
        return { success: false, reason: 'no_network' };
    }
    const wifiIP = getWifiIP();

    // Ensure firewall rules exist before spawning UxPlay
    if (process.platform === 'win32') {
        const tcpExists = checkFirewallRule(`${AIRPLAY_RULE_NAME} TCP`);
        const udpExists = checkFirewallRule(`${AIRPLAY_RULE_NAME} UDP`);
        if (!tcpExists || !udpExists) {
            console.log('[firewall] rules missing at mirror-start, attempting to create...');
            const result = ensureFirewallRulesSync();
            if (!result.created) {
                console.error('[firewall] failed to create rules, iOS mirroring may not work');
                return {
                    success: false,
                    error: 'firewall',
                    detail: 'Windows Firewall is blocking AirPlay ports (7000-7002). Please run "netsh advfirewall firewall add rule name=\"Mirra AirPlay TCP\" dir=in action=allow protocol=TCP localport=7000-7002" and "netsh advfirewall firewall add rule name=\"Mirra AirPlay UDP\" dir=in action=allow protocol=UDP localport=7000-7002" from an Administrator command prompt, or run Mirra as Administrator once.'
                };
            }
        }
    }

    isStartingUxplay = true;
    try {
        uxplaySinkIndex = 0;
        spawnUxplay();
        mainWindow?.webContents.send('ios:mirror-started');
        setTimeout(() => {
            if (uxplayProcess && !uxplayProcess.killed) {
                mainWindow?.webContents.send('ios:mirror-instruction', {
                    msg: `On your iPhone: Control Center → Screen Mirroring → Mirra\nIP: ${wifiIP || 'unknown'}\nIf not visible: ensure PC and iPhone are on the same Wi-Fi network`
                });
            }
        }, 2000);
        return { success: true };
    } finally {
        isStartingUxplay = false;
    }
});

ipcMain.handle('ios:mirror-stop', async () => {
    if (iosRecordingBase) {
        cleanupIosRecording();
    }
    killUxplay();
    return { success: true };
});

function removeRecordingFiles(base: string): void {
    const dir = path.dirname(base);
    const name = path.basename(base);
    try {
        for (const f of fs.readdirSync(dir)) {
            if (f.startsWith(name)) fs.rmSync(path.join(dir, f), { force: true });
        }
    } catch { /* best effort */ }
}

function cleanupIosRecording(): void {
    const base = iosRecordingBase;
    iosRecordingBase = null;
    if (base) removeRecordingFiles(base);
}

// iOS recording via uxplay's built-in -mp4 stream recorder. Output is written
// as "<base>.<n>.H264.mp4" (video) and "<base>.<n>.AAC.mp4" (audio).
ipcMain.handle('ios:record-start', async () => {
    if (!uxplayProcess || uxplayProcess.killed) {
        return { success: false, error: 'Start iOS mirroring first' };
    }
    if (iosRecordingBase) {
        return { success: false, error: 'Already recording' };
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(app.getPath('temp'), `mirra_ios_rec_${ts}`);
    iosRecordingBase = base;
    console.log('[ios-mirror] starting recording:', base);
    killUxplay();
    spawnUxplay(base);
    return { success: true };
});

ipcMain.handle('ios:record-stop', async () => {
    const base = iosRecordingBase;
    iosRecordingBase = null;
    if (!base) {
        return { success: false, error: 'Not recording' };
    }
    console.log('[ios-mirror] stopping recording:', base);
    killUxplay();
    setTimeout(() => {
        if (!uxplayProcess || uxplayProcess.killed) spawnUxplay();
    }, 600);

    const dir = path.dirname(base);
    const name = path.basename(base);
    const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter(f => f.startsWith(name)).sort()
        : [];
    const video = files.find(f => /\.H264\.mp4$/i.test(f)) || files[0];
    const srcPath = video ? path.join(dir, video) : null;
    if (!srcPath || !fs.existsSync(srcPath)) {
        return { success: false, error: 'No recording produced' };
    }

    const result = await dialog.showSaveDialog({
        title: 'Save iOS Recording',
        defaultPath: path.join(app.getPath('videos'), `mirra_ios_recording_${name.replace('mirra_ios_rec_', '')}.mp4`),
        filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
    });
    if (result.canceled || !result.filePath) {
        removeRecordingFiles(base);
        return { cancelled: true };
    }
    fs.copyFileSync(srcPath, result.filePath);
    removeRecordingFiles(base);
    return { success: true, filePath: result.filePath };
});

// Screenshot popup window actions
ipcMain.handle('screenshot:get-data', () => {
    if (!pendingScreenshotPath || !pendingScreenshotBase64) {
        return { success: false };
    }
    return {
        success: true,
        tempPath: pendingScreenshotPath,
        base64: pendingScreenshotBase64,
    };
});

ipcMain.handle('screenshot:copy-clipboard', async () => {
    if (!pendingScreenshotPath) return;
    const img = nativeImage.createFromPath(pendingScreenshotPath);
    clipboard.writeImage(img);
    screenshotPopupWindow?.close();
    mainWindow?.webContents.send('toast', { msg: 'Copied to clipboard', type: 'success' });
});

ipcMain.handle('screenshot:save', async () => {
    if (!pendingScreenshotPath) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const result = await dialog.showSaveDialog({
        title: 'Save Screenshot',
        defaultPath: path.join(app.getPath('pictures'), `mirra_screenshot_${ts}.png`),
        filters: [{ name: 'PNG Image', extensions: ['png'] }]
    });
    if (!result.canceled && result.filePath) {
        await fs.promises.copyFile(pendingScreenshotPath, result.filePath);
        shell.showItemInFolder(result.filePath);
    }
    screenshotPopupWindow?.close();
});

ipcMain.handle('screenshot:dismiss', () => {
    screenshotPopupWindow?.close();
});
ipcInitialized = true;
}
