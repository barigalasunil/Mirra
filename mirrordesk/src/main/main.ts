import { app, BrowserWindow, ipcMain, dialog, shell, clipboard } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import Store from 'electron-store';
import { ScrcpyWsManager } from './scrcpy-ws';
const store: any = new Store();
const isDev = process.env.NODE_ENV === 'development';
let mainWindow: BrowserWindow | null = null;

const getAdbPath = () => {
    return isDev
        ? path.join(__dirname, '../../resources/scrcpy/adb.exe')
        : path.join(process.resourcesPath, 'scrcpy', 'adb.exe');
};

const getScrcpyServerPath = () => {
    return isDev
        ? path.join(__dirname, '../../resources/scrcpy/scrcpy-server.jar')
        : path.join(process.resourcesPath, 'scrcpy', 'scrcpy-server.jar');
};

const wsManager = new ScrcpyWsManager(8080, getAdbPath(), getScrcpyServerPath());
wsManager.on('debug', (event) => {
    if (mainWindow) {
        mainWindow.webContents.send('scrcpy:debug', event);
    }
});

function createWindow() {
    let windowState: any = store.get('windowState', { width: 1100, height: 800 });
    mainWindow = new BrowserWindow({
        width: windowState.width,
        height: windowState.height,
        minWidth: 700,
        minHeight: 500,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
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
    } else {
        mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
    }
}

app.whenReady().then(() => {
    createWindow();

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

app.on('before-quit', () => {
    wsManager.stop();
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

ipcMain.handle('adb:screenshot', async (_, deviceId: string) => {
    try {
        await runAdbCommand(['-s', deviceId, 'shell', 'screencap', '-p', '/sdcard/mirrordesk_shot.png']);
        const tempPath = path.join(app.getPath('temp'), 'mirrordesk_shot.png');
        await runAdbCommand(['-s', deviceId, 'pull', '/sdcard/mirrordesk_shot.png', tempPath]);
        await runAdbCommand(['-s', deviceId, 'shell', 'rm', '/sdcard/mirrordesk_shot.png']);
        return tempPath;
    } catch (e: any) {
        throw new Error("Screenshot failed: " + e.toString());
    }
});

ipcMain.handle('utils:save-file-dialog', async (_, defaultPath: string, filters: any[]) => {
    if (!mainWindow) return null;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        defaultPath,
        filters
    });
    return canceled ? null : filePath;
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

ipcMain.on('scrcpy:start', async (_, deviceId: string, settings: any) => {
    try {
        await wsManager.start(deviceId, settings);
        if (mainWindow) {
            mainWindow.webContents.send('scrcpy:started', deviceId);
        }
    } catch (err: any) {
        console.error('[Scrcpy Main] Failed to start stream', err);
        if (mainWindow) {
            mainWindow.webContents.send('scrcpy:error', err?.message || 'Failed to start stream');
        }
    }
});

ipcMain.on('scrcpy:stop', () => {
    wsManager.stop();
});
