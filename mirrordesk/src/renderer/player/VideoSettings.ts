import Size from './Size';
import Rect from './Rect';

export default class VideoSettings {
    public readonly displayId: number;
    public readonly crop: Rect | null;
    public readonly bitrate: number;
    public readonly bounds: Size | null;
    public readonly maxFps: number;
    public readonly iFrameInterval: number;
    public readonly sendFrameMeta: boolean;
    public readonly lockedVideoOrientation: number;
    public readonly codecOptions: Record<string, string> | null;
    public readonly encoderName: string | null;

    constructor({
        displayId = 0,
        crop = null,
        bitrate = 8000000,
        bounds = null,
        maxFps = 60,
        iFrameInterval = 10,
        sendFrameMeta = false,
        lockedVideoOrientation = -1,
        codecOptions = null,
        encoderName = null,
    }: Partial<VideoSettings> = {}) {
        this.displayId = displayId;
        this.crop = crop;
        this.bitrate = bitrate;
        this.bounds = bounds;
        this.maxFps = maxFps;
        this.iFrameInterval = iFrameInterval;
        this.sendFrameMeta = sendFrameMeta;
        this.lockedVideoOrientation = lockedVideoOrientation;
        this.codecOptions = codecOptions;
        this.encoderName = encoderName;
    }

    public static copy(v: VideoSettings): VideoSettings {
        return new VideoSettings({
            displayId: v.displayId,
            crop: v.crop,
            bitrate: v.bitrate,
            bounds: v.bounds,
            maxFps: v.maxFps,
            iFrameInterval: v.iFrameInterval,
            sendFrameMeta: v.sendFrameMeta,
            lockedVideoOrientation: v.lockedVideoOrientation,
            codecOptions: v.codecOptions,
            encoderName: v.encoderName,
        });
    }

    public equals(o?: VideoSettings | null): boolean {
        if (!o) return false;
        return (
            this.displayId === o.displayId &&
            this.bitrate === o.bitrate &&
            this.maxFps === o.maxFps &&
            this.iFrameInterval === o.iFrameInterval &&
            this.sendFrameMeta === o.sendFrameMeta &&
            this.lockedVideoOrientation === o.lockedVideoOrientation
        );
    }

    public toBuffer(): Buffer {
        const cropBytes = this.crop
            ? new Uint8Array([1, this.crop.left, this.crop.top, this.crop.right, this.crop.bottom].flatMap(n => {
                const b = new ArrayBuffer(4);
                new DataView(b).setInt32(0, n);
                return Array.from(new Uint8Array(b));
            }))
            : new Uint8Array([0]);
        // Simplified - actual scrcpy serialization is more complex
        return Buffer.from(cropBytes);
    }
}
