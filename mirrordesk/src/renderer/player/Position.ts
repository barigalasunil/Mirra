import type Point from './Point';
import type Size from './Size';

export default class Position {
    public point: Point;
    public screenSize: Size;

    constructor(point: Point, screenSize: Size) {
        this.point = point;
        this.screenSize = screenSize;
    }

    public toString(): string {
        return `Position{${this.point}, ${this.screenSize}}`;
    }
}
