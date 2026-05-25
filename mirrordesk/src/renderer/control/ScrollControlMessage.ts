import { ControlMessage } from './ControlMessage';
import type Position from '../player/Position';

export class ScrollControlMessage extends ControlMessage {
    public position: Position;
    public hScroll: number;
    public vScroll: number;

    constructor(position: Position, hScroll: number, vScroll: number) {
        super(ControlMessage.TYPE_SCROLL);
        this.position = position;
        this.hScroll = hScroll;
        this.vScroll = vScroll;
    }

    public toBuffer(): ArrayBuffer {
        const buffer = new ArrayBuffer(21);
        const view = new DataView(buffer);
        let offset = 0;
        view.setUint8(offset, this.type); offset += 1;
        view.setUint32(offset, this.position.point.x); offset += 4;
        view.setUint32(offset, this.position.point.y); offset += 4;
        view.setUint16(offset, this.position.screenSize.width); offset += 2;
        view.setUint16(offset, this.position.screenSize.height); offset += 2;
        view.setInt32(offset, this.hScroll); offset += 4;
        view.setInt32(offset, this.vScroll);
        return buffer;
    }
}
