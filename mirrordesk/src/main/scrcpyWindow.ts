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
    const cb = koffi.register((hwnd: unknown): boolean => {
        try {
            const pidBuf = Buffer.alloc(4);
            GetWindowThreadProcessId(hwnd, pidBuf);
            if (pidBuf.readUInt32LE(0) !== pid) return true;
            if (!IsWindowVisible(hwnd)) return true;
            SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            ShowWindow(hwnd, SW_RESTORE);
            SetForegroundWindow(hwnd);
            raised++;
        } catch {
            // ignore individual window errors
        }
        return true;
    }, koffi.pointer(WNDENUMPROC));
    try {
        EnumWindows(cb, null);
    } catch {
        // EnumWindows failed — nothing we can do
    } finally {
        koffi.unregister(cb);
    }
    return raised;
}
