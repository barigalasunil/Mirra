import VideoSettings from './VideoSettings';
import type ScreenInfo from './ScreenInfo';
import Size from './Size';

export interface PlaybackStats {
    decodedFrames: number;
    droppedFrames: number;
    inputFrames: number;
    inputBytes: number;
    timestamp: number;
}

export interface PlayerClass {
    playerFullName: string;
    playerCodeName: string;
    isSupported(): boolean;
    getPreferredVideoSetting(): VideoSettings;
    new (udid: string): BasePlayer;
}

export abstract class BasePlayer {
    public static readonly STATE = {
        PLAYING: 1,
        PAUSED: 2,
        STOPPED: 3,
    } as const;

    public static readonly preferredVideoSettings: VideoSettings = new VideoSettings({
        maxFps: 24,
        iFrameInterval: 5,
        bounds: new Size(480, 480),
    });

    protected screenInfo: ScreenInfo | null = null;
    protected videoSettings: VideoSettings;
    protected parentElement: HTMLElement | null = null;
    protected touchableCanvas: HTMLCanvasElement;
    protected inputBytes: { timestamp: number; bytes: number }[] = [];
    protected momentumStats: PlaybackStats | null = null;
    protected receivedFirstFrame = false;
    protected videoWidth = -1;
    protected videoHeight = -1;
    protected state: number = BasePlayer.STATE.STOPPED;
    protected onFrame: ((frame: VideoFrame) => void) | null = null;

    public readonly supportsScreenshot: boolean = false;

    public static playerFullName = 'BasePlayer';
    public static playerCodeName = 'baseplayer';

    public static isSupported(): boolean {
        return false;
    }

    public udid: string;
    protected name: string;
    protected tag: HTMLElement;

    constructor(udid: string, name: string = 'BasePlayer', tag: HTMLElement = document.createElement('div')) {
        this.udid = udid;
        this.name = name;
        this.tag = tag;
        this.touchableCanvas = document.createElement('canvas');
        this.touchableCanvas.className = 'touch-layer';
        this.videoSettings = BasePlayer.preferredVideoSettings;
    }

    protected static isIFrame(frame: Uint8Array): boolean {
        return frame && frame.length > 4 && (frame[4] & 0x1f) === 5;
    }

    public abstract getImageDataURL(): string;

    public play(): void {
        this.state = BasePlayer.STATE.PLAYING;
    }

    public pause(): void {
        this.state = BasePlayer.STATE.PAUSED;
    }

    public stop(): void {
        this.state = BasePlayer.STATE.STOPPED;
    }

    public getState(): number {
        return this.state;
    }

    public pushFrame(frame: Uint8Array): void {
        if (!this.receivedFirstFrame) {
            this.receivedFirstFrame = true;
        }
        this.inputBytes.push({
            timestamp: Date.now(),
            bytes: frame.byteLength,
        });
    }

    public abstract getPreferredVideoSetting(): VideoSettings;

    public getTouchableElement(): HTMLCanvasElement {
        return this.touchableCanvas;
    }

    public setParent(parent: HTMLElement): void {
        this.parentElement = parent;
        parent.appendChild(this.tag);
        parent.appendChild(this.touchableCanvas);
    }

    public getVideoSettings(): VideoSettings {
        return this.videoSettings;
    }

    public setVideoSettings(videoSettings: VideoSettings, _fitToScreen: boolean): void {
        this.videoSettings = videoSettings;
        this.resetStats();
    }

    public getScreenInfo(): ScreenInfo | null {
        return this.screenInfo;
    }

    public setScreenInfo(screenInfo: ScreenInfo): void {
        this.screenInfo = screenInfo;
        const { width, height } = screenInfo.videoSize;
        this.touchableCanvas.width = width;
        this.touchableCanvas.height = height;
        if (this.parentElement) {
            this.parentElement.style.height = `${height}px`;
            this.parentElement.style.width = `${width}px`;
        }
    }

    public getName(): string {
        return this.name;
    }

    public setOnFrame(callback: ((frame: VideoFrame) => void) | null): void {
        this.onFrame = callback;
    }

    protected resetStats(): void {
        this.receivedFirstFrame = false;
    }

    protected calculateScreenInfoForBounds(videoWidth: number, videoHeight: number): void {
        this.videoWidth = videoWidth;
        this.videoHeight = videoHeight;
    }
}
