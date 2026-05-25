export interface NalUnit {
    type: number;
    data: Uint8Array;
    startCodeLen: number;
    length: number;
}

export interface ParserStats {
    totalBytes: number;
    nalCounts: Record<number, number>;
    totalNals: number;
}

const NAL_TYPE_NAMES: Record<number, string> = {
    1: 'SLICE_NON_IDR',
    5: 'SLICE_IDR',
    6: 'SEI',
    7: 'SPS',
    8: 'PPS',
    9: 'AUD',
};

function nalTypeName(type: number): string {
    return NAL_TYPE_NAMES[type] || `UNKNOWN(${type})`;
}

export class StreamParser {
    private buffer = new Uint8Array(0);
    private readonly maxPreStartCode = 1024 * 1024;
    private readonly maxBufferSize = 10 * 1024 * 1024;
    private stats: ParserStats = {
        totalBytes: 0,
        nalCounts: {},
        totalNals: 0,
    };

    onNalUnit: ((nal: NalUnit) => void) | null = null;

    feed(data: Uint8Array): NalUnit[] {
        this.stats.totalBytes += data.length;

        const combined = new Uint8Array(this.buffer.length + data.length);
        combined.set(this.buffer);
        combined.set(data, this.buffer.length);
        this.buffer = combined;

        if (this.buffer.length < 4) return [];

        const positions = this.findAllStartCodes();

        if (positions.length === 0) {
            if (this.buffer.length > this.maxPreStartCode) {
                this.buffer = this.buffer.slice(-this.maxPreStartCode);
            }
            return [];
        }

        const firstPos = positions[0].pos;
        if (firstPos > 0) {
            this.buffer = this.buffer.slice(firstPos);
            for (const p of positions) p.pos -= firstPos;
        }

        const nals: NalUnit[] = [];

        for (let i = 0; i < positions.length - 1; i++) {
            const start = positions[i];
            const end = positions[i + 1];
            const nalData = this.buffer.slice(start.pos, end.pos);
            if (nalData.length <= start.len) continue;
            const nalType = nalData[start.len] & 0x1f;
            nals.push({
                type: nalType,
                data: nalData,
                startCodeLen: start.len,
                length: nalData.length,
            });
            this.stats.nalCounts[nalType] = (this.stats.nalCounts[nalType] || 0) + 1;
            this.stats.totalNals++;

            if (this.onNalUnit) {
                this.onNalUnit(nals[nals.length - 1]);
            }
        }

        this.buffer = this.buffer.slice(positions[positions.length - 1].pos);

        if (this.buffer.length > this.maxBufferSize) {
            this.buffer = this.buffer.slice(-this.maxBufferSize);
        }

        return nals;
    }

    private findAllStartCodes(): { pos: number; len: number }[] {
        const result: { pos: number; len: number }[] = [];
        let i = 0;
        while (i <= this.buffer.length - 3) {
            if (this.buffer[i] === 0 && this.buffer[i + 1] === 0 && this.buffer[i + 2] === 1) {
                if (i > 0 && this.buffer[i - 1] === 0) {
                    if (result.length === 0 || result[result.length - 1].pos !== i - 1) {
                        result.push({ pos: i - 1, len: 4 });
                    }
                } else {
                    result.push({ pos: i, len: 3 });
                }
                i += 3;
            } else {
                i++;
            }
        }
        return result;
    }

    getStats(): ParserStats {
        return { ...this.stats };
    }

    reset(): void {
        this.buffer = new Uint8Array(0);
        this.stats = { totalBytes: 0, nalCounts: {}, totalNals: 0 };
    }
}

function hexDump(data: Uint8Array, maxBytes: number = 16): string {
    const len = Math.min(data.length, maxBytes);
    const bytes: string[] = [];
    for (let i = 0; i < len; i++) {
        bytes.push(data[i].toString(16).padStart(2, '0'));
    }
    return bytes.join(' ');
}

export function logNal(nal: NalUnit): void {
    const name = nalTypeName(nal.type);
    const hex = hexDump(nal.data, 16);
    console.log(`[NAL] type=${nal.type}(${name}) size=${nal.length} scLen=${nal.startCodeLen} hex=[${hex}]`);
}

export { nalTypeName, hexDump };
