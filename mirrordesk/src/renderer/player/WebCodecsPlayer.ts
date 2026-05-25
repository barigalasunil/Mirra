import { BaseCanvasBasedPlayer } from './BaseCanvasBasedPlayer';
import VideoSettings from './VideoSettings';
import Size from './Size';
import ScreenInfo from './ScreenInfo';
import Rect from './Rect';

type ParsedSPS = {
    codec: string;
    width: number;
    height: number;
};

function toHex(value: number): string {
    return value.toString(16).padStart(2, '0').toUpperCase();
}

function parseSPS(data: Uint8Array): ParsedSPS {
    if (data.length < 4) throw new Error('SPS too short');
    const profileIdc = data[1];
    const constraintFlags = data[2];
    const levelIdc = data[3];

    let offset = 4;
    while (data[offset] === 0xff) offset++;
    offset++;

    let width = 0;
    let height = 0;

    for (let i = 4; i < data.length - 8; i++) {
        if (data[i] === 0xff && data[i + 1] === 0xff) {
            const mbs = (data[i] << 8) | data[i + 1];
            width = (mbs + 1) * 16;
            if (i + 4 < data.length) {
                const mbsH = (data[i + 4] << 8) | data[i + 5];
                height = (mbsH + 1) * 16;
            }
            break;
        }
    }

    if (width === 0 || height === 0) {
        width = 1920;
        height = 1080;
    }

    const codec = `avc1.${[profileIdc, constraintFlags, levelIdc].map(toHex).join('')}`;
    return { codec, width, height };
}

export class WebCodecsPlayer extends BaseCanvasBasedPlayer {
    public static readonly playerFullName = 'WebCodecs';
    public static readonly playerCodeName = 'webcodecs';

    public static readonly preferredVideoSettings: VideoSettings = new VideoSettings({
        maxFps: 24,
        iFrameInterval: 5,
        bounds: new Size(480, 480),
    });

    public static isSupported(): boolean {
        return typeof VideoDecoder !== 'undefined' && typeof VideoDecoder.isConfigSupported === 'function';
    }

    public readonly supportsScreenshot = true;
    private context: CanvasRenderingContext2D | null;
    private decoder: VideoDecoder | null = null;
    private chunkBuffer: ArrayBuffer | null = null;
    private hadIDR = false;
    private bufferedSPS = false;
    private bufferedPPS = false;
    private configured = false;

    constructor(udid: string) {
        super(udid, WebCodecsPlayer.playerFullName);
        const ctx = (this.tag as HTMLCanvasElement).getContext('2d');
        if (!ctx) throw new Error('Failed to get 2d context from canvas');
        this.context = ctx;
    }

    private createDecoder(): VideoDecoder | null {
        if (typeof VideoDecoder === 'undefined') return null;
        try {
            return new VideoDecoder({
                output: (frame: VideoFrame) => {
                    this.onFrameDecoded(frame.codedWidth, frame.codedHeight, frame);
                },
                error: (error: DOMException) => {
                    console.error(`[WebCodecsPlayer] Decoder error:`, error.message, `code: ${error.code}`);
                },
            });
        } catch (e) {
            console.error(`[WebCodecsPlayer] Failed to create decoder:`, e);
            return null;
        }
    }

    public getPreferredVideoSetting(): VideoSettings {
        return WebCodecsPlayer.preferredVideoSettings;
    }

    public getFitToScreenStatus(): boolean {
        return true;
    }

    private addToBuffer(data: Uint8Array): Uint8Array {
        let array: Uint8Array;
        if (this.chunkBuffer) {
            array = new Uint8Array(this.chunkBuffer.byteLength + data.byteLength);
            array.set(new Uint8Array(this.chunkBuffer));
            array.set(data, this.chunkBuffer.byteLength);
        } else {
            array = data;
        }
        this.chunkBuffer = array.buffer.slice(0) as ArrayBuffer;
        return array;
    }

    private scaleCanvas(width: number, height: number): void {
        this.initCanvas(width, height);
        const screenInfo = new ScreenInfo(new Rect(0, 0, width, height), new Size(width, height), 0);
        this.setScreenInfo(screenInfo);
    }

    protected decode(data: Uint8Array): void {
        if (!data || data.length < 4) return;

        const type = data[0] & 0x1f;
        const isIDR = type === 5;

        if (type === 7) {
            try {
                const { codec, width, height } = parseSPS(data);
                console.log(`[WebCodecsPlayer] SPS: ${codec}, ${width}x${height}`);
                this.scaleCanvas(width, height);

                if (this.decoder && this.decoder.state === 'configured') {
                    this.decoder.close();
                }
                this.decoder = this.createDecoder();
                if (this.decoder) {
                    const config: VideoDecoderConfig = {
                        codec,
                        optimizeForLatency: true,
                    };
                    this.decoder.configure(config);
                    this.configured = true;
                    console.log(`[WebCodecsPlayer] Decoder configured with ${codec}`);
                }
            } catch (e) {
                console.error(`[WebCodecsPlayer] SPS parse error:`, e);
            }
            this.bufferedSPS = true;
            this.addToBuffer(data);
            this.hadIDR = false;
            return;
        } else if (type === 8) {
            this.bufferedPPS = true;
            this.addToBuffer(data);
            return;
        } else if (type === 6) {
            if (!this.bufferedSPS || !this.bufferedPPS) return;
        }

        const array = this.addToBuffer(data);
        this.hadIDR = this.hadIDR || isIDR;

        if (array && this.configured && this.decoder && this.decoder.state === 'configured' && this.hadIDR) {
            this.chunkBuffer = null;
            this.bufferedSPS = false;
            this.bufferedPPS = false;
            try {
                if (typeof EncodedVideoChunk !== 'undefined') {
                    const chunk = new EncodedVideoChunk({
                        type: 'key',
                        timestamp: 0,
                        data: array.buffer as ArrayBuffer,
                    });
                    this.decoder.decode(chunk);
                } else {
                    console.warn(`[WebCodecsPlayer] EncodedVideoChunk not available`);
                }
            } catch (e) {
                console.error(`[WebCodecsPlayer] Decode error:`, e);
            }
        }
    }

    protected renderFrame(frame: any, _width: number, _height: number): void {
        if (!(frame instanceof VideoFrame) || !this.context) return;
        try {
            const canvas = this.tag as HTMLCanvasElement;
            if (canvas.width !== frame.codedWidth || canvas.height !== frame.codedHeight) {
                canvas.width = frame.codedWidth;
                canvas.height = frame.codedHeight;
            }
            this.context.drawImage(frame, 0, 0);
            frame.close();
        } catch (e) {
            console.error(`[WebCodecsPlayer] Render error:`, e);
        }
    }

    public play(): void {
        super.play();
        if (!this.decoder) {
            this.decoder = this.createDecoder();
        }
    }

    public stop(): void {
        super.stop();
        if (this.decoder && this.decoder.state === 'configured') {
            this.decoder.close();
        }
        this.decoder = null;
        this.configured = false;
        this.chunkBuffer = null;
        this.hadIDR = false;
        this.bufferedSPS = false;
        this.bufferedPPS = false;
    }
}
