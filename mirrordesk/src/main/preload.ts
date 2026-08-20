import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
    adbDevices: () => ipcRenderer.invoke('adb:devices'),
    adbDeviceStatus: (deviceId: string) => ipcRenderer.invoke('adb:device-status', deviceId),
    adbConnectWifi: (ipPort: string) => ipcRenderer.invoke('adb:connect-wifi', ipPort),
    adbEnableWifi: (deviceId: string) => ipcRenderer.invoke('adb:enable-wifi', deviceId),
    adbDiscoverIp: (deviceId: string) => ipcRenderer.invoke('adb:discover-ip', deviceId),
    adbKeepAwake: (deviceId: string, state: boolean) => ipcRenderer.invoke('adb:keep-awake', deviceId, state),
    adbScreenshot: (deviceId: string) => ipcRenderer.invoke('adb:screenshot', deviceId),
    longScreenshot: (deviceId: string) => ipcRenderer.invoke('adb:long-screenshot', deviceId),

    iosDevices: () => ipcRenderer.invoke('ios:devices'),
    iosScreenshot: (udid: string) => ipcRenderer.invoke('ios:screenshot', udid),
    iosOpenStore: () => ipcRenderer.invoke('ios:open-store'),
    iosMirrorStart: () => ipcRenderer.invoke('ios:mirror-start'),
    iosMirrorStop: () => ipcRenderer.invoke('ios:mirror-stop'),
    iosRecordStart: () => ipcRenderer.invoke('ios:record-start'),
    iosRecordStop: () => ipcRenderer.invoke('ios:record-stop'),
    onIosMirrorStarted: (callback: () => void) => {
        ipcRenderer.on('ios:mirror-started', () => callback());
    },
    removeIosMirrorStarted: () => ipcRenderer.removeAllListeners('ios:mirror-started'),
    onIosMirrorStopped: (callback: (code: number | null) => void) => {
        ipcRenderer.on('ios:mirror-stopped', (_e, data) => callback(data.code));
    },
    removeIosMirrorStopped: () => ipcRenderer.removeAllListeners('ios:mirror-stopped'),
    onIosMirrorError: (callback: (detail: string) => void) => {
        ipcRenderer.on('ios:mirror-error', (_e, data) => callback(data.detail));
    },
    removeIosMirrorError: () => ipcRenderer.removeAllListeners('ios:mirror-error'),
    onIosMirrorInstruction: (callback: (msg: string) => void) => {
        ipcRenderer.on('ios:mirror-instruction', (_e, data) => callback(data.msg));
    },
    removeIosMirrorInstruction: () => ipcRenderer.removeAllListeners('ios:mirror-instruction'),
    onIosMirrorReady: (callback: () => void) => {
        ipcRenderer.on('ios:mirror-ready', () => callback());
    },
    removeIosMirrorReady: () => ipcRenderer.removeAllListeners('ios:mirror-ready'),
    onIosClientConnected: (callback: () => void) => {
        ipcRenderer.on('ios:client-connected', () => callback());
    },
    removeIosClientConnected: () => ipcRenderer.removeAllListeners('ios:client-connected'),
    onIosClientDisconnected: (callback: () => void) => {
        ipcRenderer.on('ios:client-disconnected', () => callback());
    },
    removeIosClientDisconnected: () => ipcRenderer.removeAllListeners('ios:client-disconnected'),

    recordStart: (deviceId: string) => ipcRenderer.invoke('adb:record-start', deviceId),
    recordStop: (deviceId: string) => ipcRenderer.invoke('adb:record-stop', deviceId),
    onRecordingSaved: (callback: (filePath: string) => void) => {
        ipcRenderer.on('recording:saved', (_e, data) => callback(data.filePath));
    },
    removeRecordingSaved: () => ipcRenderer.removeAllListeners('recording:saved'),

    screenshotGetData: () => ipcRenderer.invoke('screenshot:get-data'),
    screenshotCopyClipboard: () => ipcRenderer.invoke('screenshot:copy-clipboard'),
    screenshotSave: () => ipcRenderer.invoke('screenshot:save'),
    screenshotDismiss: () => ipcRenderer.invoke('screenshot:dismiss'),
    onScreenshotDataPush: (callback: (data: { base64: string; tempPath: string }) => void) => {
        ipcRenderer.on('screenshot:data-push', (_e, data) => callback(data));
    },

    readImageAsDataUrl: (imgPath: string) => ipcRenderer.invoke('utils:read-image', imgPath),

    utilsSaveFileDialog: (defaultPath: string, filters: any[]) => ipcRenderer.invoke('utils:save-file-dialog', defaultPath, filters),
    utilsGetPath: (name: string) => ipcRenderer.invoke('utils:get-path', name),
    utilsCopyImageClipboard: (imgPath: string) => ipcRenderer.invoke('utils:copy-image-clipboard', imgPath),
    utilsOpenFolder: (folderPath: string) => ipcRenderer.invoke('utils:open-folder', folderPath),
    utilsOpenFile: (filePath: string) => ipcRenderer.invoke('utils:open-file', filePath),
    utilsCopyFile: (src: string, dest: string) => ipcRenderer.invoke('utils:copy-file', src, dest),
    
    storeGet: (key: string, def?: any) => ipcRenderer.invoke('store:get', key, def),
    storeSet: (key: string, val: any) => ipcRenderer.invoke('store:set', key, val),

    getQuickScreenshotMode: () => ipcRenderer.invoke('settings:get-quick-screenshot'),
    setQuickScreenshotMode: (val: boolean) => ipcRenderer.invoke('settings:set-quick-screenshot', val),

    onToast: (callback: (data: { msg: string; type?: 'success' | 'error' | 'info' }) => void) => {
        ipcRenderer.on('toast', (_e, data) => callback(data));
    },
    removeToast: () => ipcRenderer.removeAllListeners('toast'),
    
    scrcpyStart: (deviceId: string) => ipcRenderer.invoke('scrcpy:start', deviceId),
    scrcpyStop: () => ipcRenderer.invoke('scrcpy:stop'),
    scrcpyStatus: () => ipcRenderer.invoke('scrcpy:status'),

    setAlwaysOnTop: (value: boolean) => ipcRenderer.invoke('window:set-always-on-top', value),
    getAlwaysOnTop: () => ipcRenderer.invoke('window:get-always-on-top'),
    closeWindow: () => ipcRenderer.invoke('window:close'),

    requestThemeToggle: () => ipcRenderer.invoke('theme:toggle'),
    onThemeChanged: (callback: (newTheme: string) => void) => {
        ipcRenderer.on('theme:changed', (_e, newTheme) => callback(newTheme));
    },
    removeThemeChanged: () => ipcRenderer.removeAllListeners('theme:changed'),

    onScrcpyStopped: (callback: () => void) => {
        ipcRenderer.on('scrcpy:stopped', () => callback());
    },
    removeScrcpyStopped: () => ipcRenderer.removeAllListeners('scrcpy:stopped'),

    onScrcpyError: (callback: (msg: string) => void) => {
        ipcRenderer.on('scrcpy:error', (_event, msg) => callback(msg));
    },
    removeScrcpyError: () => ipcRenderer.removeAllListeners('scrcpy:error'),
});
