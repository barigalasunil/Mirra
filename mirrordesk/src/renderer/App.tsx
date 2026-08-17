import { useEffect, useState, useRef, type CSSProperties } from 'react';
import { Play, Camera, Monitor, Sun, CheckCircle2, Circle, Square, X, Pin, PinOff, MoreVertical, Info } from 'lucide-react';
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

const isScreenshotPopup = typeof window !== 'undefined' && window.location.hash === '#screenshot-popup';

function App() {
    const [selectedDevice, setSelectedDevice] = useState<DeviceEntry | null>(null);
    const [status, setStatus] = useState<DeviceStatus | null>(null);
    const [driversMissing, setDriversMissing] = useState(false);
    const driversBannerDismissedRef = useRef(false);
    const mirrorStartTime = useRef<number>(0);
    const [isMirroring, setIsMirroring] = useState(false);
    const [keepAwake, setKeepAwake] = useState(false);
    const [showWifiConnect, setShowWifiConnect] = useState(false);
    const [wifiIp, setWifiIp] = useState('');
    const [autoDiscoverInProgress, setAutoDiscoverInProgress] = useState(false);
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
        pollDevices();
        const interval = setInterval(pollDevices, 3000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        let stoppedListener = (_data: { code: number }) => {
            const elapsed = Date.now() - mirrorStartTime.current;
            if (elapsed < 2000) {
                console.log('[renderer] ignoring early scrcpy exit, elapsed:', elapsed);
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
        setTheme(storedTheme === 'dark' ? 'dark' : 'light');
        if (storedTheme === 'dark') document.documentElement.classList.add('dark');
        else document.documentElement.classList.remove('dark');
    };

    const toggleTheme = async () => {
        const next = theme === 'dark' ? 'light' : 'dark';
        setTheme(next);
        await electron.storeSet('theme', next);
        if (next === 'dark') document.documentElement.classList.add('dark');
        else document.documentElement.classList.remove('dark');
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

    useEffect(() => {
        const menuListener = (action: string) => {
            if (action === 'wifi') setShowWifiConnect(true);
            else if (action === 'toggle-theme') toggleTheme();
            else if (action === 'toggle-pin') toggleAlwaysOnTop();
        };
        electron.onMenuAction(menuListener);
        return () => electron.removeMenuAction();
    }, [toggleTheme, toggleAlwaysOnTop]);

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
            console.log('[ios-mirror] uxplay exited, code', code);
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

    const handleConnectWifi = async () => {
        if (!wifiIp) return;
        const res = await electron.adbConnectWifi(wifiIp);
        if (res.success) {
            addToast("Connected via Wi-Fi", 'success');
            setShowWifiConnect(false);
            pollDevices();
        } else {
            addToast(res.message, 'error');
        }
    };

    const handleEnableWifi = async () => {
        if (!selectedDevice || selectedDevice.kind !== 'android') return;
        const res = await electron.adbEnableWifi(selectedDevice.id);
        if (res.success) {
            addToast('Wireless debugging enabled on device', 'success');
            const discover = await electron.adbDiscoverIp(selectedDevice.id);
            if (discover.success && discover.ip) {
                setWifiIp(`${discover.ip}:5555`);
                addToast(`Detected device IP ${discover.ip}:5555`, 'success');
            }
        } else {
            addToast(res.message || 'Failed to enable Wi-Fi', 'error');
        }
    };

    const handleDiscoverIp = async () => {
        if (!selectedDevice || selectedDevice.kind !== 'android') return;
        setAutoDiscoverInProgress(true);
        try {
            const discover = await electron.adbDiscoverIp(selectedDevice.id);
            if (discover.success && discover.ip) {
                setWifiIp(`${discover.ip}:5555`);
                addToast(`Discovered device IP ${discover.ip}:5555`, 'success');
            } else {
                addToast(discover.message || 'Failed to discover IP', 'error');
            }
        } finally {
            setAutoDiscoverInProgress(false);
        }
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
    };

    const handleScreenshot = async () => {
        if (!selectedDevice) {
            console.log('[screenshot] no device selected');
            addToast('No device selected', 'error');
            return;
        }
        console.log('[screenshot] calling for device:', selectedDevice.kind, selectedDevice.id);
        try {
            if (selectedDevice.kind === 'ios') {
                const res = await electron.iosScreenshot(selectedDevice.id);
                if (res?.success) {
                    addToast('Screenshot captured', 'success');
                } else {
                    addToast(res?.error || 'iOS screenshot failed', 'error');
                }
                return;
            }
            const res = await electron.adbScreenshot(selectedDevice.id);
            if (res?.success) {
                addToast('Screenshot captured', 'success');
            } else {
                addToast(res?.message || 'Screenshot failed', 'error');
            }
        } catch (e: any) {
            addToast(e.message, 'error');
        }
    };

    const formatElapsed = (totalSeconds: number) => {
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;
        return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
    };

    const isConnected = !!selectedDevice;
    const deviceName = selectedDevice?.name || '';


    if (isScreenshotPopup) return <ScreenshotPopup />;

    return (
        <div
            className="h-screen w-full rounded-2xl overflow-hidden bg-[#111114]/95 backdrop-blur-sm border border-white/10 flex flex-col items-center py-2 gap-0.5 select-none cursor-move"
            style={{ WebkitAppRegion: 'drag', boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 0 0.5px rgba(255,255,255,0.08)' } as CSSProperties}
        >
            {/* App icon / logo */}
            <div className="w-10 h-10 rounded-xl bg-blue-500 flex items-center justify-center mb-1 flex-shrink-0">
                <Monitor size={20} className="text-white" />
            </div>

            {/* Divider */}
            <div className="w-8 h-px bg-white/10 mb-0.5" />

            {/* Device status dot */}
            <div className="relative group">
                <div className={`w-2.5 h-2.5 rounded-full mx-auto mb-2 ${isConnected ? 'bg-green-400' : 'bg-white/20'}`} />
                <div className="absolute left-14 top-0 bg-[#1f1f26] border border-white/10 rounded-lg px-3 py-2 text-xs text-white whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none z-50 transition-opacity">
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
                <div className="text-[10px] text-white/50 text-center mb-1">
                    {iosConnectionStatus === 'waiting' && 'Waiting for iPhone...'}
                    {iosConnectionStatus === 'connected' && 'iPhone connected ✓'}
                    {iosConnectionStatus === 'disconnected' && 'iPhone disconnected'}
                </div>
            )}

            {/* Divider */}
            <div className="w-8 h-px bg-white/10 my-1" />

            {/* SCREENSHOT */}
            <IconButton
                onClick={handleScreenshot}
                icon={Camera}
                tooltip="Screenshot"
                disabled={!selectedDevice}
            />

            {/* RECORD — via scrcpy --record */}
            <IconButton
                onClick={handleRecord}
                icon={Circle}
                tooltip={isRecording ? `Stop Recording ${formatElapsed(recordElapsed)}` : 'Record'}
                active={isRecording}
                activeColor="red"
                disabled={!isMirroring && !(selectedDevice?.kind === 'ios' && isIosMirroring)}
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
                tooltip={alwaysOnTop ? 'Pinned on top' : 'Click to pin on top'}
                active={alwaysOnTop}
                activeColor="blue"
            />

            {/* MORE OPTIONS */}
            <IconButton
                onClick={() => electron.showContextMenu({ theme, alwaysOnTop })}
                icon={MoreVertical}
                tooltip="More options"
            />

            {/* CLOSE */}
            <IconButton
                onClick={() => electron.closeWindow()}
                icon={X}
                tooltip="Close Mirra"
                size="sm"
            />

            {/* MODALS & TOASTS */}
            {showWifiConnect && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/60">
                    <div className="bg-[#1a1a1f] border border-white/10 shadow-lg rounded-xl w-full max-w-[260px] p-5">
                        <h3 className="text-base font-semibold mb-2 text-white">Connect via Wi-Fi</h3>
                        <p className="text-xs text-white/50 mb-4">
                            Make sure your phone and PC are on the same Wi-Fi network. 
                            Enable "Wireless debugging" on your Android 11+ device and enter the IP and port below.
                        </p>
                        <input 
                            type="text" 
                            placeholder="e.g. 192.168.1.5:5555"
                            style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                            className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-sm text-white mb-4 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            value={wifiIp}
                            onChange={(e) => setWifiIp(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleConnectWifi()}
                        />
                        <div className="space-y-2">
                            <button
                                style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                                className="w-full px-4 py-2 rounded-md bg-white/5 border border-white/10 text-white/80 hover:bg-white/10 text-sm"
                                disabled={!selectedDevice || autoDiscoverInProgress}
                                onClick={handleDiscoverIp}
                            >
                                {autoDiscoverInProgress ? 'Discovering IP…' : 'Auto discover device IP'}
                            </button>
                            <button
                                style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                                className="w-full px-4 py-2 rounded-md bg-white/5 border border-white/10 text-white/80 hover:bg-white/10 text-sm"
                                disabled={!selectedDevice}
                                onClick={handleEnableWifi}
                            >Enable Wireless Debugging (adb tcpip 5555)</button>
                        </div>
                        <div className="flex justify-end space-x-2 mt-4">
                            <button style={{ WebkitAppRegion: 'no-drag' } as CSSProperties} className="px-3 py-1.5 text-sm rounded-md text-white/60 hover:bg-white/10" onClick={() => setShowWifiConnect(false)}>Cancel</button>
                            <button style={{ WebkitAppRegion: 'no-drag' } as CSSProperties} className="px-3 py-1.5 text-sm rounded-md bg-blue-500 text-white font-medium hover:bg-blue-600" onClick={handleConnectWifi}>Connect</button>
                        </div>
                    </div>
                </div>
            )}

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
                        toast.type === 'success' ? 'bg-[#1a1a1f] border-green-500/20 text-white/90'
                            : toast.type === 'info' ? 'bg-[#1a1a1f] border-blue-500/30 text-white/90'
                            : 'bg-[#2a1215] border-red-500/30 text-red-100'
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
                                    toast.type === 'success' ? "bg-blue-500 text-white hover:bg-blue-600" : "bg-white/20 hover:bg-white/30"
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

    useEffect(() => {
        console.log('[popup] mounted, hash =', window.location.hash);
        // Listen for data pushed from main (fast path)
        electron.onScreenshotDataPush((data: { base64: string; tempPath: string }) => {
            console.log('[popup] received push, base64 len =', data.base64.length);
            setImgSrc(`data:image/png;base64,${data.base64}`);
        });

        // Fallback: pull if push hasn't arrived within 500ms
        const fallbackTimer = setTimeout(async () => {
            console.log('[popup] fallback firing (no push within 500ms)');
            const res: any = await electron.screenshotGetData();
            console.log('[popup] fallback get-data result:', res?.success);
            if (res?.success) {
                setImgSrc(prev => prev ?? `data:image/png;base64,${res.base64}`);
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
            className="h-screen w-full rounded-2xl overflow-hidden bg-[#1a1a22]/95 backdrop-blur-sm border border-white/10 flex flex-col p-3"
        >
            <div className="flex items-center justify-between mb-2" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
                <div className="flex items-center gap-2">
                    <Camera size={14} className="text-blue-400" />
                    <span className="text-[12px] text-white font-medium">Screenshot captured</span>
                </div>
                <button
                    onClick={() => electron.screenshotDismiss()}
                    style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                    className="w-5 h-5 rounded flex items-center justify-center text-white/40 hover:text-white/80 hover:bg-white/10"
                >
                    <X size={12} />
                </button>
            </div>
            {imgSrc ? (
                <div className="flex-1 rounded-lg overflow-hidden bg-black/40 mb-2 flex items-center justify-center">
                    <img src={imgSrc} alt="Screenshot" className="max-h-full max-w-full object-contain" />
                </div>
            ) : (
                <div className="flex-1 rounded-lg bg-white/5 mb-2 animate-pulse flex items-center justify-center">
                    <span className="text-white/20 text-xs">Loading...</span>
                </div>
            )}
            <div className="flex gap-2" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
                <button
                    onClick={() => electron.screenshotCopyClipboard()}
                    style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
                    className="flex-1 py-1.5 rounded-lg bg-white/10 border border-white/10 text-[11px] text-white/70 hover:bg-white/15 transition-all"
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
            <div className="mt-2 h-0.5 bg-white/10 rounded-full overflow-hidden">
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
    <div className="relative group">
        <button
            onClick={onClick}
            disabled={disabled}
            style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
            className={`
                ${sizeMap[size].btn} rounded-xl border flex items-center justify-center transition-all duration-150
                ${active
                    ? colorMap[activeColor]
                    : 'border-white/10 bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/80'
                }
                ${disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'}
            `}
        >
            <Icon size={sizeMap[size].icon} />
        </button>
        <div className="absolute left-14 top-1/2 -translate-y-1/2 bg-[#1f1f26] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none z-50 transition-opacity duration-150">
            {tooltip}
        </div>
    </div>
);

export default App;
