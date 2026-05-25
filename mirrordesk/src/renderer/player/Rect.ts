export default class Rect {
    public left: number;
    public top: number;
    public right: number;
    public bottom: number;

    constructor(left: number, top: number, right: number, bottom: number) {
        this.left = left;
        this.top = top;
        this.right = right;
        this.bottom = bottom;
    }

    public equals(o?: Rect | null): boolean {
        if (!o) return false;
        return this.left === o.left && this.top === o.top && this.right === o.right && this.bottom === o.bottom;
    }

    public toString(): string {
        return `Rect{${this.left}, ${this.top}, ${this.right}, ${this.bottom}}`;
    }
}
