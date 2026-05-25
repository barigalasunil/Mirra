import { BaseCanvasBasedPlayer } from './BaseCanvasBasedPlayer';
import VideoSettings from './VideoSettings';
import Size from './Size';
import ScreenInfo from './ScreenInfo';
import Rect from './Rect';
import { StreamParser, logNal, hexDump } from './StreamParser';
import type { NalUnit, ParserStats } from './StreamParser';

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
    const profileIdc = data[0];
    const constraintFlags = data[1];
    const levelIdc = data[2];

    const codec = `avc1.${[profileIdc, constraintFlags, levelIdc].map(toHex).join('')}`;

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

    return { codec, width, height };
}

export interface WebCodecsDiagnostics {
    configured: boolean;
    configCodec: string;
    decodeCount: number;
    decodeErrors: number;
    lastChunkType: 'key' | 'delta' | 'none';
    lastChunkTimestamp: number;
    parserStats: ParserStats;
    spsCount: number;
    ppsCount: number;
    idrCount: number;
    lastSps: string;
    lastPps: string;
}

export class WebCodecsPlayer extends BaseCanvasBasedPlayer {
    public static readonly playerFullName = 'WebCodecs';
    public static readonly playerCodeName = 'webcodecs';

    public static readonly preferredVideoSettings: VideoSettings = new VideoSettings({
        maxFps: 60,
        iFrameInterval: 10,
        bounds: new Size(720, 720),
    });

    public static isSupported(): boolean {
        return typeof VideoDecoder !== 'undefined'
            && typeof VideoDecoder.isConfigSupported === 'function';
    }

    public readonly supportsScreenshot = true;
    private context: CanvasRenderingContext2D | null;
    private decoder: VideoDecoder | null = null;
    private configured = false;
    private decodeCount = 0;
    private decodeErrors = 0;
    private pts = 0;
    private readonly ptsIncrement: number;

    private parser: StreamParser;
    private sps: NalUnit | null = null;
    private pps: NalUnit | null = null;
    private pendingSps: NalUnit | null = null;
    private pendingPps: NalUnit | null = null;

    private pendingAccessUnits: Array<{ isKey: boolean; data: Uint8Array }> = [];

    private spsCount = 0;
    private ppsCount = 0;
    private idrCount = 0;
    private lastSps = '';
    private lastPps = '';

    private lastChunkType: 'key' | 'delta' | 'none' = 'none';
    private lastChunkTimestamp = 0;

    private streamDump: Uint8Array[] = [];
    private streamDumpSize = 0;
    private readonly maxDumpSize = 5 * 1024 * 1024;

    constructor(udid: string) {
        super(udid, WebCodecsPlayer.playerFullName);
        const ctx = (this.tag as HTMLCanvasElement).getContext('2d');
        if (!ctx) throw new Error('Failed to get 2d context from canvas');
        this.context = ctx;

        this.ptsIncrement = Math.round(1_000_000 / 24);

        this.parser = new StreamParser();
        this.parser.onNalUnit = (nal: NalUnit) => this.onParsedNal(nal);
    }

    private onParsedNal(nal: NalUnit): void {
        const type = nal.type;
        const nalBody = nal.data.subarray(nal.startCodeLen);
        logNal(nal);

        if (type === 7) {
            this.spsCount++;
            this.pendingSps = nal;
            this.lastSps = hexDump(nalBody, 8);
            console.log(`[WebCodecsPlayer] SPS #${this.spsCount} body=${hexDump(nalBody, 16)}`);

            try {
                const { codec, width, height } = parseSPS(nalBody);
                console.log(`[WebCodecsPlayer] SPS parsed: codec=${codec} ${width}x${height}`);
                this.scaleCanvas(width, height);
                this.setupDecoder(codec);
            } catch (e: any) {
                console.error(`[WebCodecsPlayer] SPS parse failed: ${e.message}`);
            }
        } else if (type === 8) {
            this.ppsCount++;
            this.pendingPps = nal;
            this.lastPps = hexDump(nalBody, 8);
            console.log(`[WebCodecsPlayer] PPS #${this.ppsCount} body=${hexDump(nalBody, 16)}`);
        } else if (type === 5) {
            this.idrCount++;
            console.log(`[WebCodecsPlayer] IDR #${this.idrCount} size=${nal.length}`);
            this.feedAccessUnit(true, [nal]);
        } else if (type === 1) {
            this.feedAccessUnit(false, [nal]);
        } else if (type === 6) {
            console.log(`[WebCodecsPlayer] SEI size=${nal.length} body=${hexDump(nalBody, 8)}`);
        } else if (type === 9) {
        } else {
            console.log(`[WebCodecsPlayer] NAL type=${type} size=${nal.length}`);
        }

        if (this.streamDumpSize < this.maxDumpSize) {
            this.streamDump.push(nal.data);
            this.streamDumpSize += nal.data.length;
        }
    }

    private feedAccessUnit(isKey: boolean, vclNals: NalUnit[]): void {
        const segments: Uint8Array[] = [];

        if (isKey) {
            if (this.pendingSps) {
                this.sps = this.pendingSps;
                this.pendingSps = null;
            }
            if (this.pendingPps) {
                this.pps = this.pendingPps;
                this.pendingPps = null;
            }
            if (this.sps) {
                segments.push(this.sps.data);
            }
            if (this.pps) {
                segments.push(this.pps.data);
            }
        }

        for (const nal of vclNals) {
            segments.push(nal.data);
        }

        if (segments.length === 0) return;

        const totalLen = segments.reduce((s, u) => s + u.length, 0);
        const accessUnit = new Uint8Array(totalLen);
        let offset = 0;
        for (const seg of segments) {
            accessUnit.set(seg, offset);
            offset += seg.length;
        }

        const timestamp = this.pts;
        this.pts += this.ptsIncrement;

        if (!this.configured || !this.decoder || this.decoder.state !== 'configured') {
            this.pendingAccessUnits.push({ isKey, data: accessUnit });
            console.log(`[WebCodecsPlayer] BUFFERED access unit (not configured), pending=${this.pendingAccessUnits.length}`);
            return;
        }

        this.doDecode(isKey, accessUnit, timestamp);
    }

    private doDecode(isKey: boolean, data: Uint8Array, timestamp: number): void {
        const chunkType: 'key' | 'delta' = isKey ? 'key' : 'delta';
        try {
            if (typeof EncodedVideoChunk === 'undefined') {
                console.warn('[WebCodecsPlayer] EncodedVideoChunk not available');
                return;
            }
            const chunk = new EncodedVideoChunk({
                type: chunkType,
                timestamp,
                data: data.buffer as ArrayBuffer,
            });
            this.decoder!.decode(chunk);
            this.decodeCount++;
            this.lastChunkType = chunkType;
            this.lastChunkTimestamp = timestamp;
            console.log(`[WebCodecsPlayer] DECODE #${this.decodeCount} type=${chunkType} pts=${timestamp} size=${data.length} sps=${!!this.sps} pps=${!!this.pps}`);
        } catch (e: any) {
            this.decodeErrors++;
            console.error(`[WebCodecsPlayer] Decode error #${this.decodeErrors}: ${e.message}`);
        }
    }

    private flushPending(): void {
        while (this.pendingAccessUnits.length > 0) {
            const unit = this.pendingAccessUnits.shift()!;
            const timestamp = this.pts;
            this.pts += this.ptsIncrement;
            this.doDecode(unit.isKey, unit.data, timestamp);
        }
    }

    private setupDecoder(codec: string): void {
        if (this.decoder && this.decoder.state === 'configured') {
            this.decoder.close();
            this.decoder = null;
        }

        this.decoder = this.createDecoder();
        if (!this.decoder) {
            console.error(`[WebCodecsPlayer] Failed to create decoder`);
            return;
        }

        this.configured = false;

        const config: VideoDecoderConfig = {
            codec,
            optimizeForLatency: true,
        };

        const applyConfig = (cfg: VideoDecoderConfig) => {
            try {
                this.decoder!.configure(cfg);
                this.configured = true;
                console.log(`[WebCodecsPlayer] Decoder CONFIGURED: codec=${cfg.codec}`);
                this.flushPending();
            } catch (e: any) {
                console.error(`[WebCodecsPlayer] configure() threw: ${e.message}`);
                this.configured = false;
            }
        };

        if (typeof VideoDecoder.isConfigSupported === 'function') {
            VideoDecoder.isConfigSupported(config).then((support) => {
                if (support.supported) {
                    applyConfig(support.config ?? config);
                } else {
                    console.warn(`[WebCodecsPlayer] Config not supported, trying direct: ${codec}`);
                    applyConfig(config);
                }
            }).catch((err) => {
                console.warn(`[WebCodecsPlayer] isConfigSupported error, trying direct: ${err.message}`);
                applyConfig(config);
            });
        } else {
            applyConfig(config);
        }
    }

    private createDecoder(): VideoDecoder | null {
        if (typeof VideoDecoder === 'undefined') return null;
        try {
            const decoder = new VideoDecoder({
                output: (frame: VideoFrame) => {
                    const ts = frame.timestamp;
                    console.log(`[WebCodecsPlayer] FRAME decoded: codedWidth=${frame.codedWidth} codedHeight=${frame.codedHeight} pts=${ts} format=${frame.format}`);
                    this.onFrameDecoded(frame.codedWidth, frame.codedHeight, frame);
                },
                error: (error: DOMException) => {
                    this.decodeErrors++;
                    console.error(`[WebCodecsPlayer] Decoder error: ${error.message} code=${error.code}`);
                },
            });
            return decoder;
        } catch (e) {
            console.error(`[WebCodecsPlayer] Failed to create decoder:`, e);
            return null;
        }
    }

    protected decode(data: Uint8Array): void {
        if (!data || data.length === 0) return;
        const nals = this.parser.feed(data);
        if (nals.length > 0) {
            console.log(`[WebCodecsPlayer] decode() feed: ${nals.length} NALs from ${data.length} bytes`);
        }
    }

    public getPreferredVideoSetting(): VideoSettings {
        return WebCodecsPlayer.preferredVideoSettings;
    }

    public getFitToScreenStatus(): boolean {
        return true;
    }

    private scaleCanvas(width: number, height: number): void {
        this.initCanvas(width, height);
        const screenInfo = new ScreenInfo(new Rect(0, 0, width, height), new Size(width, height), 0);
        this.setScreenInfo(screenInfo);
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
            console.log(`[WebCodecsPlayer] RENDER frame ${frame.codedWidth}x${frame.codedHeight} canvas=${canvas.width}x${canvas.height}`);
            frame.close();
        } catch (e) {
            console.error(`[WebCodecsPlayer] Render error:`, e);
        }
    }

    public play(): void {
        super.play();
    }

    public stop(): void {
        super.stop();
        if (this.decoder && this.decoder.state === 'configured') {
            this.decoder.close();
        }
        this.decoder = null;
        this.configured = false;
        this.parser.reset();
        this.sps = null;
        this.pps = null;
        this.pendingSps = null;
        this.pendingPps = null;
        this.decodeCount = 0;
        this.decodeErrors = 0;
        this.pts = 0;
        this.streamDump = [];
        this.streamDumpSize = 0;
    }

    getDiagnostics(): WebCodecsDiagnostics {
        return {
            configured: this.configured,
            configCodec: this.lastSps || 'none',
            decodeCount: this.decodeCount,
            decodeErrors: this.decodeErrors,
            lastChunkType: this.lastChunkType,
            lastChunkTimestamp: this.lastChunkTimestamp,
            parserStats: this.parser.getStats(),
            spsCount: this.spsCount,
            ppsCount: this.ppsCount,
            idrCount: this.idrCount,
            lastSps: this.lastSps,
            lastPps: this.lastPps,
        };
    }

    getStreamDump(): Uint8Array | null {
        if (this.streamDumpSize === 0) return null;
        const total = this.streamDump.reduce((s, u) => s + u.length, 0);
        const result = new Uint8Array(total);
        let offset = 0;
        for (const chunk of this.streamDump) {
            result.set(chunk, offset);
            offset += chunk.length;
        }
        return result;
    }
}
