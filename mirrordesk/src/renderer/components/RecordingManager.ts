import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

const DEFAULT_FRAME_DURATION_US = 33_333; // ~30fps fallback

/**
 * Convert a raw H.264 Annex-B byte sequence (NAL units with 3/4-byte start codes,
 * possibly including SPS/PPS/SEI) into MP4 sample data: length-prefixed (4-byte BE)
 * VCL NAL units only. SPS/PPS live in the avcC description, not in the samples.
 */
export function annexBToAvcc(data: Uint8Array): Uint8Array {
    const len = data.length;
    if (len < 4) return new Uint8Array(0);

    const nals: Uint8Array[] = [];
    // Find the first start code. A start code ends with a 0x01 byte preceded by at
    // least two 0x00 bytes.
    let k = 2;
    while (k < len) {
        if (data[k] === 1 && data[k - 1] === 0 && data[k - 2] === 0) break;
        k++;
    }
    while (k < len) {
        // Position of the 1-byte marks the END of the start code; the code itself is
        // 3 bytes (k-2..k) or 4 bytes (k-3..k) when the byte before is also 0.
        const bodyStart = k + 1;
        const type = data[bodyStart] & 0x1f;
        // Find the next start code end position.
        let k2 = bodyStart + 1;
        while (k2 < len) {
            if (data[k2] === 1 && data[k2 - 1] === 0 && data[k2 - 2] === 0) break;
            k2++;
        }
        if (type === 1 || type === 5) {
            const bodyEnd = k2 >= len ? len : (k2 >= 3 && data[k2 - 3] === 0) ? k2 - 3 : k2 - 2;
            nals.push(data.slice(bodyStart, bodyEnd));
        }
        k = k2;
    }

    if (nals.length === 0) return new Uint8Array(0);
    const total = nals.reduce((s, n) => s + 4 + n.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const nal of nals) {
        out[offset] = (nal.length >> 24) & 0xff;
        out[offset + 1] = (nal.length >> 16) & 0xff;
        out[offset + 2] = (nal.length >> 8) & 0xff;
        out[offset + 3] = nal.length & 0xff;
        out.set(nal, offset + 4);
        offset += 4 + nal.length;
    }
    return out;
}

export class RecordingManager {
    private muxer: Muxer<ArrayBufferTarget> | null = null;
    private started = false;
    private lastTimestamp: number | null = null;

    public start(width: number, height: number): void {
        this.started = false;
        this.lastTimestamp = null;
        this.muxer = new Muxer({
            target: new ArrayBufferTarget(),
            video: { codec: 'avc', width, height },
            fastStart: 'in-memory',
            firstTimestampBehavior: 'offset',
        });
    }

    public isActive(): boolean {
        return this.muxer !== null;
    }

    /**
     * Feed an encoded video chunk (Annex-B access unit) from the WebCodecs player.
     */
    public addVideoChunk(
        chunk: EncodedVideoChunk,
        isKey: boolean,
        description: Uint8Array | null,
    ): void {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.addRawAccessUnit(data, isKey, chunk.timestamp, chunk.duration ?? undefined, description);
    }

    /**
     * Feed a single raw VCL NAL (Annex-B with start code) from the MSE player.
     */
    public addRawNal(data: Uint8Array, isKey: boolean, timestamp: number): void {
        this.addRawAccessUnit(data, isKey, timestamp, undefined, null);
    }

    private addRawAccessUnit(
        data: Uint8Array,
        isKey: boolean,
        timestamp: number,
        duration: number | undefined,
        description: Uint8Array | null,
    ): void {
        if (!this.muxer) return;
        if (!this.started) {
            // MP4 playback requires the first sample to be a key frame.
            if (!isKey) return;
            this.started = true;
        }
        const sample = annexBToAvcc(data);
        if (sample.length === 0) return;

        const dur = duration ?? (this.lastTimestamp !== null ? timestamp - this.lastTimestamp : DEFAULT_FRAME_DURATION_US);
        this.lastTimestamp = timestamp;

        const meta = description && description.length > 0
            ? { decoderConfig: { codec: 'avc', description } }
            : undefined;
        this.muxer.addVideoChunkRaw(sample, isKey ? 'key' : 'delta', timestamp, dur, meta);
    }

    public stop(): ArrayBuffer | null {
        if (!this.muxer) return null;
        this.muxer.finalize();
        const result = this.muxer.target.buffer;
        this.muxer = null;
        this.started = false;
        this.lastTimestamp = null;
        return result;
    }
}
