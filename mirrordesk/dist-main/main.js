"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const electron_store_1 = __importDefault(require("electron-store"));
const store = new electron_store_1.default();
let mainWindow = null;
const isDev = process.env.NODE_ENV === 'development';
const getScrcpyPath = () => {
    return isDev
        ? path_1.default.join(__dirname, '../resources/scrcpy/scrcpy.exe')
        : path_1.default.join(process.resourcesPath, 'scrcpy', 'scrcpy.exe');
};
const getAdbPath = () => {
    return isDev
        ? path_1.default.join(__dirname, '../resources/scrcpy/adb.exe')
        : path_1.default.join(process.resourcesPath, 'scrcpy', 'adb.exe');
};
let activeScrcpyProcess = null;
function createWindow() {
    let windowState = store.get('windowState', { width: 900, height: 700 });
    mainWindow = new electron_1.BrowserWindow({
        width: windowState.width,
        height: windowState.height,
        minWidth: 700,
        minHeight: 500,
        webPreferences: {
            preload: path_1.default.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    mainWindow.on('resize', () => {
        if (mainWindow) {
            const { width, height } = mainWindow.getBounds();
            store.set('windowState', { width, height });
        }
    });
    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
    }
    else {
        mainWindow.loadFile(path_1.default.join(__dirname, '../dist/index.html'));
    }
}
electron_1.app.whenReady().then(() => {
    createWindow();
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
electron_1.app.on('before-quit', () => {
    if (activeScrcpyProcess) {
        activeScrcpyProcess.kill();
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
electron_1.ipcMain.handle('adb:devices', async () => {
    try {
        const out = await runAdbCommand(['devices', '-l']);
        const lines = out.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('List of'));
        return lines.map(line => {
            const [id, ...rest] = line.split(/\s+/);
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
        return {
            battery: batteryLevel,
            model: modelOut.trim(),
            isWifi: deviceId.includes(':') // transport parsing handled in devices mostly
        };
    }
    catch (e) {
        return null;
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
electron_1.ipcMain.handle('adb:screenshot', async (_, deviceId) => {
    try {
        await runAdbCommand(['-s', deviceId, 'shell', 'screencap', '-p', '/sdcard/mirrordesk_shot.png']);
        const tempPath = path_1.default.join(electron_1.app.getPath('temp'), 'mirrordesk_shot.png');
        await runAdbCommand(['-s', deviceId, 'pull', '/sdcard/mirrordesk_shot.png', tempPath]);
        await runAdbCommand(['-s', deviceId, 'shell', 'rm', '/sdcard/mirrordesk_shot.png']);
        return tempPath;
    }
    catch (e) {
        throw new Error("Screenshot failed: " + e.toString());
    }
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
electron_1.ipcMain.on('scrcpy:start', (event, deviceId, settings) => {
    if (activeScrcpyProcess) {
        activeScrcpyProcess.kill();
    }
    const scrcpyPath = getScrcpyPath();
    const args = ['--serial', deviceId, '--video-codec', 'h265', '--stay-awake', '--window-title', `MirrorDesk — ${deviceId}`];
    if (settings.maxSize)
        args.push('--max-size', settings.maxSize.toString());
    if (settings.maxFps)
        args.push('--max-fps', settings.maxFps.toString());
    if (settings.videoBitrate)
        args.push('--video-bitrate', settings.videoBitrate.toString());
    activeScrcpyProcess = (0, child_process_1.spawn)(scrcpyPath, args);
    activeScrcpyProcess.on('exit', (code) => {
        activeScrcpyProcess = null;
        if (mainWindow) {
            mainWindow.webContents.send('scrcpy:exited', code);
        }
    });
});
electron_1.ipcMain.on('scrcpy:stop', () => {
    if (activeScrcpyProcess) {
        activeScrcpyProcess.kill();
        activeScrcpyProcess = null;
    }
});
electron_1.ipcMain.on('scrcpy:record-start', (event, deviceId, outputPath, settings) => {
    if (activeScrcpyProcess) {
        activeScrcpyProcess.kill();
    }
    const scrcpyPath = getScrcpyPath();
    const args = [
        '--serial', deviceId,
        '--record', outputPath,
        '--video-codec', 'h265',
        '--stay-awake',
        '--window-title', `MirrorDesk — ${deviceId} [REC]`
    ];
    if (settings.maxFps)
        args.push('--max-fps', settings.maxFps.toString());
    activeScrcpyProcess = (0, child_process_1.spawn)(scrcpyPath, args);
    activeScrcpyProcess.on('exit', (code) => {
        activeScrcpyProcess = null;
        if (mainWindow) {
            mainWindow.webContents.send('scrcpy:record-stopped');
        }
    });
});
