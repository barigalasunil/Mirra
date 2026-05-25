"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('electronAPI', {
    adbDevices: () => electron_1.ipcRenderer.invoke('adb:devices'),
    adbDeviceStatus: (deviceId) => electron_1.ipcRenderer.invoke('adb:device-status', deviceId),
    adbConnectWifi: (ipPort) => electron_1.ipcRenderer.invoke('adb:connect-wifi', ipPort),
    adbKeepAwake: (deviceId, state) => electron_1.ipcRenderer.invoke('adb:keep-awake', deviceId, state),
    adbScreenshot: (deviceId) => electron_1.ipcRenderer.invoke('adb:screenshot', deviceId),
    utilsSaveFileDialog: (defaultPath, filters) => electron_1.ipcRenderer.invoke('utils:save-file-dialog', defaultPath, filters),
    utilsGetPath: (name) => electron_1.ipcRenderer.invoke('utils:get-path', name),
    utilsCopyImageClipboard: (imgPath) => electron_1.ipcRenderer.invoke('utils:copy-image-clipboard', imgPath),
    utilsOpenFolder: (folderPath) => electron_1.ipcRenderer.invoke('utils:open-folder', folderPath),
    utilsCopyFile: (src, dest) => electron_1.ipcRenderer.invoke('utils:copy-file', src, dest),
    storeGet: (key, def) => electron_1.ipcRenderer.invoke('store:get', key, def),
    storeSet: (key, val) => electron_1.ipcRenderer.invoke('store:set', key, val),
    scrcpyStart: (deviceId, settings) => electron_1.ipcRenderer.send('scrcpy:start', deviceId, settings),
    scrcpyStop: () => electron_1.ipcRenderer.send('scrcpy:stop'),
    scrcpyRecordStart: (deviceId, outPath, settings) => electron_1.ipcRenderer.send('scrcpy:record-start', deviceId, outPath, settings),
    onScrcpyExited: (callback) => {
        electron_1.ipcRenderer.on('scrcpy:exited', (_, code) => callback(code));
    },
    removeScrcpyExited: () => electron_1.ipcRenderer.removeAllListeners('scrcpy:exited'),
    onScrcpyRecordStopped: (callback) => {
        electron_1.ipcRenderer.on('scrcpy:record-stopped', () => callback());
    },
    removeScrcpyRecordStopped: () => electron_1.ipcRenderer.removeAllListeners('scrcpy:record-stopped')
});
