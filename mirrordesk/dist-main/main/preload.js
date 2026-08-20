"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('electronAPI', {
    adbDevices: () => electron_1.ipcRenderer.invoke('adb:devices'),
    adbDeviceStatus: (deviceId) => electron_1.ipcRenderer.invoke('adb:device-status', deviceId),
    adbConnectWifi: (ipPort) => electron_1.ipcRenderer.invoke('adb:connect-wifi', ipPort),
    adbEnableWifi: (deviceId) => electron_1.ipcRenderer.invoke('adb:enable-wifi', deviceId),
    adbDiscoverIp: (deviceId) => electron_1.ipcRenderer.invoke('adb:discover-ip', deviceId),
    adbKeepAwake: (deviceId, state) => electron_1.ipcRenderer.invoke('adb:keep-awake', deviceId, state),
    adbScreenshot: (deviceId) => electron_1.ipcRenderer.invoke('adb:screenshot', deviceId),
    longScreenshot: (deviceId) => electron_1.ipcRenderer.invoke('adb:long-screenshot', deviceId),
    iosDevices: () => electron_1.ipcRenderer.invoke('ios:devices'),
    iosScreenshot: (udid) => electron_1.ipcRenderer.invoke('ios:screenshot', udid),
    iosOpenStore: () => electron_1.ipcRenderer.invoke('ios:open-store'),
    iosMirrorStart: () => electron_1.ipcRenderer.invoke('ios:mirror-start'),
    iosMirrorStop: () => electron_1.ipcRenderer.invoke('ios:mirror-stop'),
    iosRecordStart: () => electron_1.ipcRenderer.invoke('ios:record-start'),
    iosRecordStop: () => electron_1.ipcRenderer.invoke('ios:record-stop'),
    onIosMirrorStarted: (callback) => {
        electron_1.ipcRenderer.on('ios:mirror-started', () => callback());
    },
    removeIosMirrorStarted: () => electron_1.ipcRenderer.removeAllListeners('ios:mirror-started'),
    onIosMirrorStopped: (callback) => {
        electron_1.ipcRenderer.on('ios:mirror-stopped', (_e, data) => callback(data.code));
    },
    removeIosMirrorStopped: () => electron_1.ipcRenderer.removeAllListeners('ios:mirror-stopped'),
    onIosMirrorError: (callback) => {
        electron_1.ipcRenderer.on('ios:mirror-error', (_e, data) => callback(data.detail));
    },
    removeIosMirrorError: () => electron_1.ipcRenderer.removeAllListeners('ios:mirror-error'),
    onIosMirrorInstruction: (callback) => {
        electron_1.ipcRenderer.on('ios:mirror-instruction', (_e, data) => callback(data.msg));
    },
    removeIosMirrorInstruction: () => electron_1.ipcRenderer.removeAllListeners('ios:mirror-instruction'),
    onIosMirrorReady: (callback) => {
        electron_1.ipcRenderer.on('ios:mirror-ready', () => callback());
    },
    removeIosMirrorReady: () => electron_1.ipcRenderer.removeAllListeners('ios:mirror-ready'),
    onIosClientConnected: (callback) => {
        electron_1.ipcRenderer.on('ios:client-connected', () => callback());
    },
    removeIosClientConnected: () => electron_1.ipcRenderer.removeAllListeners('ios:client-connected'),
    onIosClientDisconnected: (callback) => {
        electron_1.ipcRenderer.on('ios:client-disconnected', () => callback());
    },
    removeIosClientDisconnected: () => electron_1.ipcRenderer.removeAllListeners('ios:client-disconnected'),
    recordStart: (deviceId) => electron_1.ipcRenderer.invoke('adb:record-start', deviceId),
    recordStop: (deviceId) => electron_1.ipcRenderer.invoke('adb:record-stop', deviceId),
    onRecordingSaved: (callback) => {
        electron_1.ipcRenderer.on('recording:saved', (_e, data) => callback(data.filePath));
    },
    removeRecordingSaved: () => electron_1.ipcRenderer.removeAllListeners('recording:saved'),
    screenshotGetData: () => electron_1.ipcRenderer.invoke('screenshot:get-data'),
    screenshotCopyClipboard: () => electron_1.ipcRenderer.invoke('screenshot:copy-clipboard'),
    screenshotSave: () => electron_1.ipcRenderer.invoke('screenshot:save'),
    screenshotDismiss: () => electron_1.ipcRenderer.invoke('screenshot:dismiss'),
    onScreenshotDataPush: (callback) => {
        electron_1.ipcRenderer.on('screenshot:data-push', (_e, data) => callback(data));
    },
    readImageAsDataUrl: (imgPath) => electron_1.ipcRenderer.invoke('utils:read-image', imgPath),
    utilsSaveFileDialog: (defaultPath, filters) => electron_1.ipcRenderer.invoke('utils:save-file-dialog', defaultPath, filters),
    utilsGetPath: (name) => electron_1.ipcRenderer.invoke('utils:get-path', name),
    utilsCopyImageClipboard: (imgPath) => electron_1.ipcRenderer.invoke('utils:copy-image-clipboard', imgPath),
    utilsOpenFolder: (folderPath) => electron_1.ipcRenderer.invoke('utils:open-folder', folderPath),
    utilsOpenFile: (filePath) => electron_1.ipcRenderer.invoke('utils:open-file', filePath),
    utilsCopyFile: (src, dest) => electron_1.ipcRenderer.invoke('utils:copy-file', src, dest),
    storeGet: (key, def) => electron_1.ipcRenderer.invoke('store:get', key, def),
    storeSet: (key, val) => electron_1.ipcRenderer.invoke('store:set', key, val),
    getQuickScreenshotMode: () => electron_1.ipcRenderer.invoke('settings:get-quick-screenshot'),
    setQuickScreenshotMode: (val) => electron_1.ipcRenderer.invoke('settings:set-quick-screenshot', val),
    onToast: (callback) => {
        electron_1.ipcRenderer.on('toast', (_e, data) => callback(data));
    },
    removeToast: () => electron_1.ipcRenderer.removeAllListeners('toast'),
    scrcpyStart: (deviceId) => electron_1.ipcRenderer.invoke('scrcpy:start', deviceId),
    scrcpyStop: () => electron_1.ipcRenderer.invoke('scrcpy:stop'),
    scrcpyStatus: () => electron_1.ipcRenderer.invoke('scrcpy:status'),
    setAlwaysOnTop: (value) => electron_1.ipcRenderer.invoke('window:set-always-on-top', value),
    getAlwaysOnTop: () => electron_1.ipcRenderer.invoke('window:get-always-on-top'),
    closeWindow: () => electron_1.ipcRenderer.invoke('window:close'),
    requestThemeToggle: () => electron_1.ipcRenderer.invoke('theme:toggle'),
    onThemeChanged: (callback) => {
        electron_1.ipcRenderer.on('theme:changed', (_e, newTheme) => callback(newTheme));
    },
    removeThemeChanged: () => electron_1.ipcRenderer.removeAllListeners('theme:changed'),
    onScrcpyStopped: (callback) => {
        electron_1.ipcRenderer.on('scrcpy:stopped', () => callback());
    },
    removeScrcpyStopped: () => electron_1.ipcRenderer.removeAllListeners('scrcpy:stopped'),
    onScrcpyError: (callback) => {
        electron_1.ipcRenderer.on('scrcpy:error', (_event, msg) => callback(msg));
    },
    removeScrcpyError: () => electron_1.ipcRenderer.removeAllListeners('scrcpy:error'),
});
