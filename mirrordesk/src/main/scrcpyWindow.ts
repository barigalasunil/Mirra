import koffi from 'koffi';

const user32 = koffi.load('user32.dll');

koffi.struct('LPRECT', {
    left: 'long',
    top: 'long',
    right: 'long',
    bottom: 'long',
});

const FindWindowW = user32.func('uintptr __stdcall FindWindowW(const char *lpClassName, const char16_t *lpWindowName)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void* hWnd, LPRECT* lpRect)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(void* hWnd, void* hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(void* hWnd, int nCmdShow)');
const PostMessageW = user32.func('bool __stdcall PostMessageW(void* hWnd, uint Msg, void* wParam, void* lParam)');
const WNDENUMPROC = koffi.proto('bool __stdcall WNDENUMPROC(void* hwnd, void* lparam)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(WNDENUMPROC *lpEnumFunc, void *lParam)');
const GetWindowThreadProcessId = user32.func('uint __stdcall GetWindowThreadProcessId(void* hWnd, uint* lpdwProcessId)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void* hWnd)');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void* hWnd)');

const MIRROR_TITLE = 'Mirra Mirror';
const WM_CLOSE = 0x0010;
const SW_MINIMIZE = 6;
const SW_RESTORE = 9;
const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const HWND_TOP = 0;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;

export interface MirrorRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

let mirrorHwnd: number | null = null;
let currentRect: MirrorRect | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// iOS mirror tracking (UxPlay window titled "Mirra")
const IOS_MIRROR_TITLE = 'Mirra';
let iosMirrorHwnd: number | null = null;
let iosCurrentRect: MirrorRect | null = null;
let iosPollTimer: ReturnType<typeof setInterval> | null = null;

function findMirrorWindow(): number | null {
    try {
        const h = FindWindowW(null, MIRROR_TITLE);
        return h === 0 ? null : Number(h);
    } catch {
        return null;
    }
}

function refresh() {
    if (mirrorHwnd === null) {
        mirrorHwnd = findMirrorWindow();
        if (mirrorHwnd === null) return;
    }
    try {
        const buf = Buffer.alloc(16);
        if (GetWindowRect(mirrorHwnd, buf)) {
            currentRect = {
                left: buf.readInt32LE(0),
                top: buf.readInt32LE(4),
                right: buf.readInt32LE(8),
                bottom: buf.readInt32LE(12),
            };
        } else {
            mirrorHwnd = null;
        }
    } catch {
        mirrorHwnd = null;
    }
}

export function startTracking(onUpdate?: () => void): void {
    stopTracking();
    refresh();
    onUpdate?.();
    pollTimer = setInterval(() => {
        refresh();
        onUpdate?.();
    }, 300);
}

export function stopTracking(): void {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    mirrorHwnd = null;
    currentRect = null;
}

export function getMirrorRect(): MirrorRect | null {
    return currentRect;
}

export function refreshMirrorRect(): void {
    refresh();
}

export function minimizeMirror(): void {
    if (mirrorHwnd !== null) ShowWindow(mirrorHwnd, SW_MINIMIZE);
}

export function restoreMirror(): void {
    if (mirrorHwnd !== null) ShowWindow(mirrorHwnd, SW_RESTORE);
}

export function setMirrorTopmost(on: boolean): void {
    if (mirrorHwnd !== null) {
        SetWindowPos(mirrorHwnd, on ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    }
}

export function closeMirrorGracefully(): void {
    if (mirrorHwnd !== null) PostMessageW(mirrorHwnd, WM_CLOSE, 0, 0);
}

// Bring all visible top-level windows belonging to the given process to the
// front (restore if minimized). Returns the number of windows raised.
export function raiseProcessWindows(pid: number): number {
    if (!pid) return 0;
    let raised = 0;
    let enumerated = 0;
    const cb = koffi.register((hwnd: unknown): boolean => {
        try {
            enumerated++;
            const pidBuf = Buffer.alloc(4);
            GetWindowThreadProcessId(hwnd, pidBuf);
            if (pidBuf.readUInt32LE(0) !== pid) return true;
            if (!IsWindowVisible(hwnd)) return true;
            ShowWindow(hwnd, SW_RESTORE);
            SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            SetForegroundWindow(hwnd);
            raised++;
        } catch (e) {
            console.error('[raiseProcessWindows] callback error:', e);
        }
        return true;
    }, koffi.pointer(WNDENUMPROC));
    try {
        const result = EnumWindows(cb, null);
        console.log('[raiseProcessWindows] EnumWindows returned', result, '- enumerated', enumerated, 'windows, raised', raised, 'for pid', pid);
    } catch (e) {
        console.error('[raiseProcessWindows] EnumWindows exception:', e);
    } finally {
        koffi.unregister(cb);
    }
    return raised;
}

// ── iOS mirror rect tracking ────────────────────────────────────────────────
// UxPlay creates a GStreamer video window; -n Mirra sets the window title.

function findIosMirrorWindow(): number | null {
    try {
        const h = FindWindowW(null, IOS_MIRROR_TITLE);
        return h === 0 ? null : Number(h);
    } catch {
        return null;
    }
}

function refreshIos() {
    if (iosMirrorHwnd === null) {
        iosMirrorHwnd = findIosMirrorWindow();
        if (iosMirrorHwnd === null) return;
    }
    try {
        const buf = Buffer.alloc(16);
        if (GetWindowRect(iosMirrorHwnd, buf)) {
            iosCurrentRect = {
                left: buf.readInt32LE(0),
                top: buf.readInt32LE(4),
                right: buf.readInt32LE(8),
                bottom: buf.readInt32LE(12),
            };
        } else {
            iosMirrorHwnd = null;
        }
    } catch {
        iosMirrorHwnd = null;
    }
}

export function startIosTracking(onUpdate?: () => void): void {
    stopIosTracking();
    refreshIos();
    onUpdate?.();
    iosPollTimer = setInterval(() => {
        refreshIos();
        onUpdate?.();
    }, 300);
}

export function stopIosTracking(): void {
    if (iosPollTimer) {
        clearInterval(iosPollTimer);
        iosPollTimer = null;
    }
    iosMirrorHwnd = null;
    iosCurrentRect = null;
}

export function getIosMirrorRect(): MirrorRect | null {
    return iosCurrentRect;
}

export function refreshIosMirrorRect(): void {
    refreshIos();
}

// ── iOS mirror window resize ────────────────────────────────────────────────
// GStreamer creates the video window at its default size. This resizes it to
// match the iPhone's physical screen aspect ratio so the mirror looks correct.

const IPHONE_PRO = { w: 390, h: 844 };

export function resizeIosMirrorWindow(): boolean {
    if (iosMirrorHwnd === null) {
        iosMirrorHwnd = findIosMirrorWindow();
        if (iosMirrorHwnd === null) return false;
    }
    try {
        const { w, h } = IPHONE_PRO;
        const ok = SetWindowPos(iosMirrorHwnd, HWND_TOP, 0, 0, w, h, SWP_NOMOVE | SWP_NOACTIVATE);
        if (ok) {
            console.log('[ios-mirror] resized window to', w, 'x', h);
        }
        return ok;
    } catch (e) {
        console.error('[ios-mirror] resize failed:', e);
        return false;
    }
}
