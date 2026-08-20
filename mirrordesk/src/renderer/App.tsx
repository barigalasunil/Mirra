import { useEffect, useState, useRef, type CSSProperties } from 'react';
import { Play, Camera, Monitor, Sun, Moon, Zap, ZapOff, ScanLine, CircleStop, CheckCircle2, Circle, Square, X, Pin, PinOff, Info } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { AdbDevice, IosDevice, DeviceStatus } from '../shared/types';
function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

type DeviceEntry =
    | { kind: 'android'; id: string; name: string; model: string }
    | { kind: 'ios'; id: string; name: string; productType: string; iosVersion: string };

const electron = (window as any).electronAPI;

// Categorized console logger so DevTools' console filter box becomes useful:
// typing e.g. "recording" in the filter shows only recording-related logs.
const debugLog = (category: string, msg: string, data?: any) => {
    console.log(`%c[${category}]`, 'color:#378ADD;font-weight:bold', msg, data ?? '');
};

const isScreenshotPopup = typeof window !== 'undefined' && window.location.hash === '#screenshot-popup';

function App() {
    const [selectedDevice, setSelectedDevice] = useState<DeviceEntry | null>(null);
    const [status, setStatus] = useState<DeviceStatus | null>(null);
    const [driversMissing, setDriversMissing] = useState(false);
    const driversBannerDismissedRef = useRef(false);
    const mirrorStartTime = useRef<number>(0);
    const [isMirroring, setIsMirroring] = useState(false);
    const [keepAwake, setKeepAwake] = useState(false);
    const [quickScreenshotMode, setQuickScreenshotMode] = useState(false);
    const [isCapturingShot, setIsCapturingShot] = useState(false);
    const [isTogglingRecord, setIsTogglingRecord] = useState(false);
    const [isCapturingLongShot, setIsCapturingLongShot] = useState(false);
    const [toasts, setToasts] = useState<{ id: string; msg: string; type: 'success' | 'error' | 'info'; action?: { label: string; onClick: () => void } }[]>([]);
    const [isStarting, setIsStarting] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [recordStartTime, setRecordStartTime] = useState(0);
    const [recordElapsed, setRecordElapsed] = useState(0);
    const [alwaysOnTop, setAlwaysOnTop] = useState(false);
    const [theme, setTheme] = useState<'dark' | 'light'>('dark');
    const [isIosMirroring, setIsIosMirroring] = useState(false);
    const [isStartingIos, setIsStartingIos] = useState(false);
    const [iosConnectionStatus, setIosConnectionStatus] = useState<'waiting' | 'connected' | 'disconnected' | null>(null);
    const [sessionSeconds, setSessionSeconds] = useState(0);

    const addToast = (msg: string, type: 'success' | 'error' | 'info' = 'success', action?: { label: string; onClick: () => void }, duration = 6000) => {
        const id = Math.random().toString(36).substring(7);
        setToasts(prev => [...prev, { id, msg, type, action }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
    };

    useEffect(() => {
        initTheme();
        initAlwaysOnTop();
        initQuickScreenshot();
        pollDevices();
        const interval = setInterval(pollDevices, 3000);
        return () => clearInterval(interval);
    }, []);

    // Toasts pushed from main (e.g. quick-screenshot copied, popup copy actions)
    useEffect(() => {
        electron.onToast((data: { msg: string; type?: 'success' | 'error' | 'info' }) => {
            addToast(data.msg, data.type ?? 'success');
        });
        return () => electron.removeToast();
    }, []);

    useEffect(() => {
        let stoppedListener = (_data: { code: number }) => {
            const elapsed = Date.now() - mirrorStartTime.current;
            if (elapsed < 2000) {
                debugLog('mirror', 'ignoring early scrcpy exit, elapsed:', elapsed);
                return;
            }
            setIsMirroring(false);
            setIsRecording(false);
            setSessionSeconds(0);
            addToast('Mirror session ended', 'success');
        };
        electron.onScrcpyStopped(stoppedListener);

        let errorListener = (msg: string) => {
            addToast(msg, 'error');
            setIsMirroring(false);
            setSessionSeconds(0);
        };
        electron.onScrcpyError(errorListener);

        return () => {
            electron.removeScrcpyStopped();
            electron.removeScrcpyError();
        };
    }, []);

    useEffect(() => {
        if (!isMirroring && !isIosMirroring) return;
        const interval = setInterval(() => setSessionSeconds(s => s + 1), 1000);
        return () => clearInterval(interval);
    }, [isMirroring, isIosMirroring]);

    useEffect(() => {
        const savedListener = (filePath: string) => {
            const parts = filePath.split(/[\\/]/);
            addToast(`Saved: ${parts[parts.length - 1]}`, 'success');
        };
        electron.onRecordingSaved(savedListener);
        return () => electron.removeRecordingSaved();
    }, []);

    useEffect(() => {
        if (!isRecording) return;
        const interval = setInterval(() => {
            setRecordElapsed(Math.floor((Date.now() - recordStartTime) / 1000));
        }, 1000);
        return () => clearInterval(interval);
    }, [isRecording, recordStartTime]);

    useEffect(() => {
        if (!selectedDevice) {
            setStatus(null);
            return;
        }
        pollStatus();
        const interval = setInterval(pollStatus, 5000);
        return () => clearInterval(interval);
    }, [selectedDevice]);

    const initTheme = async () => {
        const storedTheme = await electron.storeGet('theme', 'dark');
        const saved = storedTheme === 'light' ? 'light' : 'dark';
        setTheme(saved);
        document.documentElement.classList.toggle('dark', saved === 'dark');
    };

    const initQuickScreenshot = async () => {
        const val = await electron.getQuickScreenshotMode();
        setQuickScreenshotMode(!!val);
    };

    const toggleQuickScreenshot = async () => {
        const next = !quickScreenshotMode;
        setQuickScreenshotMode(next);
        await electron.setQuickScreenshotMode(next);
        debugLog('ipc', 'quick screenshot mode:', next);
    };

    const initAlwaysOnTop = async () => {
        const val = await electron.getAlwaysOnTop();
        setAlwaysOnTop(!!val);
    };

    const toggleAlwaysOnTop = async () => {
        const newValue = !alwaysOnTop;
        setAlwaysOnTop(newValue);
        await electron.setAlwaysOnTop(newValue);
    };

    // Theme is owned by the main process (single source of truth); this
    // window just applies whatever value it broadcasts.
    useEffect(() => {
        electron.onThemeChanged((newTheme: string) => {
            const t = newTheme === 'light' ? 'light' : 'dark';
            setTheme(t);
            document.documentElement.classList.toggle('dark', t === 'dark');
        });
        return () => electron.removeThemeChanged();
    }, []);

    const handleThemeToggle = async () => {
        await electron.requestThemeToggle();
    };

    useEffect(() => {
        const startedListener = () => {
            setIsIosMirroring(true);
            setIosConnectionStatus('waiting');
        };
        electron.onIosMirrorStarted(startedListener);
        const stoppedListener = (code: number | null) => {
            setIsIosMirroring(false);
            setIosConnectionStatus(null);
            addToast('iOS mirroring stopped', 'success');
            debugLog('ios', 'uxplay exited, code', code);
        };
        electron.onIosMirrorStopped(stoppedListener);
        const errorListener = (detail: string) => {
            const bonjourRelated = /bonjour|mdns|dns-sd/i.test(detail);
            if (bonjourRelated) {
                addToast("iOS mirroring needs Apple's Bonjour service. Install iTunes or the Apple Devices app and try again.", 'error');
            } else {
                addToast(`iOS mirroring error: ${detail || 'unknown'}`, 'error');
            }
            setIsIosMirroring(false);
            setIosConnectionStatus(null);
        };
        electron.onIosMirrorError(errorListener);
        const instructionListener = (msg: string) => addToast(msg, 'info', undefined, 8000);
        electron.onIosMirrorInstruction(instructionListener);
        const readyListener = () => setIsIosMirroring(true);
        electron.onIosMirrorReady(readyListener);
        const clientConnectedListener = () => setIosConnectionStatus('connected');
        electron.onIosClientConnected(clientConnectedListener);
        const clientDisconnectedListener = () => setIosConnectionStatus('disconnected');
        electron.onIosClientDisconnected(clientDisconnectedListener);
        return () => {
            electron.removeIosMirrorStarted();
            electron.removeIosMirrorStopped();
            electron.removeIosMirrorError();
            electron.removeIosMirrorInstruction();
            electron.removeIosMirrorReady();
            electron.removeIosClientConnected();
            electron.removeIosClientDisconnected();
        };
    }, []);

    const pollDevices = async () => {
        const [androidDevs, iosResult] = await Promise.all([
            electron.adbDevices(),
            electron.iosDevices(),
        ]);
        setDriversMissing(!!iosResult?.driversMissing && !driversBannerDismissedRef.current);
        const all: DeviceEntry[] = [
            ...androidDevs.map((d: AdbDevice) => ({ kind: 'android' as const, id: d.id, name: d.model || d.id, model: d.model })),
            ...(iosResult?.devices ?? []).map((d: IosDevice) => ({ kind: 'ios' as const, id: d.udid, name: d.name, productType: d.productType, iosVersion: d.iosVersion })),
        ];
        if (all.length > 0) {
            setSelectedDevice(prev => prev && all.find(d => d.id === prev.id && d.kind === prev.kind) ? prev : all[0]);
        } else {
            setSelectedDevice(null);
        }
    };

    const pollStatus = async () => {
        if (!selectedDevice) return;
        if (selectedDevice.kind === 'ios') {
            setStatus(null);
            return;
        }
        const st = await electron.adbDeviceStatus(selectedDevice.id);
        setStatus(st);
    };

    const toggleMirror = async () => {
        if (!selectedDevice) return;
        if (isStarting) return;

        if (selectedDevice.kind === 'ios') {
            if (isStartingIos) return;
            if (isIosMirroring) {
                await electron.iosMirrorStop();
            } else {
                setIsStartingIos(true);
                setIsIosMirroring(true);
                try {
                    const res = await electron.iosMirrorStart();
                    if (!res?.success) {
                        setIsIosMirroring(false);
                        if (res?.reason === 'no_network') {
                            addToast('Connect PC to Wi-Fi first — AirPlay requires Wi-Fi', 'error');
                        } else if (res?.error === 'binary_missing') {
                            addToast("iOS mirroring isn't set up on this computer. Install the UxPlay helper and try again.", 'error');
                        } else if (res?.error === 'firewall') {
                            addToast(res?.detail || 'Windows Firewall is blocking AirPlay. Run Mirra as Administrator once to fix this.', 'error', undefined, 12000);
                        } else if (res?.reason === 'already_running') {
                            setIsIosMirroring(true);
                        } else {
                            addToast('Failed to start iOS mirroring', 'error');
                        }
                    }
                } finally {
                    setIsStartingIos(false);
                }
            }
            return;
        }

        if (isMirroring) {
            if (isRecording) {
                await handleRecord();
            } else {
                await electron.scrcpyStop();
                setIsMirroring(false);
                setSessionSeconds(0);
            }
        } else {
            setSessionSeconds(0);
            mirrorStartTime.current = Date.now();
            setIsStarting(true);
            const res = await electron.scrcpyStart(selectedDevice.id);
            setIsStarting(false);
            if (res?.success || res?.reason === 'already_running') {
                setIsMirroring(true);
            } else {
                addToast(res?.message || 'Failed to start mirroring', 'error');
            }
        }
    };

    const handleKeepAwake = async () => {
        if (!selectedDevice || selectedDevice.kind !== 'android') return;
        const newState = !keepAwake;
        const success = await electron.adbKeepAwake(selectedDevice.id, newState);
        if (success) setKeepAwake(newState);
        else addToast("Failed to toggle Keep Awake", 'error');
    };

    const handleRecord = async () => {
        if (!selectedDevice) return;
        if (isTogglingRecord) return;
        try {
            setIsTogglingRecord(true);

            if (selectedDevice.kind === 'ios') {
                if (!isIosMirroring && !isRecording) return;
                if (!isRecording) {
                    const result = await electron.iosRecordStart();
                    if (result?.success) {
                        setIsRecording(true);
                        setRecordStartTime(Date.now());
                        addToast('iOS recording started', 'success');
                    } else {
                        addToast(result?.error || 'Failed to start iOS recording', 'error');
                    }
                } else {
                    const result = await electron.iosRecordStop();
                    setIsRecording(false);
                    if (result?.filePath) addToast('Recording saved', 'success');
                    else if (result?.cancelled) addToast('Recording discarded', 'success');
                    else addToast(result?.error || 'Failed to stop iOS recording', 'error');
                }
                return;
            }

            if (!isMirroring && !isRecording) return;

            if (!isRecording) {
                const result = await electron.recordStart(selectedDevice.id);
                if (result?.cancelled) return;
                setIsRecording(true);
                setRecordStartTime(Date.now());
                addToast('Recording started', 'success');
            } else {
                const result = await electron.recordStop(selectedDevice.id);
                setIsRecording(false);
                if (result?.filePath) addToast('Recording saved', 'success');
                else addToast('Recording discarded', 'success');
            }
        } finally {
            setIsTogglingRecord(false);
        }
    };

    const handleScreenshot = async () => {
        if (!selectedDevice) {
            debugLog('screenshot', 'no device selected');
            addToast('No device selected', 'error');
            return;
        }
        if (isCapturingShot) return;
        setIsCapturingShot(true);
        try {
            debugLog('screenshot', 'calling for device:', `${selectedDevice.kind} ${selectedDevice.id}`);
            if (selectedDevice.kind === 'ios') {
                const res = await electron.iosScreenshot(selectedDevice.id);
                if (res?.success) {
                    if (!res.quickMode) addToast('Screenshot captured', 'success');
                } else if (res?.reason === 'already_capturing') {
                    addToast('Screenshot already in progress', 'info');
                } else {
                    addToast(res?.error || 'iOS screenshot failed', 'error');
                }
                return;
            }
            const res = await electron.adbScreenshot(selectedDevice.id);
            if (res?.success) {
                if (!res.quickMode) addToast('Screenshot captured', 'success');
            } else if (res?.reason === 'already_capturing') {
                addToast('Screenshot already in progress', 'info');
            } else {
                addToast(res?.message || 'Screenshot failed', 'error');
            }
        } catch (e: any) {
            addToast(e.message, 'error');
        } finally {
            setIsCapturingShot(false);
        }
    };

    const handleLongScreenshot = async () => {
        if (!selectedDevice || selectedDevice.kind !== 'android') return;
        if (isCapturingLongShot) return;
        setIsCapturingLongShot(true);
        try {
            addToast('Capturing full page... this may take a few seconds', 'info');
            const result = await electron.longScreenshot(selectedDevice.id);
            if (result?.success) {
                debugLog('screenshot', 'long screenshot stitched:', result.tempPath);
                addToast('Full page screenshot captured', 'success');
            } else if (result?.reason === 'already_capturing') {
                addToast('Screenshot already in progress', 'info');
            } else {
                addToast(result?.error || 'Full page screenshot failed', 'error');
            }
        } catch (e: any) {
            addToast(e.message, 'error');
        } finally {
            setIsCapturingLongShot(false);
        }
    };

    const formatElapsed = (totalSeconds: number) => {
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;
        return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
    };

    // Expose live app state for inspection in DevTools console (dev builds only):
    // type __mirraDebug.getState() in the Console tab.
    useEffect(() => {
        if (import.meta.env.DEV) {
            (window as any).__mirraDebug = {
                getState: () => ({ isMirroring, isRecording, selectedDevice, theme })
            };
        }
    }, [isMirroring, isRecording, selectedDevice, theme]);

    const isConnected = !!selectedDevice;
    const deviceName = selectedDevice?.name || '';

    if (isScreenshotPopup) return <ScreenshotPopup />;

    return (
        <div
            className="h-screen w-full rounded-2xl overflow-hidden bg-white/95 dark:bg-[#111114]/95 backdrop-blur-sm border border-gray-200 dark:border-white/10 flex flex-col items-center py-2 gap-0.5 select-none cursor-move"
            style={{ WebkitAppRegion: 'drag', boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 0 0.5px rgba(255,255,255,0.08)' } as CSSProperties}
        >
            {/* App icon / logo */}
            <div className="w-10 h-10 rounded-xl bg-blue-500 flex items-center justify-center mb-1 flex-shrink-0">
                <Monitor size={20} className="text-white" />
            </div>

            {/* Divider */}
            <div className="w-8 h-px bg-gray-200 dark:bg-white/10 mb-0.5" />

            {/* Device status dot */}
            <div className="relative group">
                <div className={`w-2.5 h-2.5 rounded-full mx-auto mb-2 ${isConnected ? 'bg-green-400' : 'bg-gray-300 dark:bg-white/20'}`} />
                <div className="absolute left-14 top-0 bg-white dark:bg-[#1f1f26] border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-xs text-gray-800 dark:text-white whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none z-50 transition-opacity">
                    {deviceName || 'No device'}
                    <br />
                    {isConnected && (
                        selectedDevice?.kind === 'ios'
                            ? 'iOS Device'
                            : `${status?.battery ?? 0}% · ${status?.isWifi ? 'Wi-Fi' : 'USB'}`
                    )}
                </div>
            </div>

            {/* START / STOP MIRROR — primary action */}
            <IconButton
                onClick={toggleMirror}
                icon={isMirroring || isIosMirroring ? Square : Play}
                tooltip={
                    selectedDevice?.kind === 'ios'
                        ? (isIosMirroring ? `Stop iOS Mirror (${formatElapsed(sessionSeconds)})` : 'Start iOS Mirror')
                        : (isMirroring ? `Stop Mirroring (${formatElapsed(sessionSeconds)})` : 'Start Mirroring')
                }
                active={isMirroring || isIosMirroring}
                activeColor="red"
                disabled={isStarting || isStartingIos}
                size="lg"
            />

            {selectedDevice?.kind === 'ios' && isIosMirroring && iosConnectionStatus && (
                <div className="text-[10px] text-gray-500 dark:text-white/50 text-center mb-1">
                    {iosConnectionStatus === 'waiting' && 'Waiting for iPhone...'}
                    {iosConnectionStatus === 'connected' && 'iPhone connected ✓'}
                    {iosConnectionStatus === 'disconnected' && 'iPhone disconnected'}
                </div>
            )}

            {/* Divider */}
            <div className="w-8 h-px bg-gray-200 dark:bg-white/10 my-1" />

            {/* SCREENSHOT */}
            <IconButton
                onClick={handleScreenshot}
                icon={Camera}
                tooltip={isCapturingShot ? 'Capturing…' : 'Screenshot'}
                disabled={!selectedDevice || isCapturingShot || isCapturingLongShot}
            />

            {/* QUICK SCREENSHOT — direct to clipboard, skips popup */}
            <IconButton
                icon={quickScreenshotMode ? Zap : ZapOff}
                tooltip={quickScreenshotMode
                    ? 'Quick Screenshot: ON (direct to clipboard)'
                    : 'Quick Screenshot: OFF (shows popup)'}
                onClick={toggleQuickScreenshot}
                active={quickScreenshotMode}
                activeColor="blue"
                size="sm"
            />

            {/* FULL PAGE SCREENSHOT — auto-scroll + stitch (Android) */}
            <IconButton
                icon={ScanLine}
                tooltip="Full Page Screenshot (Android)"
                onClick={handleLongScreenshot}
                disabled={!isMirroring || selectedDevice?.kind !== 'android'}
                size="sm"
            />

            {/* RECORD — via scrcpy --record */}
            <IconButton
                onClick={handleRecord}
                icon={isRecording ? CircleStop : Circle}
                tooltip={isRecording ? `Stop Recording ${formatElapsed(recordElapsed)}` : 'Record'}
                active={isRecording}
                activeColor="red"
                disabled={(!isMirroring && !(selectedDevice?.kind === 'ios' && isIosMirroring)) || isTogglingRecord}
            />

            {/* KEEP AWAKE */}
            <IconButton
                onClick={handleKeepAwake}
                icon={Sun}
                tooltip={keepAwake ? 'Keep Awake: ON' : 'Keep Awake: OFF'}
                active={keepAwake}
                activeColor="amber"
                disabled={!selectedDevice || selectedDevice.kind !== 'android'}
            />

            {/* Spacer — pushes bottom controls down */}
            <div className="flex-1" />

            {/* PIN TO TOP */}
            <IconButton
                onClick={toggleAlwaysOnTop}
                icon={alwaysOnTop ? Pin : PinOff}
                tooltip={alwaysOnTop ? 'Unpin from top' : 'Pin to top'}
                active={alwaysOnTop}
                activeColor="blue"
            />

            {/* THEME TOGGLE — main process owns state, applies via theme:changed */}
            <IconButton
                onClick={handleThemeToggle}
                icon={theme === 'dark' ? Sun : Moon}
                tooltip={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                size="sm"
            />

            {/* CLOSE */}
            <IconButton
                onClick={() => electron.closeWindow()}
                icon={X}
                tooltip="Close Mirra"
                size="sm"
            />

            {/* MODALS & TOASTS */}
            {driversMissing && (
                <div className="fixed left-[72px] top-2 z-40 w-[280px] flex items-start flex-wrap gap-2 px-3 py-2.5 rounded-lg shadow-lg border border-blue-500/30 bg-blue-50 text-blue-900 dark:bg-blue-950/90 dark:text-blue-100 text-xs">
                    <span className="flex-1 min-w-0">No iOS devices found. Install the <span className="font-medium">Apple Devices</span> app from the Microsoft Store to enable iOS support.</span>
                    <button
                        onClick={() => electron.iosOpenStore()}
                        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                        className="shrink-0 px-3 py-1.5 rounded-md bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 whitespace-nowrap"
                    >
                        Open Microsoft Store
                    </button>
                    <button
                        onClick={() => {
                            driversBannerDismissedRef.current = true;
                            setDriversMissing(false);
                        }}
                        aria-label="Dismiss"
                        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                        className="shrink-0 text-blue-900/60 hover:text-blue-900 dark:text-blue-100/60 dark:hover:text-blue-100"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
            )}

            <div className="fixed left-[72px] bottom-2 z-40 w-[260px] flex flex-col space-y-2">
                {toasts.map(toast => (
                    <div key={toast.id} className={cn(
                        "px-4 py-3 rounded-lg shadow-lg border text-sm flex items-center space-x-3 transition-opacity duration-300",
                        toast.type === 'success' ? 'bg-white dark:bg-[#1a1a1f] border-green-500/20 text-gray-800 dark:text-white/90'
                            : toast.type === 'info' ? 'bg-white dark:bg-[#1a1a1f] border-blue-500/30 text-gray-800 dark:text-white/90'
                            : 'bg-red-50 dark:bg-[#2a1215] border-red-500/30 text-red-700 dark:text-red-100'
                    )}>
                        {toast.type === 'success'
                            ? <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                            : toast.type === 'info'
                                ? <Info className="w-4 h-4 text-blue-400 shrink-0" />
                                : <div className="w-4 h-4 shrink-0" />
                        }
                        <span className="whitespace-pre-line">{toast.msg}</span>
                        {toast.action && (
                            <button
                                onClick={() => toast.action!.onClick()}
                                style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                                className={cn(
                                    "ml-1 px-2 py-1 rounded text-xs font-medium whitespace-nowrap",
                                    toast.type === 'success' ? "bg-blue-500 text-white hover:bg-blue-600" : "bg-black/10 hover:bg-black/20 dark:bg-white/20 dark:hover:bg-white/30"
                                )}
                            >
                                {toast.action.label}
                            </button>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

const ScreenshotPopup = () => {
    const [imgSrc, setImgSrc] = useState<string | null>(null);
    // Ref, not state: the fallback timer's closure would otherwise see a
    // stale null imgSrc forever (this effect never re-runs), so the
    // redundant get-data IPC fired on every screenshot even after a
    // successful push. Refs update synchronously and are immune to that.
    const hasReceivedPush = useRef(false);

    useEffect(() => {
        debugLog('screenshot', 'popup mounted, hash =', window.location.hash);
        // Listen for data pushed from main (fast path)
        electron.onScreenshotDataPush((data: { base64: string; tempPath: string }) => {
            hasReceivedPush.current = true;
            debugLog('screenshot', 'received push, base64 len =', data.base64.length);
            setImgSrc(`data:image/png;base64,${data.base64}`);
        });

        // Fallback: pull only if the push genuinely never arrived
        const fallbackTimer = setTimeout(async () => {
            if (hasReceivedPush.current) return;  // ref check, not state check
            debugLog('screenshot', 'fallback firing (no push within 500ms)');
            const res: any = await electron.screenshotGetData();
            debugLog('screenshot', 'fallback get-data result:', res?.success);
            if (res?.success) {
                setImgSrc(`data:image/png;base64,${res.base64}`);
            }
        }, 500);

        // Auto-dismiss after 10 seconds
        const dismissTimer = setTimeout(() => {
            electron.screenshotDismiss();
        }, 10000);

        // Escape key
        const keyHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') electron.screenshotDismiss();
        };
        window.addEventListener('keydown', keyHandler);

        return () => {
            clearTimeout(fallbackTimer);
            clearTimeout(dismissTimer);
            window.removeEventListener('keydown', keyHandler);
        };
    }, []);

    return (
        <div
            style={{ WebkitAppRegion: 'drag', boxShadow: '0 12px 40px rgba(0,0,0,0.7)' } as CSSProperties}
            className="h-screen w-full rounded-2xl overflow-hidden bg-white/95 dark:bg-[#1a1a22]/95 backdrop-blur-sm border border-gray-200 dark:border-white/10 flex flex-col p-3"
        >
            <div className="flex items-center justify-between mb-2" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
                <div className="flex items-center gap-2">
                    <Camera size={14} className="text-blue-400" />
                    <span className="text-[12px] text-gray-800 dark:text-white font-medium">Screenshot captured</span>
                </div>
                <button
                    onClick={() => electron.screenshotDismiss()}
                    style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                    className="w-5 h-5 rounded flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:text-white/40 dark:hover:text-white/80 dark:hover:bg-white/10"
                >
                    <X size={12} />
                </button>
            </div>
            {imgSrc ? (
                <div className="flex-1 rounded-lg overflow-hidden bg-gray-100 dark:bg-black/40 mb-2 flex items-center justify-center">
                    <img src={imgSrc} alt="Screenshot" className="max-h-full max-w-full object-contain" />
                </div>
            ) : (
                <div className="flex-1 rounded-lg bg-gray-100 dark:bg-white/5 mb-2 animate-pulse flex items-center justify-center">
                    <span className="text-gray-300 dark:text-white/20 text-xs">Loading...</span>
                </div>
            )}
            <div className="flex gap-2" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
                <button
                    onClick={() => electron.screenshotCopyClipboard()}
                    style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                    className="flex-1 py-1.5 rounded-lg bg-gray-100 border border-gray-200 text-[11px] text-gray-600 hover:bg-gray-200 dark:bg-white/10 dark:border-white/10 dark:text-white/70 dark:hover:bg-white/15 transition-all"
                >
                    Copy Image
                </button>
                <button
                    onClick={() => electron.screenshotSave()}
                    style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                    className="flex-1 py-1.5 rounded-lg bg-blue-500 text-[11px] text-white font-medium hover:bg-blue-600 transition-all"
                >
                    Save As…
                </button>
            </div>
            <div className="mt-2 h-0.5 bg-gray-200 dark:bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-blue-400/50 rounded-full animate-[shrink_10s_linear_forwards]" />
            </div>
        </div>
    );
};

interface IconButtonProps {
    icon: LucideIcon;
    tooltip: string;
    onClick?: () => void;
    active?: boolean;
    activeColor?: 'red' | 'amber' | 'blue' | 'green';
    disabled?: boolean;
    size?: 'sm' | 'md' | 'lg';
}

const colorMap: Record<NonNullable<IconButtonProps['activeColor']>, string> = {
    red: 'bg-red-500/15 text-red-400 border-red-500/30',
    amber: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    blue: 'bg-blue-500/20 text-blue-400 border-blue-500/35',
    green: 'bg-green-500/15 text-green-400 border-green-500/30',
};

const sizeMap: Record<NonNullable<IconButtonProps['size']>, { btn: string; icon: number }> = {
    sm: { btn: 'w-9 h-9', icon: 14 },
    md: { btn: 'w-10 h-10', icon: 18 },
    lg: { btn: 'w-11 h-11', icon: 20 },
};

const IconButton = ({ icon: Icon, tooltip, onClick, active, activeColor = 'blue', disabled, size = 'md' }: IconButtonProps) => (
    <div>
        <button
            onClick={onClick}
            disabled={disabled}
            title={tooltip}
            style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
            className={`
                ${sizeMap[size].btn} rounded-xl border flex items-center justify-center transition-all duration-150
                ${active
                    ? colorMap[activeColor]
                    : 'border-gray-200 bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-800 dark:border-white/10 dark:bg-white/5 dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-white/80'
                }
                ${disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'}
            `}
        >
            <Icon size={sizeMap[size].icon} />
        </button>
    </div>
);

export default App;
