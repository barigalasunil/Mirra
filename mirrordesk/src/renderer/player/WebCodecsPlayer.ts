import { BaseCanvasBasedPlayer } from './BaseCanvasBasedPlayer';
import VideoSettings from './VideoSettings';
import Size from './Size';
import ScreenInfo from './ScreenInfo';
import Rect from './Rect';
import { StreamParser, logNal, hexDump } from './StreamParser';
import type { NalUnit, ParserStats } from './StreamParser';

const DEV_MODE = import.meta.env.DEV;
const FALLBACK_CODEC = 'avc1.42E01E';
const FALLBACK_WIDTH = 1080;
const FALLBACK_HEIGHT = 1920;

type ParsedSPS = {
    codec: string;
    width: number;
    height: number;
};

function toHex(value: number): string {
    return value.toString(16).padStart(2, '0').toUpperCase();
}

class SpsBitReader {
    private data: Uint8Array;
    private bitPos = 0;

    constructor(data: Uint8Array) {
        this.data = data;
    }

    getBit(): number {
        const byte = this.data[this.bitPos >> 3];
        const bit = (byte >> (7 - (this.bitPos & 7))) & 1;
        this.bitPos++;
        return bit;
    }

    getBits(count: number): number {
        let value = 0;
        for (let i = 0; i < count; i++) {
            value = (value << 1) | this.getBit();
        }
        return value;
    }

    getUe(): number {
        let leadingZeros = 0;
        while (this.getBit() === 0) {
            leadingZeros++;
            if (leadingZeros > 31) throw new Error('SPS: invalid Exp-Golomb code');
        }
        return (1 << leadingZeros) - 1 + this.getBits(leadingZeros);
    }

    getSe(): number {
        const ue = this.getUe();
        return (ue & 1) === 0 ? -(ue >> 1) : (ue + 1) >> 1;
    }

    getBool(): boolean {
        return this.getBit() === 1;
    }
}

function skipScalingList(reader: SpsBitReader, sizeOfScalingList: number): void {
    let lastScale = 8;
    let nextScale = 8;
    for (let i = 0; i < sizeOfScalingList; i++) {
        if (nextScale !== 0) {
            const deltaScale = reader.getSe();
            nextScale = (lastScale + deltaScale + 256) % 256;
        }
        if (nextScale !== 0) {
            lastScale = nextScale;
        }
    }
}

function parseSPS(data: Uint8Array): ParsedSPS {
    if (data.length < 4) throw new Error('SPS too short');

    // `data` includes the NAL header byte at index 0 (0x67 for an SPS).
    const body = data.subarray(1);
    const profileIdc = body[0];
    const constraintFlags = body[1];
    const levelIdc = body[2];
    const codec = `avc1.${toHex(profileIdc)}${toHex(constraintFlags)}${toHex(levelIdc)}`;

    const reader = new SpsBitReader(body.subarray(3));
    reader.getUe(); // seq_parameter_set_id

    let chromaFormatIdc = 1;
    const highProfiles = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134];
    if (highProfiles.includes(profileIdc)) {
        chromaFormatIdc = reader.getUe();
        if (chromaFormatIdc === 3) {
            reader.getBit(); // separate_colour_plane_flag
        }
        reader.getUe(); // bit_depth_luma_minus8
        reader.getUe(); // bit_depth_chroma_minus8
        reader.getBit(); // qpprime_y_zero_transform_bypass_flag
        if (reader.getBool()) {
            // seq_scaling_matrix_present_flag
            const scalingListCount = chromaFormatIdc === 3 ? 12 : 8;
            for (let i = 0; i < scalingListCount; i++) {
                if (reader.getBool()) {
                    skipScalingList(reader, i < 6 ? 16 : 64);
                }
            }
        }
    }

    reader.getUe(); // log2_max_frame_num_minus4
    const picOrderCntType = reader.getUe();
    if (picOrderCntType === 0) {
        reader.getUe(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
        reader.getBit(); // delta_pic_order_always_zero_flag
        reader.getSe(); // offset_for_non_ref_pic
        reader.getSe(); // offset_for_top_to_bottom_field
        const numRefFramesInPicOrderCntCycle = reader.getUe();
        for (let i = 0; i < numRefFramesInPicOrderCntCycle; i++) {
            reader.getSe(); // offset_for_ref_frame[i]
        }
    }
    reader.getUe(); // max_num_ref_frames
    reader.getBit(); // gaps_in_frame_num_value_allowed_flag
    const picWidthInMbsMinus1 = reader.getUe();
    const picHeightInMapUnitsMinus1 = reader.getUe();
    const frameMbsOnlyFlag = reader.getBool();
    if (!frameMbsOnlyFlag) {
        reader.getBit(); // mb_adaptive_frame_field_flag
    }
    reader.getBit(); // direct_8x8_inference_flag
    const frameCroppingFlag = reader.getBool();
    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    if (frameCroppingFlag) {
        cropLeft = reader.getUe();
        cropRight = reader.getUe();
        cropTop = reader.getUe();
        cropBottom = reader.getUe();
    }

    let width = (picWidthInMbsMinus1 + 1) * 16;
    let height = (2 - (frameMbsOnlyFlag ? 1 : 0)) * (picHeightInMapUnitsMinus1 + 1) * 16;

    const subWidthC = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1;
    const subHeightC = chromaFormatIdc === 1 ? 2 : 1;
    width -= (cropLeft + cropRight) * subWidthC;
    height -= (cropTop + cropBottom) * subHeightC;

    if (width <= 0 || height <= 0) {
        throw new Error('SPS: invalid dimensions');
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

    private spsReceived = false;
    private ppsReceived = false;
    private spsKey = '';
    private configuredSpsKey: string | null = null;
    private pendingReconfigure = false;
    private spsCodec = FALLBACK_CODEC;
    private currentWidth = FALLBACK_WIDTH;
    private currentHeight = FALLBACK_HEIGHT;

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

    public onEncodedChunk: ((chunk: EncodedVideoChunk, isKey: boolean, description: Uint8Array | null) => void) | null = null;

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
        if (DEV_MODE) logNal(nal);

        if (type === 7) {
            this.spsCount++;
            this.spsReceived = true;
            this.pendingSps = nal;
            this.lastSps = hexDump(nalBody, 8);
            this.spsKey = hexDump(nalBody, 16);
            if (this.spsKey !== this.configuredSpsKey) {
                this.pendingReconfigure = true;
            }
            if (DEV_MODE) console.log(`[WebCodecsPlayer] SPS #${this.spsCount} body=${hexDump(nalBody, 16)}`);

            try {
                const { codec, width, height } = parseSPS(nalBody);
                this.spsCodec = codec;
                this.currentWidth = width;
                this.currentHeight = height;
                console.log(`[SPS] parsed:`, width, height);
                if (DEV_MODE) console.log(`[WebCodecsPlayer] SPS codec=${codec} ${width}x${height}`);
                this.scaleCanvas(width, height);
            } catch (e: any) {
                console.error(`[WebCodecsPlayer] SPS parse failed: ${e.message}`);
                this.spsCodec = FALLBACK_CODEC;
                this.currentWidth = FALLBACK_WIDTH;
                this.currentHeight = FALLBACK_HEIGHT;
            }
        } else if (type === 8) {
            this.ppsCount++;
            this.ppsReceived = true;
            this.pendingPps = nal;
            this.lastPps = hexDump(nalBody, 8);
            if (DEV_MODE) console.log(`[WebCodecsPlayer] PPS #${this.ppsCount} body=${hexDump(nalBody, 16)}`);
        } else if (type === 5) {
            this.idrCount++;
            if (DEV_MODE) console.log(`[WebCodecsPlayer] IDR #${this.idrCount} size=${nal.length}`);
            if (!this.spsReceived || !this.ppsReceived) return;
            this.ensureDecoderConfigured();
            this.feedAccessUnit(true, [nal]);
        } else if (type === 1) {
            if (this.configured && this.decoder && this.decoder.state === 'configured') {
                this.feedAccessUnit(false, [nal]);
            }
        } else if (type === 6) {
            if (DEV_MODE) console.log(`[WebCodecsPlayer] SEI size=${nal.length}`);
        } else {
            if (DEV_MODE) console.log(`[WebCodecsPlayer] NAL type=${type} size=${nal.length}`);
        }

        if (this.streamDumpSize < this.maxDumpSize) {
            this.streamDump.push(nal.data);
            this.streamDumpSize += nal.data.length;
        }
    }

    private ensureDecoderConfigured(): void {
        if (!this.decoder || this.decoder.state === 'closed') {
            this.decoder = this.createDecoder();
            this.configured = false;
        }
        if (this.decoder && this.decoder.state === 'configured' && !this.pendingReconfigure) return;
        if (!this.spsReceived || !this.ppsReceived) return;

        try {
            this.decoder!.configure({
                codec: this.spsCodec,
                optimizeForLatency: true,
                hardwareAcceleration: 'prefer-hardware',
            });
            this.configured = true;
            this.pendingReconfigure = false;
            this.configuredSpsKey = this.spsKey;
            console.log(`[WebCodecsPlayer] Decoder CONFIGURED: codec=${this.spsCodec}`);
            this.flushPending();
        } catch (e: any) {
            console.error(`[WebCodecsPlayer] configure() threw: ${e.message}`);
            this.configured = false;
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
            if (DEV_MODE) console.log(`[WebCodecsPlayer] BUFFERED access unit (not configured), pending=${this.pendingAccessUnits.length}`);
            return;
        }

        this.doDecode(isKey, accessUnit, timestamp);
    }

    private doDecode(isKey: boolean, data: Uint8Array, timestamp: number): void {
        const chunkType: 'key' | 'delta' = isKey ? 'key' : 'delta';
        if (!this.decoder || this.decoder.state !== 'configured') return;
        try {
            if (typeof EncodedVideoChunk === 'undefined') {
                if (DEV_MODE) console.warn('[WebCodecsPlayer] EncodedVideoChunk not available');
                return;
            }
            const chunk = new EncodedVideoChunk({
                type: chunkType,
                timestamp,
                data: data.buffer as ArrayBuffer,
            });
            if (this.onEncodedChunk) {
                const description = isKey ? this.getAvcDescription() : null;
                this.onEncodedChunk(chunk, isKey, description);
            }
            this.decoder.decode(chunk);
            this.decodeCount++;
            this.lastChunkType = chunkType;
            this.lastChunkTimestamp = timestamp;
            if (DEV_MODE) console.log(`[WebCodecsPlayer] DECODE #${this.decodeCount} type=${chunkType} pts=${timestamp} size=${data.length} hex=${hexDump(data, 16)}`);
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

    public getAvcDescription(): Uint8Array | null {
        if (!this.sps || !this.pps) return null;
        const sps = this.sps.data.subarray(this.sps.startCodeLen + 1);
        const pps = this.pps.data.subarray(this.pps.startCodeLen + 1);
        if (sps.length === 0 || pps.length === 0) return null;
        const description = new Uint8Array(1 + 3 + 1 + 1 + 2 + sps.length + 1 + 2 + pps.length);
        let offset = 0;
        description[offset++] = 1;                 // configurationVersion
        description[offset++] = sps[0];            // profile_idc
        description[offset++] = sps[1];            // profile_compatibility
        description[offset++] = sps[2];            // level_idc
        description[offset++] = 0xff;              // reserved(6) | lengthSizeMinusOne(3)
        description[offset++] = 0xe1;              // reserved(3) | numOfSequenceParameterSets(1)
        description[offset++] = (sps.length >> 8) & 0xff;
        description[offset++] = sps.length & 0xff;
        description.set(sps, offset);
        offset += sps.length;
        description[offset++] = 1;                 // numOfPictureParameterSets
        description[offset++] = (pps.length >> 8) & 0xff;
        description[offset++] = pps.length & 0xff;
        description.set(pps, offset);
        return description;
    }

    public getVideoDimensions(): { width: number; height: number } {
        return { width: this.currentWidth, height: this.currentHeight };
    }

    private createDecoder(): VideoDecoder | null {
        if (typeof VideoDecoder === 'undefined') return null;
        try {
            const decoder = new VideoDecoder({
                output: (frame: VideoFrame) => {
                    if (DEV_MODE) console.log(`[WebCodecsPlayer] FRAME decoded: codedWidth=${frame.codedWidth} codedHeight=${frame.codedHeight} pts=${frame.timestamp} format=${frame.format}`);
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
        this.parser.feed(data);
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
            if (DEV_MODE) console.log(`[WebCodecsPlayer] RENDER frame ${frame.codedWidth}x${frame.codedHeight} canvas=${canvas.width}x${canvas.height}`);
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
        this.spsReceived = false;
        this.ppsReceived = false;
        this.spsKey = '';
        this.configuredSpsKey = null;
        this.pendingReconfigure = false;
        this.spsCodec = FALLBACK_CODEC;
        this.currentWidth = FALLBACK_WIDTH;
        this.currentHeight = FALLBACK_HEIGHT;
        this.decodeCount = 0;
        this.decodeErrors = 0;
        this.pts = 0;
        this.onEncodedChunk = null;
        this.streamDump = [];
        this.streamDumpSize = 0;
    }

    getDiagnostics(): WebCodecsDiagnostics {
        return {
            configured: this.configured,
            configCodec: this.spsCodec,
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
