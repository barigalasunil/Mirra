export interface AdbDevice {
    id: string;
    isWifi: boolean;
    model: string;
}

export interface DeviceStatus {
    battery: number;
    model: string;
    isWifi: boolean;
    ip?: string;
}

export interface MirrorSettings {
    maxSize?: number;
    bitRate?: number;
    maxFps?: number;
}

export interface ControlMessageData {
    type: 'touch';
    action: number;
    pointerId: number;
    position: { x: number; y: number; screenWidth: number; screenHeight: number };
    pressure: number;
    buttons: number;
}

export interface IosDevice {
    udid: string;
    name: string;
    productType: string;
    iosVersion: string;
}

export interface IosDevicesResult {
    devices: IosDevice[];
    binaryPresent: boolean;
    driversMissing: boolean;
}

export interface IosScreenshotResult {
    success: boolean;
    tempPath?: string;
    error?: string;
}

export interface ElectronAPI {
    // Android (adb)
    adbDevices: () => Promise<AdbDevice[]>;
    adbDeviceStatus: (deviceId: string) => Promise<DeviceStatus | null>;
    adbConnectWifi: (ipPort: string) => Promise<{ success: boolean; message: string }>;
    adbEnableWifi: (deviceId: string) => Promise<{ success: boolean; message: string }>;
    adbDiscoverIp: (deviceId: string) => Promise<{ success: boolean; ip: string; message?: string }>;
    adbKeepAwake: (deviceId: string, state: boolean) => Promise<boolean>;
    adbScreenshot: (deviceId: string) => Promise<{ success: boolean; message?: string }>;

    // iOS (pymobiledevice3)
    iosDevices: () => Promise<IosDevicesResult>;
    iosScreenshot: (udid: string) => Promise<IosScreenshotResult>;
    iosOpenStore: () => Promise<void>;
    iosMirrorStart: () => Promise<{ success: boolean; error?: string; reason?: string }>;
    iosMirrorStop: () => Promise<{ success: boolean }>;
    iosRecordStart: () => Promise<{ success: boolean; error?: string }>;
    iosRecordStop: () => Promise<{ success: boolean; filePath?: string; error?: string; cancelled?: boolean }>;
    onIosMirrorStarted: (callback: () => void) => void;
    removeIosMirrorStarted: () => void;
    onIosMirrorStopped: (callback: (code: number | null) => void) => void;
    removeIosMirrorStopped: () => void;
    onIosMirrorError: (callback: (detail: string) => void) => void;
    removeIosMirrorError: () => void;
    onIosMirrorInstruction: (callback: (msg: string) => void) => void;
    removeIosMirrorInstruction: () => void;
    onIosMirrorReady: (callback: () => void) => void;
    removeIosMirrorReady: () => void;

    // Recording (via scrcpy --record)
    recordStart: (deviceId: string) => Promise<{ cancelled: boolean; filePath?: string }>;
    recordStop: (deviceId: string) => Promise<{ success: boolean; filePath?: string }>;
    onRecordingSaved: (callback: (filePath: string) => void) => void;
    removeRecordingSaved: () => void;

    // Screenshot popup window
    screenshotGetData: () => Promise<{ success: boolean; tempPath?: string; base64?: string }>;
    screenshotCopyClipboard: () => Promise<void>;
    screenshotSave: () => Promise<void>;
    screenshotDismiss: () => Promise<void>;
    onScreenshotDataPush: (callback: (data: { base64: string; tempPath: string }) => void) => void;

    // Utilities
    readImageAsDataUrl: (imgPath: string) => Promise<string | null>;
    utilsSaveFileDialog: (defaultPath: string, filters: any[]) => Promise<string | null>;
    utilsGetPath: (name: string) => Promise<string>;
    utilsCopyImageClipboard: (imgPath: string) => Promise<boolean>;
    utilsOpenFolder: (folderPath: string) => Promise<void>;
    utilsOpenFile: (filePath: string) => Promise<{ success: boolean; message?: string }>;
    utilsCopyFile: (src: string, dest: string) => Promise<boolean>;

    // Settings
    storeGet: (key: string, def?: any) => Promise<any>;
    storeSet: (key: string, val: any) => Promise<void>;

    // Mirroring
    scrcpyStart: (deviceId: string) => Promise<{ success: boolean; message?: string; reason?: string }>;
    scrcpyStop: () => Promise<{ success: boolean }>;
    scrcpyStatus: () => Promise<{ running: boolean }>;
    onScrcpyStopped: (callback: () => void) => void;
    removeScrcpyStopped: () => void;
    onScrcpyError: (callback: (msg: string) => void) => void;
    removeScrcpyError: () => void;

    // Window
    setAlwaysOnTop: (value: boolean) => Promise<{ success: boolean; value: boolean }>;
    getAlwaysOnTop: () => Promise<boolean>;
    closeWindow: () => Promise<void>;

    // Theme (one-way flow: main process owns state, renderer applies)
    requestThemeToggle: () => Promise<string>;
    onThemeChanged: (callback: (newTheme: string) => void) => void;
    removeThemeChanged: () => void;
}
