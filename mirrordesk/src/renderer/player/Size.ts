export default class Size {
    public width: number;
    public height: number;

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
    }

    public static copy(s: Size): Size {
        return new Size(s.width, s.height);
    }

    public equals(o?: Size | null): boolean {
        if (!o) return false;
        return this.width === o.width && this.height === o.height;
    }

    public toString(): string {
        return `Size{${this.width}, ${this.height}}`;
    }

    public intersect(o: Size): Size {
        return new Size(Math.min(this.width, o.width), Math.min(this.height, o.height));
    }
}
