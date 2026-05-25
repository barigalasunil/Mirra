import { BasePlayer } from './BasePlayer';
import VideoSettings from './VideoSettings';
import Size from './Size';
import ScreenInfo from './ScreenInfo';
import Rect from './Rect';

const MSE_MIME = 'video/mp4; codecs="avc1.42E01E"';

export class MsePlayer extends BasePlayer {
    public static readonly playerFullName = 'MSE Player';
    public static readonly playerCodeName = 'mse';

    public static readonly preferredVideoSettings: VideoSettings = new VideoSettings({
        maxFps: 60,
        iFrameInterval: 10,
        bounds: new Size(720, 720),
    });

    public static isSupported(): boolean {
        return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(MSE_MIME);
    }

    public readonly supportsScreenshot = true;
    private mediaSource: MediaSource | null = null;
    private sourceBuffer: SourceBuffer | null = null;
    private videoElement: HTMLVideoElement | null;
    private initSegment: Uint8Array | null = null;
    private sps: Uint8Array | null = null;
    private pps: Uint8Array | null = null;
    private queuedFrames: Uint8Array[] = [];
    private ready = false;

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

        const profile = spsData[1];
        const compatibility = spsData[2];
        const level = spsData[3];

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

        const stsdBody = new Uint8Array([
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x01,
            0x00, 0x00, 0x00, 0x00,
            0x61, 0x76, 0x63, 0x31,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x01,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00,
        ]);

        const stsd = new Uint8Array(stsdBody.length + avcCData.length);
        stsd.set(stsdBody, 0);
        stsd.set(avcCData, stsdBody.length);

        const moovSize = 40 + stsd.length;
        const moov = new Uint8Array(moovSize + 8);
        let off = 0;
        const write32 = (v: number) => {
            moov[off++] = (v >> 24) & 0xff;
            moov[off++] = (v >> 16) & 0xff;
            moov[off++] = (v >> 8) & 0xff;
            moov[off++] = v & 0xff;
        };
        write32(moovSize + 8);
        moov[off++] = 0x6d; moov[off++] = 0x6f; moov[off++] = 0x6f; moov[off++] = 0x76;
        write32(8);
        moov[off++] = 0x6d; moov[off++] = 0x76; moov[off++] = 0x68; moov[off++] = 0x64;
        write32(8);
        moov[off++] = 0x74; moov[off++] = 0x72; moov[off++] = 0x61; moov[off++] = 0x6b;
        write32(stsd.length + 8);
        moov.set(stsd, off);

        const init = new Uint8Array(ftyp.length + moovSize + 8);
        init.set(ftyp, 0);
        init.set(moov, ftyp.length);
        return init;
    }

    public pushFrame(frame: Uint8Array): void {
        super.pushFrame(frame);

        if (!frame || frame.length < 4) return;

        const type = frame[0] & 0x1f;

        if (type === 7) {
            this.sps = frame;
            console.log(`[MsePlayer] SPS captured (${this.sps.length} bytes)`);
            return;
        }
        if (type === 8) {
            this.pps = frame;
            console.log(`[MsePlayer] PPS captured (${this.pps.length} bytes)`);
            return;
        }

        if (this.sps && this.pps && !this.ready) {
            this.initSegment = this.createInitSegment();
            if (this.initSegment) {
                this.setupMediaSource();
            }
            return;
        }

        if (this.ready) {
            this.appendFrame(frame);
        } else {
            this.queuedFrames.push(frame);
        }
    }

    private setupMediaSource(): void {
        if (!this.videoElement) return;
        this.mediaSource = new MediaSource();
        this.mediaSource.onsourceopen = () => {
            if (!this.mediaSource) return;
            try {
                this.sourceBuffer = this.mediaSource.addSourceBuffer(MSE_MIME);
                if (this.initSegment) {
                    this.sourceBuffer.appendBuffer(this.initSegment.buffer as ArrayBuffer);
                    this.sourceBuffer.onupdateend = () => {
                        this.sourceBuffer!.onupdateend = null;
                        this.ready = true;
                        for (const frame of this.queuedFrames) {
                            this.appendFrame(frame);
                        }
                        this.queuedFrames = [];
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

        this.videoElement.src = URL.createObjectURL(this.mediaSource);
    }

    private detectVideoSize(): void {
        if (!this.videoElement) return;
        const check = () => {
            if (this.videoElement && this.videoElement.videoWidth > 0) {
                const { videoWidth, videoHeight } = this.videoElement;
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

    private nalToAvcc(nal: Uint8Array): Uint8Array {
        const data = new Uint8Array(4 + nal.length);
        data[0] = (nal.length >> 24) & 0xff;
        data[1] = (nal.length >> 16) & 0xff;
        data[2] = (nal.length >> 8) & 0xff;
        data[3] = nal.length & 0xff;
        data.set(nal, 4);
        return data;
    }

    private appendFrame(frame: Uint8Array): void {
        if (!this.sourceBuffer || this.sourceBuffer.updating) return;
        try {
            const avcc = this.nalToAvcc(frame);
            this.sourceBuffer.appendBuffer(avcc.buffer as ArrayBuffer);
        } catch (e) {
            console.error(`[MsePlayer] appendBuffer error:`, e);
        }
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
        this.queuedFrames = [];
        this.sps = null;
        this.pps = null;
        this.initSegment = null;
    }
}
