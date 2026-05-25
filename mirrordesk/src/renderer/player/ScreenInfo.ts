import type Rect from './Rect';
import type Size from './Size';

export default class ScreenInfo {
    public contentRect: Rect;
    public videoSize: Size;
    public deviceRotation: number;

    constructor(contentRect: Rect, videoSize: Size, deviceRotation: number) {
        this.contentRect = contentRect;
        this.videoSize = videoSize;
        this.deviceRotation = deviceRotation;
    }

    public equals(o?: ScreenInfo | null): boolean {
        if (!o) return false;
        return (
            this.contentRect.equals(o.contentRect) &&
            this.videoSize.equals(o.videoSize) &&
            this.deviceRotation === o.deviceRotation
        );
    }

    public toString(): string {
        return `ScreenInfo{contentRect=${this.contentRect}, videoSize=${this.videoSize}, deviceRotation=${this.deviceRotation}`;
    }
}
