import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
    adbDevices: () => ipcRenderer.invoke('adb:devices'),
    adbDeviceStatus: (deviceId: string) => ipcRenderer.invoke('adb:device-status', deviceId),
    adbConnectWifi: (ipPort: string) => ipcRenderer.invoke('adb:connect-wifi', ipPort),
    adbEnableWifi: (deviceId: string) => ipcRenderer.invoke('adb:enable-wifi', deviceId),
    adbDiscoverIp: (deviceId: string) => ipcRenderer.invoke('adb:discover-ip', deviceId),
    adbKeepAwake: (deviceId: string, state: boolean) => ipcRenderer.invoke('adb:keep-awake', deviceId, state),
    adbScreenshot: (deviceId: string) => ipcRenderer.invoke('adb:screenshot', deviceId),
    
    utilsSaveFileDialog: (defaultPath: string, filters: any[]) => ipcRenderer.invoke('utils:save-file-dialog', defaultPath, filters),
    utilsGetPath: (name: string) => ipcRenderer.invoke('utils:get-path', name),
    utilsCopyImageClipboard: (imgPath: string) => ipcRenderer.invoke('utils:copy-image-clipboard', imgPath),
    utilsOpenFolder: (folderPath: string) => ipcRenderer.invoke('utils:open-folder', folderPath),
    utilsCopyFile: (src: string, dest: string) => ipcRenderer.invoke('utils:copy-file', src, dest),
    
    storeGet: (key: string, def?: any) => ipcRenderer.invoke('store:get', key, def),
    storeSet: (key: string, val: any) => ipcRenderer.invoke('store:set', key, val),
    
    scrcpyStart: (deviceId: string, settings: any) => ipcRenderer.send('scrcpy:start', deviceId, settings),
    scrcpyStop: () => ipcRenderer.send('scrcpy:stop'),

    onScrcpyDebug: (callback: (event: any) => void) => {
        ipcRenderer.on('scrcpy:debug', (_event, data) => callback(data));
    },
    removeScrcpyDebug: () => ipcRenderer.removeAllListeners('scrcpy:debug'),
    
    onScrcpyStarted: (callback: (deviceId: string) => void) => {
        ipcRenderer.on('scrcpy:started', (_event, deviceId) => callback(deviceId));
    },
    removeScrcpyStarted: () => ipcRenderer.removeAllListeners('scrcpy:started'),
    
    onScrcpyError: (callback: (msg: string) => void) => {
        ipcRenderer.on('scrcpy:error', (_event, msg) => callback(msg));
    },
    removeScrcpyError: () => ipcRenderer.removeAllListeners('scrcpy:error'),
});
