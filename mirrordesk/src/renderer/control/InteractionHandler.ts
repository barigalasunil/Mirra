import { BasePlayer } from '../player/BasePlayer';
import { ControlMessage } from './ControlMessage';
import { TouchControlMessage } from './TouchControlMessage';
import { ScrollControlMessage } from './ScrollControlMessage';
import Position from '../player/Position';
import Point from '../player/Point';
import Size from '../player/Size';
import type ScreenInfo from '../player/ScreenInfo';

const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_MOVE = 2;
const BUTTON_PRIMARY = 1;

function buildTouchOnClient(clientX: number, clientY: number, screenInfo: ScreenInfo, target: HTMLElement) {
    const { width, height } = screenInfo.videoSize;
    const rect = target.getBoundingClientRect();
    let touchX = clientX - rect.left;
    let touchY = clientY - rect.top;
    let invalid = false;

    if (touchX < 0 || touchX > rect.width || touchY < 0 || touchY > rect.height) {
        invalid = true;
    }

    // Handle aspect ratio scaling
    const eps = 1e5;
    const ratio = width / height;
    const shouldBe = Math.round(eps * ratio);
    const haveNow = Math.round((eps * rect.width) / rect.height);

    if (shouldBe > haveNow) {
        const realHeight = Math.ceil(rect.width / ratio);
        const top = (rect.height - realHeight) / 2;
        if (touchY < top || touchY > top + realHeight) invalid = true;
        touchY -= top;
    } else if (shouldBe < haveNow) {
        const realWidth = Math.ceil(rect.height * ratio);
        const left = (rect.width - realWidth) / 2;
        if (touchX < left || touchX > left + realWidth) invalid = true;
        touchX -= left;
    }

    const x = (touchX * width) / rect.width;
    const y = (touchY * height) / rect.height;

    if (x < 0 || y < 0 || x > width || y > height) invalid = true;

    const size = new Size(width, height);
    const point = new Point(x, y);
    const position = new Position(point, size);
    return { position, invalid };
}

export class InteractionHandler {
    private storedPointers: Map<number, TouchControlMessage> = new Map();
    private lastScrollTime = 0;
    private tag: HTMLCanvasElement;
    private player: BasePlayer;
    private onControlMessage: (msg: ControlMessage) => void;

    constructor(player: BasePlayer, onControlMessage: (msg: ControlMessage) => void) {
        this.player = player;
        this.onControlMessage = onControlMessage;
        this.tag = player.getTouchableElement();
        this.setupListeners();
    }

    private setupListeners(): void {
        // Mouse events
        this.tag.addEventListener('mousedown', this.onMouseDown);
        this.tag.addEventListener('mouseup', this.onMouseUp);
        this.tag.addEventListener('mousemove', this.onMouseMove);
        this.tag.addEventListener('wheel', this.onWheel, { passive: false });

        // Touch events
        this.tag.addEventListener('touchstart', this.onTouchStart, { passive: false });
        this.tag.addEventListener('touchend', this.onTouchEnd, { passive: false });
        this.tag.addEventListener('touchmove', this.onTouchMove, { passive: false });

        // Mouse leave - release all pointers
        this.tag.addEventListener('mouseleave', this.onMouseLeave);
    }

    public release(): void {
        this.tag.removeEventListener('mousedown', this.onMouseDown);
        this.tag.removeEventListener('mouseup', this.onMouseUp);
        this.tag.removeEventListener('mousemove', this.onMouseMove);
        this.tag.removeEventListener('wheel', this.onWheel);
        this.tag.removeEventListener('touchstart', this.onTouchStart);
        this.tag.removeEventListener('touchend', this.onTouchEnd);
        this.tag.removeEventListener('touchmove', this.onTouchMove);
        this.tag.removeEventListener('mouseleave', this.onMouseLeave);
        this.storedPointers.clear();
    }

    private getScreenInfo(): ScreenInfo | null {
        return this.player.getScreenInfo();
    }

    private sendTouch(action: number, pointerId: number, clientX: number, clientY: number, pressure: number): void {
        const si = this.getScreenInfo();
        if (!si) return;
        const touch = buildTouchOnClient(clientX, clientY, si, this.tag);
        if (!touch || touch.invalid) return;

        const msg = new TouchControlMessage(action, pointerId, touch.position, pressure, BUTTON_PRIMARY);

        // Validate message sequence
        if (action === ACTION_UP) {
            this.storedPointers.delete(pointerId);
        } else if (action === ACTION_DOWN) {
            this.storedPointers.set(pointerId, msg);
        } else if (action === ACTION_MOVE) {
            this.storedPointers.set(pointerId, msg);
        }

        this.onControlMessage(msg);
    }

    private sendScroll(clientX: number, clientY: number, deltaX: number, deltaY: number): void {
        const now = Date.now();
        if (now - this.lastScrollTime < 30) return;
        this.lastScrollTime = now;

        const si = this.getScreenInfo();
        if (!si) return;
        const touch = buildTouchOnClient(clientX, clientY, si, this.tag);
        if (!touch || touch.invalid) return;

        const hScroll = deltaX > 0 ? -1 : deltaX < 0 ? 1 : 0;
        const vScroll = deltaY > 0 ? -1 : deltaY < 0 ? 1 : 0;

        const msg = new ScrollControlMessage(touch.position, hScroll, vScroll);
        this.onControlMessage(msg);
    }

    private onMouseDown = (e: MouseEvent): void => {
        e.preventDefault();
        this.sendTouch(ACTION_DOWN, 0, e.clientX, e.clientY, 1);
    };

    private onMouseUp = (e: MouseEvent): void => {
        e.preventDefault();
        this.sendTouch(ACTION_UP, 0, e.clientX, e.clientY, 0);
    };

    private onMouseMove = (e: MouseEvent): void => {
        if (e.buttons === 0) return;
        e.preventDefault();
        this.sendTouch(ACTION_MOVE, 0, e.clientX, e.clientY, 1);
    };

    private onMouseLeave = (): void => {
        // Release all stored pointers
        this.storedPointers.forEach((msg) => {
            const up = new TouchControlMessage(ACTION_UP, msg.pointerId, msg.position, 0, msg.buttons);
            this.onControlMessage(up);
        });
        this.storedPointers.clear();
    };

    private onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        this.sendScroll(e.clientX, e.clientY, e.deltaX, e.deltaY);
    };

    private touchToPointerId = 0;
    private touchMap: Map<number, number> = new Map(); // touch.identifier -> pointerId

    private getPointerId(identifier: number): number {
        if (this.touchMap.has(identifier)) {
            return this.touchMap.get(identifier)!;
        }
        const pointerId = this.touchToPointerId++;
        this.touchMap.set(identifier, pointerId);
        return pointerId;
    }

    private onTouchStart = (e: TouchEvent): void => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            const pointerId = this.getPointerId(touch.identifier);
            const pressure = touch.force || 0.5;
            this.sendTouch(ACTION_DOWN, pointerId, touch.clientX, touch.clientY, pressure);
        }
    };

    private onTouchEnd = (e: TouchEvent): void => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            const pointerId = this.getPointerId(touch.identifier);
            this.touchMap.delete(touch.identifier);
            this.sendTouch(ACTION_UP, pointerId, touch.clientX, touch.clientY, 0);
        }
    };

    private onTouchMove = (e: TouchEvent): void => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            const pointerId = this.getPointerId(touch.identifier);
            const pressure = touch.force || 0.5;
            this.sendTouch(ACTION_MOVE, pointerId, touch.clientX, touch.clientY, pressure);
        }
    };
}
