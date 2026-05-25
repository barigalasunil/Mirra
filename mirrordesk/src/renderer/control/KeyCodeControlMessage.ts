import { ControlMessage } from './ControlMessage';

export class KeyCodeControlMessage extends ControlMessage {
    public action: number;
    public keycode: number;
    public repeat: number;
    public metaState: number;

    constructor(action: number, keycode: number, repeat: number, metaState: number) {
        super(ControlMessage.TYPE_KEYCODE);
        this.action = action;
        this.keycode = keycode;
        this.repeat = repeat;
        this.metaState = metaState;
    }

    public toBuffer(): ArrayBuffer {
        const buffer = new ArrayBuffer(14);
        const view = new DataView(buffer);
        let offset = 0;
        view.setInt8(offset, this.type); offset += 1;
        view.setInt8(offset, this.action); offset += 1;
        view.setInt32(offset, this.keycode); offset += 4;
        view.setInt32(offset, this.repeat); offset += 4;
        view.setInt32(offset, this.metaState);
        return buffer;
    }
}
