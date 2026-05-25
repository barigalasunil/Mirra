export class ControlMessage {
    public static readonly TYPE_KEYCODE = 0;
    public static readonly TYPE_TEXT = 1;
    public static readonly TYPE_TOUCH = 2;
    public static readonly TYPE_SCROLL = 3;
    public static readonly TYPE_BACK_OR_SCREEN_ON = 4;
    public static readonly TYPE_EXPAND_NOTIFICATION_PANEL = 5;
    public static readonly TYPE_EXPAND_SETTINGS_PANEL = 6;
    public static readonly TYPE_COLLAPSE_PANELS = 7;
    public static readonly TYPE_GET_CLIPBOARD = 8;
    public static readonly TYPE_SET_CLIPBOARD = 9;
    public static readonly TYPE_SET_SCREEN_POWER_MODE = 10;
    public static readonly TYPE_ROTATE_DEVICE = 11;
    public static readonly TYPE_CHANGE_STREAM_PARAMETERS = 101;
    public static readonly TYPE_PUSH_FILE = 102;

    public type: number;

    constructor(type: number) {
        this.type = type;
    }

    public toBuffer(): ArrayBuffer {
        throw new Error('Not implemented');
    }
}
