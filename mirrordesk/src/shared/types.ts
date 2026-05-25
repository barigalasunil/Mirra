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
    videoBitrate?: string;
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
