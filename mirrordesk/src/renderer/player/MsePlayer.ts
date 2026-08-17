import { BasePlayer } from './BasePlayer';
import VideoSettings from './VideoSettings';
import Size from './Size';
import ScreenInfo from './ScreenInfo';
import Rect from './Rect';
import { StreamParser } from './StreamParser';
import type { ParserStats } from './StreamParser';

const DEV_MODE = import.meta.env.DEV;

export interface MseDiagnostics {
    ready: boolean;
    videoWidth: number;
    videoHeight: number;
    parserStats: ParserStats;
    framesAppended: number;
    appendErrors: number;
}

export class MsePlayer extends BasePlayer {
    public static readonly playerFullName = 'MSE Player';
    public static readonly playerCodeName = 'mse';

    public static readonly preferredVideoSettings: VideoSettings = new VideoSettings({
        maxFps: 60,
        iFrameInterval: 10,
        bounds: new Size(720, 720),
    });

    public static isSupported(): boolean {
        return typeof MediaSource !== 'undefined'
            && typeof MediaSource.isTypeSupported === 'function';
    }

    public readonly supportsScreenshot = true;
    private mediaSource: MediaSource | null = null;
    private sourceBuffer: SourceBuffer | null = null;
    private videoElement: HTMLVideoElement | null;
    private initSegment: Uint8Array | null = null;
    private sps: Uint8Array | null = null;
    private pps: Uint8Array | null = null;
    private ready = false;
    private framesAppended = 0;
    private appendErrors = 0;

    private parser: StreamParser;
    private queuedNals: Uint8Array[] = [];

    /** Recording hook: fired for each VCL NAL (type 1/5) with its Annex-B start code. */
    public onSample: ((data: Uint8Array, isKey: boolean, timestamp: number) => void) | null = null;
    private sampleTimestamp = 0;
    private readonly sampleTimestampIncrement = 33_333; // ~30fps

    private outputMime = 'video/mp4; codecs="avc1.42E01E"';

    constructor(udid: string) {
        super(udid, MsePlayer.playerFullName);
        this.videoElement = document.createElement('video');
        this.videoElement.muted = true;
        this.videoElement.autoplay = true;
        this.videoElement.setAttribute('muted', 'muted');
        this.videoElement.setAttribute('autoplay', 'autoplay');
        this.videoElement.className = 'video-layer';
        this.videoElement.style.width = '100%';
        this.videoElement.style.height = '100%';
        this.videoElement.style.objectFit = 'contain';
        this.tag = this.videoElement;

        this.parser = new StreamParser();
        this.parser.onNalUnit = (nal) => this.onParsedNal(nal);
    }

    public getPreferredVideoSetting(): VideoSettings {
        return MsePlayer.preferredVideoSettings;
    }

    public getFitToScreenStatus(): boolean {
        return true;
    }

    public getImageDataURL(): string {
        const canvas = document.createElement('canvas');
        canvas.width = this.videoElement?.videoWidth || 0;
        canvas.height = this.videoElement?.videoHeight || 0;
        const ctx = canvas.getContext('2d');
        if (ctx && this.videoElement) {
            ctx.drawImage(this.videoElement, 0, 0);
        }
        return canvas.toDataURL();
    }

    private onParsedNal(nal: { type: number; data: Uint8Array }): void {
        const type = nal.type;
        const body = nal.data.subarray(nal.data.length > 4 && nal.data[3] === 1 ? 4 : 3);

        if (type === 7) {
            // `body` still contains the NAL header byte; strip it so the stored
            // SPS starts at profile_idc (required for MIME + avcC).
            this.sps = body.subarray(1);
            if (DEV_MODE) console.log(`[MsePlayer] SPS (${this.sps.length} bytes): ${this.hex(this.sps, 8)}`);
            this.updateMimeFromSps(this.sps);
        } else if (type === 8) {
            this.pps = body.subarray(1);
            if (DEV_MODE) console.log(`[MsePlayer] PPS (${this.pps.length} bytes): ${this.hex(this.pps, 8)}`);
        } else if (type === 5 || type === 1) {
            if (this.onSample) {
                const timestamp = this.sampleTimestamp;
                this.sampleTimestamp += this.sampleTimestampIncrement;
                this.onSample(nal.data, type === 5, timestamp);
            }
            if (this.sps && this.pps && !this.ready) {
                this.createInitAndSetup();
            }
            if (this.ready) {
                this.appendWithStartCode(nal.data);
            } else {
                this.queuedNals.push(nal.data);
            }
        }
    }

    private updateMimeFromSps(sps: Uint8Array): void {
        if (sps.length < 4) return;
        const profile = sps[0].toString(16).padStart(2, '0').toUpperCase();
        const constraint = sps[1].toString(16).padStart(2, '0').toUpperCase();
        const level = sps[2].toString(16).padStart(2, '0').toUpperCase();
        this.outputMime = `video/mp4; codecs="avc1.${profile}${constraint}${level}"`;
        console.log(`[MsePlayer] MIME: ${this.outputMime}`);

        if (typeof MediaSource !== 'undefined' && !MediaSource.isTypeSupported(this.outputMime)) {
            console.warn(`[MsePlayer] MIME not supported: ${this.outputMime}, trying fallback avc1.42E01E`);
            this.outputMime = 'video/mp4; codecs="avc1.42E01E"';
        }
    }

    private createInitAndSetup(): void {
        this.initSegment = this.createInitSegment();
        if (this.initSegment) {
            this.setupMediaSource();
        }
    }

    public pushFrame(frame: Uint8Array): void {
        super.pushFrame(frame);
        if (!frame || frame.length === 0) return;
        this.parser.feed(frame);
    }

    private createInitSegment(): Uint8Array | null {
        if (!this.sps || !this.pps) return null;

        const spsData = this.sps;
        const ppsData = this.pps;

        const ftyp = new Uint8Array([
            0x00, 0x00, 0x00, 0x18,
            0x66, 0x74, 0x79, 0x70,
            0x69, 0x73, 0x6f, 0x6d,
            0x00, 0x00, 0x02, 0x00,
            0x69, 0x73, 0x6f, 0x6d,
            0x69, 0x73, 0x6f, 0x32,
            0x61, 0x76, 0x63, 0x31,
        ]);

        const profile = spsData[0];
        const compatibility = spsData[1];
        const level = spsData[2];

        const avcCData = new Uint8Array([
            0x01,
            profile,
            compatibility,
            level,
            0xff,
            0xe1,
            (spsData.length >> 8) & 0xff,
            spsData.length & 0xff,
            ...spsData,
            0x01,
            (ppsData.length >> 8) & 0xff,
            ppsData.length & 0xff,
            ...ppsData,
        ]);

        const stsdBody = new Uint8Array(78);
        stsdBody[0] = 0x00; stsdBody[1] = 0x00; stsdBody[2] = 0x00; stsdBody[3] = 0x00;
        stsdBody[4] = 0x00; stsdBody[5] = 0x00; stsdBody[6] = 0x00; stsdBody[7] = 0x01;
        stsdBody[8] = 0x00; stsdBody[9] = 0x00; stsdBody[10] = 0x00; stsdBody[11] = 0x00;
        stsdBody[12] = 0x61; stsdBody[13] = 0x76; stsdBody[14] = 0x63; stsdBody[15] = 0x31;
        stsdBody[16] = 0x00; stsdBody[17] = 0x00; stsdBody[18] = 0x00; stsdBody[19] = 0x00;
        stsdBody[20] = 0x00; stsdBody[21] = 0x00; stsdBody[22] = 0x00; stsdBody[23] = 0x00;
        stsdBody[24] = 0x00; stsdBody[25] = 0x00; stsdBody[26] = 0x00; stsdBody[27] = 0x00;
        stsdBody[28] = 0x00; stsdBody[29] = 0x00; stsdBody[30] = 0x00; stsdBody[31] = 0x01;
        stsdBody[32] = 0x00; stsdBody[33] = 0x00; stsdBody[34] = 0x00; stsdBody[35] = 0x00;
        stsdBody[36] = 0x00; stsdBody[37] = 0x00; stsdBody[38] = 0x00; stsdBody[39] = 0x00;
        stsdBody[40] = 0x00; stsdBody[41] = 0x00; stsdBody[42] = 0x00; stsdBody[43] = 0x00;
        stsdBody[44] = 0x00; stsdBody[45] = 0x00; stsdBody[46] = 0x00; stsdBody[47] = 0x00;
        stsdBody[48] = 0x00; stsdBody[49] = 0x00; stsdBody[50] = 0x00; stsdBody[51] = 0x00;
        stsdBody[52] = 0x00; stsdBody[53] = 0x00; stsdBody[54] = 0x00; stsdBody[55] = 0x00;
        stsdBody[56] = 0x00; stsdBody[57] = 0x00; stsdBody[58] = 0x00; stsdBody[59] = 0x00;
        stsdBody[60] = 0x00; stsdBody[61] = 0x00; stsdBody[62] = 0x00; stsdBody[63] = 0x00;
        stsdBody[64] = 0x00; stsdBody[65] = 0x00; stsdBody[66] = 0x00; stsdBody[67] = 0x00;
        stsdBody[68] = 0x00; stsdBody[69] = 0x00; stsdBody[70] = 0x00; stsdBody[71] = 0x00;
        stsdBody[72] = 0x00; stsdBody[73] = 0x00; stsdBody[74] = 0x00; stsdBody[75] = 0x00;
        stsdBody[76] = 0x00; stsdBody[77] = 0x00;

        const stsdSection = new Uint8Array(stsdBody.length + avcCData.length);
        stsdSection.set(stsdBody, 0);
        stsdSection.set(avcCData, stsdBody.length);

        const moovSize = 40 + stsdSection.length;
        const moov = new Uint8Array(moovSize + 8);
        let off = 0;
        const w32 = (v: number) => {
            moov[off++] = (v >> 24) & 0xff;
            moov[off++] = (v >> 16) & 0xff;
            moov[off++] = (v >> 8) & 0xff;
            moov[off++] = v & 0xff;
        };
        w32(moovSize + 8);
        moov[off++] = 0x6d; moov[off++] = 0x6f; moov[off++] = 0x6f; moov[off++] = 0x76;
        w32(8);
        moov[off++] = 0x6d; moov[off++] = 0x76; moov[off++] = 0x68; moov[off++] = 0x64;
        w32(8);
        moov[off++] = 0x74; moov[off++] = 0x72; moov[off++] = 0x61; moov[off++] = 0x6b;
        w32(stsdSection.length + 8);
        moov.set(stsdSection, off);

        const init = new Uint8Array(ftyp.length + moovSize + 8);
        init.set(ftyp, 0);
        init.set(moov, ftyp.length);
        return init;
    }

    private setupMediaSource(): void {
        if (!this.videoElement) return;
        this.mediaSource = new MediaSource();
        this.mediaSource.onsourceopen = () => {
            if (!this.mediaSource) return;
            try {
                this.sourceBuffer = this.mediaSource.addSourceBuffer(this.outputMime);
                if (this.initSegment) {
                    this.sourceBuffer.appendBuffer(this.initSegment.buffer as ArrayBuffer);
                    this.sourceBuffer.onupdateend = () => {
                        this.sourceBuffer!.onupdateend = null;
                        this.ready = true;
                        console.log(`[MsePlayer] MediaSource ready, init segment appended`);
                        for (const nal of this.queuedNals) {
                            this.appendWithStartCode(nal);
                        }
                        this.queuedNals = [];
                        if (this.videoElement) {
                            this.videoElement.play().catch(() => {});
                        }
                        this.detectVideoSize();
                    };
                }
            } catch (e) {
                console.error(`[MsePlayer] SourceBuffer error:`, e);
            }
        };
        this.mediaSource.onsourceended = () => {
            console.log(`[MsePlayer] MediaSource ended`);
        };
        this.mediaSource.onsourceclose = () => {
            console.log(`[MsePlayer] MediaSource closed`);
        };

        this.videoElement.src = URL.createObjectURL(this.mediaSource);
    }

    private detectVideoSize(): void {
        if (!this.videoElement) return;
        const check = () => {
            if (this.videoElement && this.videoElement.videoWidth > 0) {
                const { videoWidth, videoHeight } = this.videoElement;
                console.log(`[MsePlayer] Video size detected: ${videoWidth}x${videoHeight}`);
                const screenInfo = new ScreenInfo(
                    new Rect(0, 0, videoWidth, videoHeight),
                    new Size(videoWidth, videoHeight),
                    0,
                );
                this.setScreenInfo(screenInfo);
            } else {
                setTimeout(check, 100);
            }
        };
        setTimeout(check, 100);
    }

    private appendWithStartCode(data: Uint8Array): void {
        if (!this.sourceBuffer || this.sourceBuffer.updating) return;
        try {
            const avcc = this.nalToAvcc(data);
            this.sourceBuffer.appendBuffer(avcc.buffer as ArrayBuffer);
            this.framesAppended++;
        } catch (e: any) {
            this.appendErrors++;
            console.error(`[MsePlayer] appendBuffer error #${this.appendErrors}: ${e.message}`);
        }
    }

    private nalToAvcc(nal: Uint8Array): Uint8Array {
        const startCodeLen = (nal.length >= 4 && nal[0] === 0 && nal[1] === 0 && nal[2] === 0 && nal[3] === 1)
            ? 4
            : (nal.length >= 3 && nal[0] === 0 && nal[1] === 0 && nal[2] === 1)
                ? 3
                : 0;
        const body = startCodeLen > 0 ? nal.subarray(startCodeLen) : nal;
        const data = new Uint8Array(4 + body.length);
        data[0] = (body.length >> 24) & 0xff;
        data[1] = (body.length >> 16) & 0xff;
        data[2] = (body.length >> 8) & 0xff;
        data[3] = body.length & 0xff;
        data.set(body, 4);
        return data;
    }

    public play(): void {
        super.play();
        if (this.videoElement && this.ready) {
            this.videoElement.play().catch(() => {});
        }
    }

    public pause(): void {
        super.pause();
        if (this.videoElement) {
            this.videoElement.pause();
        }
    }

    public stop(): void {
        super.stop();
        if (this.videoElement) {
            this.videoElement.pause();
            this.videoElement.removeAttribute('src');
            this.videoElement.load();
        }
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.ready = false;
        this.queuedNals = [];
        this.sps = null;
        this.pps = null;
        this.initSegment = null;
        this.framesAppended = 0;
        this.appendErrors = 0;
        this.sampleTimestamp = 0;
        this.onSample = null;
        this.parser.reset();
    }

    getDiagnostics(): MseDiagnostics {
        return {
            ready: this.ready,
            videoWidth: this.videoElement?.videoWidth || 0,
            videoHeight: this.videoElement?.videoHeight || 0,
            parserStats: this.parser.getStats(),
            framesAppended: this.framesAppended,
            appendErrors: this.appendErrors,
        };
    }

    private hex(data: Uint8Array, max: number): string {
        const len = Math.min(data.length, max);
        const parts: string[] = [];
        for (let i = 0; i < len; i++) {
            parts.push(data[i].toString(16).padStart(2, '0'));
        }
        return parts.join(' ');
    }
}
