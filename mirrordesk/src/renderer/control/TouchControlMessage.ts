import { ControlMessage } from './ControlMessage';
import type Position from '../player/Position';

const MAX_PRESSURE = 0xffff;

export class TouchControlMessage extends ControlMessage {
    public action: number;
    public pointerId: number;
    public position: Position;
    public pressure: number;
    public buttons: number;

    constructor(action: number, pointerId: number, position: Position, pressure: number, buttons: number) {
        super(ControlMessage.TYPE_TOUCH);
        this.action = action;
        this.pointerId = pointerId;
        this.position = position;
        this.pressure = pressure;
        this.buttons = buttons;
    }

    public toBuffer(): ArrayBuffer {
        const buffer = new ArrayBuffer(29);
        const view = new DataView(buffer);
        let offset = 0;
        view.setUint8(offset, this.type); offset += 1;
        view.setUint8(offset, this.action); offset += 1;
        view.setUint32(offset, 0); offset += 4;
        view.setUint32(offset, this.pointerId); offset += 4;
        view.setUint32(offset, this.position.point.x); offset += 4;
        view.setUint32(offset, this.position.point.y); offset += 4;
        view.setUint16(offset, this.position.screenSize.width); offset += 2;
        view.setUint16(offset, this.position.screenSize.height); offset += 2;
        view.setUint16(offset, this.pressure * MAX_PRESSURE); offset += 2;
        view.setUint32(offset, this.buttons);
        return buffer;
    }
}
