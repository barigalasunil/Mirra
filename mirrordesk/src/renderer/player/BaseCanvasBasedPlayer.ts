import { BasePlayer } from './BasePlayer';
import type { PlaybackStats } from './BasePlayer';
import type ScreenInfo from './ScreenInfo';
import type VideoSettings from './VideoSettings';

export abstract class BaseCanvasBasedPlayer extends BasePlayer {
    protected framesList: Uint8Array[] = [];
    protected decodedFrames: Array<{ width: number; height: number; frame: any }> = [];
    protected videoStats: PlaybackStats[] = [];
    protected animationFrameId: number | undefined;

    public static hasWebGLSupport(): boolean {
        const testCanvas = document.createElement('canvas');
        const names = ['webgl', 'experimental-webgl', 'moz-webgl', 'webkit-3d'];
        for (const name of names) {
            try {
                const gl = testCanvas.getContext(name);
                if (gl) return true;
            } catch {
                // continue
            }
        }
        return false;
    }

    public static createElement(id?: string): HTMLCanvasElement {
        const tag = document.createElement('canvas');
        if (typeof id === 'string') tag.id = id;
        tag.className = 'video-layer';
        return tag;
    }

    constructor(
        udid: string,
        name: string = 'Canvas',
        tag?: HTMLCanvasElement,
    ) {
        super(udid, name, tag ?? BaseCanvasBasedPlayer.createElement());
    }

    protected abstract decode(data: Uint8Array): void;
    public abstract getPreferredVideoSetting(): VideoSettings;

    protected drawDecoded = (): void => {
        if (this.receivedFirstFrame) {
            const data = this.decodedFrames.shift();
            if (data) {
                const { frame, width, height } = data;
                this.renderFrame(frame, width, height);
            }
        }
        if (this.decodedFrames.length) {
            this.animationFrameId = requestAnimationFrame(this.drawDecoded);
        } else {
            this.animationFrameId = undefined;
        }
    };

    protected abstract renderFrame(frame: any, width: number, height: number): void;

    protected onFrameDecoded(width: number, height: number, frame: any): void {
        if (!this.receivedFirstFrame) return;

        let dropped = 0;
        const maxStored = Math.max(1, this.videoSettings.maxFps / 10);

        while (this.decodedFrames.length > maxStored) {
            const data = this.decodedFrames.shift();
            if (data) {
                this.dropFrame(data.frame);
                dropped++;
            }
        }

        this.decodedFrames.push({ width, height, frame });
        this.videoStats.push({
            decodedFrames: 1,
            droppedFrames: dropped,
            inputBytes: 0,
            inputFrames: 0,
            timestamp: Date.now(),
        });

        if (this.onFrame && frame instanceof VideoFrame) {
            this.onFrame(frame);
        }

        if (!this.animationFrameId) {
            this.animationFrameId = requestAnimationFrame(this.drawDecoded);
        }
    }

    protected dropFrame(_frame: any): void {
        // Override to dispose frames if needed
    }

    private shiftFrame(): void {
        if (this.state !== BasePlayer.STATE.PLAYING) return;
        const first = this.framesList.shift();
        if (first) this.decode(first);
    }

    protected calculateMomentumStats(): void {
        const timestamp = Date.now();
        const oneSecondBefore = timestamp - 1000;

        while (this.videoStats.length && this.videoStats[0].timestamp < oneSecondBefore) {
            this.videoStats.shift();
        }
        while (this.inputBytes.length && this.inputBytes[0].timestamp < oneSecondBefore) {
            this.inputBytes.shift();
        }

        let decodedFrames = 0;
        let droppedFrames = 0;
        let inputBytes = 0;
        this.videoStats.forEach((item) => {
            decodedFrames += item.decodedFrames;
            droppedFrames += item.droppedFrames;
        });
        this.inputBytes.forEach((item) => {
            inputBytes += item.bytes;
        });
        this.momentumStats = {
            decodedFrames,
            droppedFrames,
            inputFrames: this.inputBytes.length,
            inputBytes,
            timestamp,
        };
    }

    protected resetStats(): void {
        super.resetStats();
        this.videoStats = [];
    }

    public getImageDataURL(): string {
        return (this.tag as HTMLCanvasElement).toDataURL();
    }

    protected initCanvas(width: number, height: number): void {
        const canvas = this.tag as HTMLCanvasElement;
        canvas.oncontextmenu = (event: MouseEvent) => {
            event.preventDefault();
        };
        canvas.width = Math.round(width);
        canvas.height = Math.round(height);
    }

    public play(): void {
        super.play();
        if (this.state !== BasePlayer.STATE.PLAYING || !this.screenInfo) return;

        const canvas = this.tag as HTMLCanvasElement;
        if (!canvas.width || !canvas.height) {
            const { width, height } = this.screenInfo.videoSize;
            this.initCanvas(width, height);
            this.resetStats();
        }
        this.shiftFrame();
    }

    public stop(): void {
        super.stop();
        this.clearState();
    }

    public setScreenInfo(screenInfo: ScreenInfo): void {
        super.setScreenInfo(screenInfo);
        this.clearState();
        const { width, height } = screenInfo.videoSize;
        this.initCanvas(width, height);
        this.framesList = [];
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = undefined;
        }
    }

    public pushFrame(frame: Uint8Array): void {
        super.pushFrame(frame);
        if (BasePlayer.isIFrame(frame)) {
            const { maxFps } = this.videoSettings;
            if (this.framesList.length > maxFps / 2) {
                const dropped = this.framesList.length;
                this.framesList = [];
                this.videoStats.push({
                    decodedFrames: 0,
                    droppedFrames: dropped,
                    inputBytes: 0,
                    inputFrames: 0,
                    timestamp: Date.now(),
                });
            }
        }
        this.framesList.push(frame);
        this.shiftFrame();
    }

    protected clearState(): void {
        this.framesList = [];
    }
}
