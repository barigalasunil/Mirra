"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const os_1 = require("os");
const electron_store_1 = __importDefault(require("electron-store"));
const ios_utils_1 = require("./ios-utils");
const scrcpyWindow_1 = require("./scrcpyWindow");
const store = new electron_store_1.default();
const isDev = process.env.NODE_ENV === 'development';
let mainWindow = null;
let scrcpyProcess = null;
let screenshotPopupWindow = null;
let pendingScreenshotPath = null;
let pendingScreenshotBase64 = null;
let recordingFilePath = null;
let uxplayProcess = null;
const suppressedProcs = new Set();
let ipcInitialized = false;
let uxplayRaiseTimer = null;
// --- Firewall auto-setup (Windows) ---
const AIRPLAY_RULE_NAME = 'Mirra AirPlay';
let firewallChecked = false;
function ensureFirewallRules() {
    if (firewallChecked || process.platform !== 'win32')
        return;
    firewallChecked = true;
    const checkRule = (ruleName) => new Promise(resolve => {
        (0, child_process_1.execFile)('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${ruleName}`], { windowsHide: true }, (err, stdout) => {
            resolve(!err && stdout.includes(ruleName));
        });
    });
    const addRule = (ruleName, protocol, ports) => new Promise(resolve => {
        (0, child_process_1.execFile)('netsh', [
            'advfirewall', 'firewall', 'add', 'rule',
            `name=${ruleName}`, 'dir=in', 'action=allow',
            `protocol=${protocol}`, `localport=${ports}`
        ], { windowsHide: true }, (err) => resolve(!err));
    });
    (async () => {
        const tcpExists = await checkRule(`${AIRPLAY_RULE_NAME} TCP`);
        const udpExists = await checkRule(`${AIRPLAY_RULE_NAME} UDP`);
        if (tcpExists && udpExists) {
            console.log('[firewall] AirPlay rules already exist');
            return;
        }
        if (!tcpExists) {
            const ok = await addRule(`${AIRPLAY_RULE_NAME} TCP`, 'TCP', '7000-7002');
            console.log('[firewall] TCP rule:', ok ? 'created' : 'failed (may need admin)');
        }
        if (!udpExists) {
            const ok = await addRule(`${AIRPLAY_RULE_NAME} UDP`, 'UDP', '7000-7002');
            console.log('[firewall] UDP rule:', ok ? 'created' : 'failed (may need admin)');
        }
        if (!tcpExists || !udpExists) {
            mainWindow?.webContents.send('ios:mirror-instruction', {
                msg: 'If iPhone cannot connect: run as Administrator once, or allow Mirra in Windows Firewall'
            });
        }
    })();
}
const ts = () => {
    const d = new Date();
    return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
};
const gotLock = electron_1.app.requestSingleInstanceLock();
if (!gotLock) {
    electron_1.app.quit();
}
else {
    electron_1.app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized())
                mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });
}
const getAdbPath = () => {
    return isDev
        ? path_1.default.join(__dirname, '../../resources/scrcpy/adb.exe')
        : path_1.default.join(process.resourcesPath, 'scrcpy', 'adb.exe');
};
const getScrcpyPath = () => {
    return isDev
        ? path_1.default.join(__dirname, '../../resources/scrcpy/scrcpy.exe')
        : path_1.default.join(process.resourcesPath, 'scrcpy', 'scrcpy.exe');
};
async function loadWithRetry(win, url, maxRetries = 15, delayMs = 300) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await win.loadURL(url);
            return;
        }
        catch (err) {
            console.log(`[main] loadURL attempt ${i + 1} failed, retrying...`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    await win.loadURL(url);
}
async function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 64,
        height: 500,
        minWidth: 64,
        maxWidth: 64,
        resizable: false,
        autoHideMenuBar: true,
        title: 'Mirra',
        frame: false,
        backgroundColor: '#111114',
        show: false,
        roundedCorners: true,
        webPreferences: {
            preload: path_1.default.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.setAutoHideMenuBar(true);
    const savedBounds = store.get('windowBounds');
    if (savedBounds) {
        mainWindow.setBounds({
            x: savedBounds.x,
            y: savedBounds.y,
            width: 64,
            height: 500,
        });
    }
    const savedAlwaysOnTop = store.get('alwaysOnTop', false);
    mainWindow.setAlwaysOnTop(savedAlwaysOnTop);
    mainWindow.on('moved', () => {
        if (mainWindow) {
            const b = mainWindow.getBounds();
            store.set('windowBounds', { x: b.x, y: b.y, width: b.width, height: b.height });
        }
    });
    mainWindow.on('restore', () => (0, scrcpyWindow_1.restoreMirror)());
    mainWindow.on('focus', () => (0, scrcpyWindow_1.restoreMirror)());
    if (isDev) {
        try {
            await loadWithRetry(mainWindow, 'http://localhost:5173');
        }
        catch (err) {
            console.error('[main] load failed, showing window anyway:', err);
        }
    }
    else {
        try {
            await mainWindow.loadFile(path_1.default.join(__dirname, '../../dist/index.html'));
        }
        catch (err) {
            console.error('[main] load failed, showing window anyway:', err);
        }
    }
    mainWindow.show();
    mainWindow.focus();
    console.log('[main] window shown after loadURL resolved');
}
electron_1.app.whenReady().then(() => {
    createWindow();
    ensureFirewallRules();
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
function clearUxplayRaiseTimer() {
    if (uxplayRaiseTimer) {
        clearInterval(uxplayRaiseTimer);
        uxplayRaiseTimer = null;
    }
}
electron_1.app.on('before-quit', () => {
    clearUxplayRaiseTimer();
    (0, scrcpyWindow_1.stopIosTracking)();
    if (scrcpyProcess) {
        scrcpyProcess.kill();
        scrcpyProcess = null;
    }
    if (uxplayProcess) {
        uxplayProcess.kill();
        uxplayProcess = null;
    }
});
function runAdbCommand(args) {
    return new Promise((resolve, reject) => {
        const adbPath = getAdbPath();
        const proc = (0, child_process_1.spawn)(adbPath, args);
        let out = '';
        let err = '';
        proc.stdout.on('data', (d) => out += d.toString());
        proc.stderr.on('data', (d) => err += d.toString());
        proc.on('close', (code) => {
            if (code === 0)
                resolve(out);
            else
                reject(err || out);
        });
    });
}
// IPC Handlers
if (!ipcInitialized) {
    electron_1.ipcMain.handle('adb:devices', async () => {
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
        }
        catch (e) {
            console.error(e);
            return [];
        }
    });
    electron_1.ipcMain.handle('adb:device-status', async (_, deviceId) => {
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
        }
        catch (e) {
            return null;
        }
    });
    electron_1.ipcMain.handle('adb:enable-wifi', async (_, deviceId) => {
        try {
            const result = await runAdbCommand(['-s', deviceId, 'tcpip', '5555']);
            return { success: result.includes('restarting in TCP mode') || result.includes('restarting in tcp mode'), message: result };
        }
        catch (e) {
            return { success: false, message: e.toString() };
        }
    });
    electron_1.ipcMain.handle('adb:discover-ip', async (_, deviceId) => {
        try {
            const ipOut = await runAdbCommand(['-s', deviceId, 'shell', 'getprop', 'dhcp.wlan0.ipaddress']).catch(() => '');
            if (ipOut.trim()) {
                return { success: true, ip: ipOut.trim() };
            }
            const fallback = await runAdbCommand(['-s', deviceId, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0']);
            const match = fallback.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
            return { success: Boolean(match), ip: match?.[1] || '' };
        }
        catch (e) {
            return { success: false, ip: '', message: e.toString() };
        }
    });
    electron_1.ipcMain.handle('adb:connect-wifi', async (_, ipPort) => {
        try {
            const result = await runAdbCommand(['connect', ipPort]);
            return { success: result.includes('connected'), message: result };
        }
        catch (e) {
            return { success: false, message: e.toString() };
        }
    });
    electron_1.ipcMain.handle('adb:keep-awake', async (_, deviceId, state) => {
        const val = state ? '3' : '0';
        try {
            await runAdbCommand(['-s', deviceId, 'shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', val]);
            return true;
        }
        catch {
            return false;
        }
    });
    // Open the screenshot preview popup (Copy / Save As buttons) over the mirror
    // window. Shared by the Android (scrcpy) and iOS (pymobiledevice3) paths.
    function showScreenshotPopup(base64Image, tempPath) {
        pendingScreenshotPath = tempPath;
        pendingScreenshotBase64 = base64Image;
        const t0 = Date.now();
        const popupW = 280;
        const popupH = 200;
        let popupX = 0;
        let popupY = 0;
        // Try Android mirror rect first, then iOS mirror rect
        (0, scrcpyWindow_1.refreshMirrorRect)();
        let rect = (0, scrcpyWindow_1.getMirrorRect)();
        if (!rect) {
            (0, scrcpyWindow_1.refreshIosMirrorRect)();
            rect = (0, scrcpyWindow_1.getIosMirrorRect)();
        }
        console.log('[screenshot] mirror rect:', JSON.stringify(rect));
        if (rect) {
            // GetWindowRect returns physical pixels; BrowserWindow x/y use DIPs.
            // Convert before computing so the popup truly centers on the mirror.
            const lt = electron_1.screen.screenToDipPoint({ x: rect.left, y: rect.top });
            const rb = electron_1.screen.screenToDipPoint({ x: rect.right, y: rect.bottom });
            popupX = Math.round(lt.x + (rb.x - lt.x - popupW) / 2);
            popupY = Math.round(lt.y + (rb.y - lt.y - popupH) / 2);
            const display = electron_1.screen.getDisplayMatching({
                x: lt.x, y: lt.y,
                width: rb.x - lt.x, height: rb.y - lt.y
            });
            const wa = display.workArea;
            popupX = Math.max(wa.x, Math.min(popupX, wa.x + wa.width - popupW));
            popupY = Math.max(wa.y, Math.min(popupY, wa.y + wa.height - popupH));
            console.log('[screenshot] popup centered over mirror window at (dip)', popupX, popupY);
        }
        else if (mainWindow) {
            const tb = mainWindow.getBounds();
            popupX = tb.x + tb.width + 8 + 20;
            popupY = tb.y + 100;
            console.log('[screenshot] mirror rect unavailable, using toolbar fallback');
        }
        if (!mainWindow)
            return;
        screenshotPopupWindow = new electron_1.BrowserWindow({
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
                preload: path_1.default.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false
            }
        });
        // Load the popup from the built bundle, NOT the Vite dev server —
        // Vite page loads can hang for 10-40s in Electron on Windows
        // (HMR websocket/proxy/queue), which was making the popup appear
        // late or never. The built bundle loads from disk in ~200ms.
        const rendererIndex = path_1.default.join(__dirname, '../../dist/index.html');
        if (fs_1.default.existsSync(rendererIndex)) {
            screenshotPopupWindow.loadFile(rendererIndex, { hash: 'screenshot-popup' });
        }
        else {
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
        screenshotPopupWindow.webContents.on('console-message', (event) => {
            console.log(`[${ts()}] [popup-console:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
        });
        screenshotPopupWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
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
    electron_1.ipcMain.handle('adb:screenshot', async (_, deviceId) => {
        const t0 = Date.now();
        try {
            console.log(`[${ts()}] [screenshot] step 1: screencap on device`, deviceId);
            await runAdbCommand(['-s', deviceId, 'shell', 'screencap', '-p', '/sdcard/mirra_shot.png']);
            console.log(`[${ts()}] [screenshot] step 2: pulling to temp (+${Date.now() - t0}ms)`);
            const tempPath = path_1.default.join(electron_1.app.getPath('temp'), 'mirra_shot.png');
            await runAdbCommand(['-s', deviceId, 'pull', '/sdcard/mirra_shot.png', tempPath]);
            console.log(`[${ts()}] [screenshot] step 3: cleanup on device (+${Date.now() - t0}ms)`);
            await runAdbCommand(['-s', deviceId, 'shell', 'rm', '/sdcard/mirra_shot.png']);
            pendingScreenshotPath = tempPath;
            console.log(`[${ts()}] [screenshot] step 4: pending screenshot stored at`, tempPath);
            // Read image and encode to base64 immediately
            const imgBuffer = await fs_1.default.promises.readFile(tempPath);
            const base64Image = imgBuffer.toString('base64');
            console.log(`[${ts()}] [screenshot] encoded base64 length:`, base64Image.length, `(+${Date.now() - t0}ms)`);
            showScreenshotPopup(base64Image, tempPath);
            return { success: true };
        }
        catch (e) {
            console.error('[screenshot] handler threw:', e);
            throw new Error("Screenshot failed: " + e.toString());
        }
    });
    // iOS: list connected iOS devices (via pymobiledevice3)
    electron_1.ipcMain.handle('ios:devices', async () => {
        const binaryPresent = (0, ios_utils_1.isPymobiledeviceInstalled)();
        const devices = await (0, ios_utils_1.listIosDevices)();
        // driversMissing: binary present but no devices enumerated — the device
        // is probably plugged in without Apple's USB drivers (e.g. missing the
        // "Apple Devices" app from the Microsoft Store).
        return { devices, binaryPresent, driversMissing: binaryPresent && devices.length === 0 };
    });
    // iOS: take screenshot
    electron_1.ipcMain.handle('ios:screenshot', async (_event, udid) => {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const tempPath = path_1.default.join(electron_1.app.getPath('temp'), `ios_shot_${ts}.png`);
        console.log('[ios-screenshot] request for device', udid, '->', tempPath);
        try {
            await (0, ios_utils_1.takeIosScreenshot)(udid, tempPath);
            console.log('[ios-screenshot] success:', tempPath);
            const imgBuffer = await fs_1.default.promises.readFile(tempPath);
            showScreenshotPopup(imgBuffer.toString('base64'), tempPath);
            return { success: true, tempPath };
        }
        catch (err) {
            console.error('[ios-screenshot] FAILED:', err.message);
            return { success: false, error: err.message };
        }
    });
    // iOS: open the Apple Devices app page in the Microsoft Store
    electron_1.ipcMain.handle('ios:open-store', async () => {
        await electron_1.shell.openExternal('ms-windows-store://pdp/?productid=9NP83LWLPZ9K');
    });
    electron_1.ipcMain.handle('utils:save-file-dialog', async (_, defaultPath, filters) => {
        if (!mainWindow)
            return null;
        const { canceled, filePath } = await electron_1.dialog.showSaveDialog(mainWindow, {
            defaultPath,
            filters
        });
        return canceled ? null : filePath;
    });
    async function closeScrcpyAndWait(timeoutMs = 6000, suppress = true) {
        const proc = scrcpyProcess;
        if (!proc || proc.killed)
            return;
        scrcpyProcess = null;
        if (suppress)
            suppressedProcs.add(proc);
        (0, scrcpyWindow_1.closeMirrorGracefully)();
        const killer = setTimeout(() => { if (!proc.killed)
            proc.kill(); }, timeoutMs);
        await new Promise(resolve => proc.once('close', () => resolve()));
        clearTimeout(killer);
    }
    async function finalizeRecordingToFile() {
        const temp = recordingFilePath;
        recordingFilePath = null;
        if (!temp)
            return null;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const result = await electron_1.dialog.showSaveDialog({
            title: 'Save Recording',
            defaultPath: path_1.default.join(electron_1.app.getPath('videos'), `mirra_recording_${ts}.mp4`),
            filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
        });
        if (result.canceled || !result.filePath) {
            fs_1.default.rmSync(temp, { force: true });
            return null;
        }
        fs_1.default.copyFileSync(temp, result.filePath);
        fs_1.default.rmSync(temp, { force: true });
        return result.filePath;
    }
    electron_1.ipcMain.handle('adb:record-start', async (_e, deviceId) => {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const temp = path_1.default.join(electron_1.app.getPath('temp'), `mirra_recording_${ts}.mp4`);
        recordingFilePath = temp;
        await closeScrcpyAndWait();
        await launchScrcpy(deviceId, [
            '--record', temp,
            '--record-format', 'mp4',
        ]);
        return { cancelled: false, filePath: temp };
    });
    electron_1.ipcMain.handle('adb:record-stop', async (_e, deviceId) => {
        await closeScrcpyAndWait();
        const savedPath = await finalizeRecordingToFile();
        await launchScrcpy(deviceId);
        if (savedPath)
            mainWindow?.webContents.send('recording:saved', { filePath: savedPath });
        return { success: true, filePath: savedPath ?? undefined };
    });
    electron_1.ipcMain.handle('utils:read-image', (_, imgPath) => {
        try {
            const data = fs_1.default.readFileSync(imgPath);
            const ext = path_1.default.extname(imgPath).toLowerCase();
            const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
            return `data:${mime};base64,${data.toString('base64')}`;
        }
        catch (e) {
            return null;
        }
    });
    electron_1.ipcMain.handle('utils:get-path', (_, name) => {
        return electron_1.app.getPath(name);
    });
    electron_1.ipcMain.handle('utils:copy-image-clipboard', (_, imgPath) => {
        const fs = require('fs');
        if (fs.existsSync(imgPath)) {
            const { nativeImage } = require('electron');
            const img = nativeImage.createFromPath(imgPath);
            electron_1.clipboard.writeImage(img);
            return true;
        }
        return false;
    });
    electron_1.ipcMain.handle('utils:open-folder', (_, folderPath) => {
        electron_1.shell.showItemInFolder(folderPath); // Note: showItemInFolder opens and selects
    });
    electron_1.ipcMain.handle('utils:open-file', async (_, filePath) => {
        const err = await electron_1.shell.openPath(filePath);
        return err ? { success: false, message: err } : { success: true };
    });
    electron_1.ipcMain.handle('utils:copy-file', (_, src, dest) => {
        const fs = require('fs');
        try {
            fs.copyFileSync(src, dest);
            return true;
        }
        catch {
            return false;
        }
    });
    electron_1.ipcMain.handle('store:get', (_, key, def) => store.get(key, def));
    electron_1.ipcMain.handle('store:set', (_, key, val) => store.set(key, val));
    // scrcpy.exe native mirror window
    async function launchScrcpy(deviceId, extraArgs = []) {
        if (scrcpyProcess && !scrcpyProcess.killed) {
            console.log('[scrcpy] already running, ignoring start request');
            return false;
        }
        const scrcpyPath = getScrcpyPath();
        const args = ['-s', deviceId, '--stay-awake'];
        if (store.get('alwaysOnTop', false))
            args.push('--always-on-top');
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
        if (extraArgs.length)
            args.push(...extraArgs);
        console.log('[scrcpy] launching', scrcpyPath, args.join(' '));
        const proc = (0, child_process_1.spawn)(scrcpyPath, args, {
            windowsHide: false,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        scrcpyProcess = proc;
        (0, scrcpyWindow_1.startTracking)();
        // Let scrcpy open its window, then briefly refocus the toolbar so
        // the always-on-top ordering settles correctly.
        setTimeout(() => {
            mainWindow?.blur();
            setTimeout(() => mainWindow?.focus(), 100);
        }, 1500);
        proc.on('error', (err) => {
            console.error('[scrcpy] spawn error:', err.message);
            if (scrcpyProcess === proc)
                scrcpyProcess = null;
            mainWindow?.webContents.send('scrcpy:error', err.message);
        });
        proc.stdout.on('data', (d) => {
            const text = d.toString();
            if (text.trim())
                console.log('[scrcpy stdout]', text.trim());
        });
        proc.stderr.on('data', (d) => {
            const text = d.toString().trim();
            if (!text)
                return;
            console.error('[scrcpy stderr]', text);
            // Filter non-fatal warnings — scrcpy handles port retries itself.
            const ignoredPatterns = [
                'Could not listen on port',
                'bind:',
                'WARN:',
            ];
            const isIgnored = ignoredPatterns.some(p => text.includes(p));
            if (isIgnored)
                return;
            if (text.includes('ERROR:') || text.includes('error:')) {
                mainWindow?.webContents.send('scrcpy:error', text);
            }
        });
        proc.on('close', (code) => {
            console.log('[scrcpy] exited code:', code);
            if (scrcpyProcess === proc)
                scrcpyProcess = null;
            if (suppressedProcs.has(proc)) {
                suppressedProcs.delete(proc);
                return;
            }
            (0, scrcpyWindow_1.stopTracking)();
            mainWindow?.webContents.send('scrcpy:stopped', { code });
        });
        return true;
    }
    electron_1.ipcMain.handle('scrcpy:start', async (_event, deviceId) => {
        const ok = await launchScrcpy(deviceId);
        if (!ok)
            return { success: false, reason: 'already_running' };
        return { success: true };
    });
    electron_1.ipcMain.handle('scrcpy:stop', async () => {
        if (scrcpyProcess) {
            const proc = scrcpyProcess;
            scrcpyProcess = null;
            (0, scrcpyWindow_1.closeMirrorGracefully)();
            setTimeout(() => { if (!proc.killed)
                proc.kill(); }, 4000);
        }
        return { success: true };
    });
    electron_1.ipcMain.handle('scrcpy:status', async () => {
        return { running: scrcpyProcess !== null && !scrcpyProcess.killed };
    });
    electron_1.ipcMain.handle('window:set-always-on-top', (_e, value) => {
        mainWindow?.setAlwaysOnTop(value, 'floating');
        store.set('alwaysOnTop', value);
        (0, scrcpyWindow_1.setMirrorTopmost)(value);
        return { success: true, value };
    });
    electron_1.ipcMain.handle('window:get-always-on-top', () => {
        return store.get('alwaysOnTop', false);
    });
    electron_1.ipcMain.handle('window:close', () => {
        mainWindow?.close();
    });
    function toggleDevToolsDetached() {
        if (!mainWindow)
            return;
        if (mainWindow.webContents.isDevToolsOpened()) {
            mainWindow.webContents.closeDevTools();
        }
        else {
            mainWindow.webContents.openDevTools({ mode: 'detach', activate: true });
        }
    }
    electron_1.ipcMain.handle('window:toggle-devtools', () => toggleDevToolsDetached());
    // More-options native context menu
    electron_1.ipcMain.handle('menu:show-context', async (_e, opts) => {
        const template = [
            {
                label: '📶  Connect via Wi-Fi',
                click: () => mainWindow?.webContents.send('menu:action', 'wifi')
            },
            { type: 'separator' },
            {
                label: opts.theme === 'light' ? '🌙  Dark Mode' : '☀️  Light Mode',
                click: () => mainWindow?.webContents.send('menu:action', 'toggle-theme')
            },
            {
                label: opts.alwaysOnTop ? '📌  Unpin window' : '📌  Pin window',
                click: () => mainWindow?.webContents.send('menu:action', 'toggle-pin')
            },
            { type: 'separator' },
            {
                label: '🔧  Developer Tools',
                click: () => toggleDevToolsDetached()
            },
            { type: 'separator' },
            { label: 'Mirra v0.1.0', enabled: false }
        ];
        electron_1.Menu.buildFromTemplate(template).popup({ window: mainWindow });
    });
    // iOS: UxPlay AirPlay mirroring
    function getUxplayPath() {
        return isDev
            ? path_1.default.join(__dirname, '../../resources/ios/uxplay.exe')
            : path_1.default.join(process.resourcesPath, 'ios', 'uxplay.exe');
    }
    function killUxplay() {
        clearUxplayRaiseTimer();
        (0, scrcpyWindow_1.stopIosTracking)();
        if (uxplayProcess && !uxplayProcess.killed) {
            uxplayProcess.kill();
        }
        uxplayProcess = null;
    }
    async function killUxplayWithWait() {
        clearUxplayRaiseTimer();
        (0, scrcpyWindow_1.stopIosTracking)();
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
    let iosRecordingBase = null;
    function getWifiIP() {
        const nets = (0, os_1.networkInterfaces)();
        for (const name of Object.keys(nets)) {
            const isVirtual = /virtual|vmware|vbox|loopback|wsl|hyper/i.test(name);
            if (isVirtual)
                continue;
            for (const net of nets[name] ?? []) {
                if (net.family === 'IPv4' && !net.internal) {
                    console.log('[ios-mirror] using network interface:', name, net.address);
                    return net.address;
                }
            }
        }
        return null;
    }
    function spawnUxplay(mp4Base) {
        const uxplayPath = getUxplayPath();
        const args = ['-n', 'Mirra', '-s', '390x844', '-fps', '60', '-vd', 'avdec_h264', '-p', '7000'];
        const sink = uxplaySinkIndex >= 0 ? UXPLAY_SINKS[Math.min(uxplaySinkIndex, UXPLAY_SINKS.length - 1)] : null;
        if (sink)
            args.push('-vs', sink);
        if (mp4Base)
            args.push('-mp4', mp4Base);
        const uxplayDir = path_1.default.dirname(uxplayPath);
        const proc = (0, child_process_1.spawn)(uxplayPath, args, {
            cwd: uxplayDir,
            windowsHide: false,
            env: {
                ...process.env,
                GST_PLUGIN_PATH: path_1.default.join(uxplayDir, 'lib', 'gstreamer-1.0'),
                PATH: uxplayDir + path_1.default.delimiter + (process.env.PATH || '')
            }
        });
        uxplayProcess = proc;
        console.log('[ios-mirror] uxplay spawned, args:', args.join(' '));
        // Immediately start trying to raise UxPlay's video window. The GStreamer
        // window may appear before or after stdout emits specific patterns, so we
        // raise proactively on a timer instead of waiting for a regex match.
        clearUxplayRaiseTimer();
        let raiseAttempts = 0;
        const pid = proc.pid;
        if (pid) {
            console.log('[ios-mirror] starting periodic raiseProcessWindows for pid', pid);
            uxplayRaiseTimer = setInterval(() => {
                const raised = (0, scrcpyWindow_1.raiseProcessWindows)(pid);
                console.log('[ios-mirror] raiseProcessWindows returned', raised, 'for pid', pid, '(attempt', raiseAttempts + 1, '/ 30)');
                if (raised > 0)
                    (0, scrcpyWindow_1.resizeIosMirrorWindow)();
                if (++raiseAttempts > 30) {
                    clearUxplayRaiseTimer();
                }
            }, 1000);
        }
        // Also start tracking the UxPlay window by title ("Mirra") so that
        // getMirrorRect / refreshMirrorRect work for screenshot popup positioning.
        (0, scrcpyWindow_1.startIosTracking)();
        const handleSinkFallback = (source) => {
            if (uxplaySinkIndex < UXPLAY_SINKS.length - 1) {
                mainWindow?.webContents.send('ios:mirror-error', { detail: 'Video renderer failed. Trying fallback...' });
                uxplayRestarting = true;
                uxplaySinkIndex++;
                console.log('[ios-mirror] video pipeline failed (' + source + '), restarting with sink:', UXPLAY_SINKS[uxplaySinkIndex]);
                proc.kill();
                setTimeout(() => {
                    uxplayRestarting = false;
                    if (!uxplayProcess || uxplayProcess.killed)
                        spawnUxplay(iosRecordingBase ?? undefined);
                }, 600);
            }
            else {
                console.log('[ios-mirror] all video sinks failed');
                mainWindow?.webContents.send('ios:mirror-error', { detail: 'No video renderer available (d3d11videosink, glimagesink, autovideosink all failed).' });
            }
        };
        const onStderr = (d) => {
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
        const onStdout = (d) => {
            const text = d.toString();
            console.log('[uxplay stdout]', text.trim());
            if (/server|started|listening|running/i.test(text)) {
                mainWindow?.webContents.send('ios:mirror-ready');
            }
            if (/raop_rtp_mirror starting mirroring|begin streaming/i.test(text)) {
                console.log('[ios-mirror] mirroring started (stdout pattern matched), clearing raise timer');
                clearUxplayRaiseTimer();
                if (pid)
                    (0, scrcpyWindow_1.raiseProcessWindows)(pid);
                (0, scrcpyWindow_1.resizeIosMirrorWindow)();
                mainWindow?.webContents.send('ios:client-connected');
            }
            if (/client disconnected|disconnect/i.test(text)) {
                mainWindow?.webContents.send('ios:client-disconnected');
            }
            if (PIPELINE_ERROR_RE.test(text)) {
                handleSinkFallback('stdout');
            }
        };
        proc.stderr?.on('data', onStderr);
        proc.stdout?.on('data', onStdout);
        proc.on('error', (e) => {
            mainWindow?.webContents.send('ios:mirror-error', { detail: e.message });
        });
        proc.on('close', (code) => {
            clearUxplayRaiseTimer();
            if (!uxplayRestarting) {
                mainWindow?.webContents.send('ios:mirror-stopped', { code });
            }
            if (uxplayProcess === proc)
                uxplayProcess = null;
        });
    }
    electron_1.ipcMain.handle('ios:mirror-start', async () => {
        if (isStartingUxplay) {
            return { success: false, reason: 'starting' };
        }
        if (uxplayProcess && !uxplayProcess.killed) {
            console.log('[ios-mirror] already running, killing existing process before restart');
            await killUxplayWithWait();
        }
        const uxplayPath = getUxplayPath();
        if (!fs_1.default.existsSync(uxplayPath)) {
            return { success: false, error: 'binary_missing' };
        }
        const nets = (0, os_1.networkInterfaces)();
        const hasNetwork = Object.values(nets).flat().some((n) => n && n.family === 'IPv4' && !n.internal);
        if (!hasNetwork) {
            return { success: false, reason: 'no_network' };
        }
        getWifiIP();
        isStartingUxplay = true;
        try {
            uxplaySinkIndex = 0;
            spawnUxplay();
            mainWindow?.webContents.send('ios:mirror-started');
            setTimeout(() => {
                if (uxplayProcess && !uxplayProcess.killed) {
                    mainWindow?.webContents.send('ios:mirror-instruction', {
                        msg: 'On your iPhone: Control Center → Screen Mirroring → Mirra\nIf not visible: allow Mirra in Windows Firewall when prompted'
                    });
                }
            }, 2000);
            return { success: true };
        }
        finally {
            isStartingUxplay = false;
        }
    });
    electron_1.ipcMain.handle('ios:mirror-stop', async () => {
        if (iosRecordingBase) {
            cleanupIosRecording();
        }
        killUxplay();
        return { success: true };
    });
    function removeRecordingFiles(base) {
        const dir = path_1.default.dirname(base);
        const name = path_1.default.basename(base);
        try {
            for (const f of fs_1.default.readdirSync(dir)) {
                if (f.startsWith(name))
                    fs_1.default.rmSync(path_1.default.join(dir, f), { force: true });
            }
        }
        catch { /* best effort */ }
    }
    function cleanupIosRecording() {
        const base = iosRecordingBase;
        iosRecordingBase = null;
        if (base)
            removeRecordingFiles(base);
    }
    // iOS recording via uxplay's built-in -mp4 stream recorder. Output is written
    // as "<base>.<n>.H264.mp4" (video) and "<base>.<n>.AAC.mp4" (audio).
    electron_1.ipcMain.handle('ios:record-start', async () => {
        if (!uxplayProcess || uxplayProcess.killed) {
            return { success: false, error: 'Start iOS mirroring first' };
        }
        if (iosRecordingBase) {
            return { success: false, error: 'Already recording' };
        }
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const base = path_1.default.join(electron_1.app.getPath('temp'), `mirra_ios_rec_${ts}`);
        iosRecordingBase = base;
        console.log('[ios-mirror] starting recording:', base);
        killUxplay();
        spawnUxplay(base);
        return { success: true };
    });
    electron_1.ipcMain.handle('ios:record-stop', async () => {
        const base = iosRecordingBase;
        iosRecordingBase = null;
        if (!base) {
            return { success: false, error: 'Not recording' };
        }
        console.log('[ios-mirror] stopping recording:', base);
        killUxplay();
        setTimeout(() => {
            if (!uxplayProcess || uxplayProcess.killed)
                spawnUxplay();
        }, 600);
        const dir = path_1.default.dirname(base);
        const name = path_1.default.basename(base);
        const files = fs_1.default.existsSync(dir)
            ? fs_1.default.readdirSync(dir).filter(f => f.startsWith(name)).sort()
            : [];
        const video = files.find(f => /\.H264\.mp4$/i.test(f)) || files[0];
        const srcPath = video ? path_1.default.join(dir, video) : null;
        if (!srcPath || !fs_1.default.existsSync(srcPath)) {
            return { success: false, error: 'No recording produced' };
        }
        const result = await electron_1.dialog.showSaveDialog({
            title: 'Save iOS Recording',
            defaultPath: path_1.default.join(electron_1.app.getPath('videos'), `mirra_ios_recording_${name.replace('mirra_ios_rec_', '')}.mp4`),
            filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
        });
        if (result.canceled || !result.filePath) {
            removeRecordingFiles(base);
            return { cancelled: true };
        }
        fs_1.default.copyFileSync(srcPath, result.filePath);
        removeRecordingFiles(base);
        return { success: true, filePath: result.filePath };
    });
    // Screenshot popup window actions
    electron_1.ipcMain.handle('screenshot:get-data', () => {
        if (!pendingScreenshotPath || !pendingScreenshotBase64) {
            return { success: false };
        }
        return {
            success: true,
            tempPath: pendingScreenshotPath,
            base64: pendingScreenshotBase64,
        };
    });
    electron_1.ipcMain.handle('screenshot:copy-clipboard', async () => {
        if (!pendingScreenshotPath)
            return;
        const img = electron_1.nativeImage.createFromPath(pendingScreenshotPath);
        electron_1.clipboard.writeImage(img);
        screenshotPopupWindow?.close();
        mainWindow?.webContents.send('toast', { msg: 'Copied to clipboard', type: 'success' });
    });
    electron_1.ipcMain.handle('screenshot:save', async () => {
        if (!pendingScreenshotPath)
            return;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const result = await electron_1.dialog.showSaveDialog({
            title: 'Save Screenshot',
            defaultPath: path_1.default.join(electron_1.app.getPath('pictures'), `mirra_screenshot_${ts}.png`),
            filters: [{ name: 'PNG Image', extensions: ['png'] }]
        });
        if (!result.canceled && result.filePath) {
            await fs_1.default.promises.copyFile(pendingScreenshotPath, result.filePath);
            electron_1.shell.showItemInFolder(result.filePath);
        }
        screenshotPopupWindow?.close();
    });
    electron_1.ipcMain.handle('screenshot:dismiss', () => {
        screenshotPopupWindow?.close();
    });
    ipcInitialized = true;
}
