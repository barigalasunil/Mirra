import { useEffect, useState, useRef } from 'react';
import { Settings, Play, Camera, Monitor, Smartphone, Sun, Moon, Battery, Wifi, Usb, CheckCircle2 } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { AdbDevice, MirrorSettings, DeviceStatus } from '../shared/types';
import { MirrorView } from './components/MirrorView';
function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

const electron = (window as any).electronAPI;

function App() {
    const [devices, setDevices] = useState<AdbDevice[]>([]);
    const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
    const [status, setStatus] = useState<DeviceStatus | null>(null);
    const [isMirroring, setIsMirroring] = useState(false);
    const [keepAwake, setKeepAwake] = useState(false);
    const [showWifiConnect, setShowWifiConnect] = useState(false);
    const [wifiIp, setWifiIp] = useState('');
    const [autoDiscoverInProgress, setAutoDiscoverInProgress] = useState(false);
    const [debugLogs, setDebugLogs] = useState<string[]>([]);
    const [toasts, setToasts] = useState<{ id: string; msg: string; type: 'success' | 'error' }[]>([]);
    const [settings, setLocalSettings] = useState<MirrorSettings>({});
    const [showSettings, setShowSettings] = useState(false);
    const [theme, setTheme] = useState<'dark' | 'light'>('dark');

    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        // MirrorView handles its own sizing via canvas. No resize IPC needed.
    }, []);

    const addToast = (msg: string, type: 'success' | 'error' = 'success') => {
        const id = Math.random().toString(36).substring(7);
        setToasts(prev => [...prev, { id, msg, type }]);
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
    };

    useEffect(() => {
        initTheme();
        initSettings();
        pollDevices();
        const interval = setInterval(pollDevices, 3000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        let debugListener = (event: any) => {
            const timestamp = new Date().toLocaleTimeString();
            setDebugLogs((prev) => [`[${timestamp}] ${event.category}: ${event.message}`, ...prev].slice(0, 25));
        };
        electron.onScrcpyDebug(debugListener);

        let errorListener = (msg: string) => {
            addToast(msg, 'error');
            setIsMirroring(false);
        };
        electron.onScrcpyError(errorListener);

        let startedListener = (_deviceId: string) => {
            setIsMirroring(true);
        };
        electron.onScrcpyStarted(startedListener);

        return () => {
            electron.removeScrcpyDebug();
            electron.removeScrcpyError();
            electron.removeScrcpyStarted();
        };
    }, []);

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
        setTheme(storedTheme);
        if (storedTheme === 'dark') document.documentElement.classList.add('dark');
        else document.documentElement.classList.remove('dark');
    };

    const toggleTheme = () => {
        const newTheme = theme === 'dark' ? 'light' : 'dark';
        setTheme(newTheme);
        electron.storeSet('theme', newTheme);
        if (newTheme === 'dark') document.documentElement.classList.add('dark');
        else document.documentElement.classList.remove('dark');
    };

    const initSettings = async () => {
        const s = await electron.storeGet('mirror-settings', {});
        setLocalSettings(s);
    };

    const saveSettings = (newSettings: MirrorSettings) => {
        setLocalSettings(newSettings);
        electron.storeSet('mirror-settings', newSettings);
        if (isMirroring && selectedDevice) {
            electron.scrcpyStart(selectedDevice, newSettings);
        }
    };

    const pollDevices = async () => {
        const list = await electron.adbDevices();
        setDevices(list);
        if (list.length > 0) {
            setSelectedDevice(prev => prev && list.find((d: any) => d.id === prev) ? prev : list[0].id);
        } else {
            setSelectedDevice(null);
        }
    };

    const pollStatus = async () => {
        if (selectedDevice) {
            const st = await electron.adbDeviceStatus(selectedDevice);
            setStatus(st);
        }
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
        if (!selectedDevice) return;
        const res = await electron.adbEnableWifi(selectedDevice);
        if (res.success) {
            addToast('Wireless debugging enabled on device', 'success');
            const discover = await electron.adbDiscoverIp(selectedDevice);
            if (discover.success && discover.ip) {
                setWifiIp(`${discover.ip}:5555`);
                addToast(`Detected device IP ${discover.ip}:5555`, 'success');
            }
        } else {
            addToast(res.message || 'Failed to enable Wi-Fi', 'error');
        }
    };

    const handleDiscoverIp = async () => {
        if (!selectedDevice) return;
        setAutoDiscoverInProgress(true);
        try {
            const discover = await electron.adbDiscoverIp(selectedDevice);
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

    const toggleMirror = () => {
        if (!selectedDevice) return;
        if (isMirroring) {
            electron.scrcpyStop();
            setIsMirroring(false);
        } else {
            electron.scrcpyStart(selectedDevice, settings);
            setIsMirroring(true);
        }
    };

    const handleKeepAwake = async () => {
        if (!selectedDevice) return;
        const newState = !keepAwake;
        const success = await electron.adbKeepAwake(selectedDevice, newState);
        if (success) setKeepAwake(newState);
        else addToast("Failed to toggle Keep Awake", 'error');
    };

    const handleReconnect = () => {
        if (!selectedDevice) return;
        electron.scrcpyStop();
        setTimeout(() => {
            electron.scrcpyStart(selectedDevice, settings);
        }, 500);
        addToast('Reconnecting mirroring stream', 'success');
    };

    const handleScreenshot = async () => {
        if (!selectedDevice) return;
        try {
            const tempFile = await electron.adbScreenshot(selectedDevice);
            
            // Show toast options immediately inside toast state or dialog. 
            // Better to show a custom prompt in UI or use a system dialog directly.
            // Requirement 4: "Show a small popup/toast with TWO options"
            addScreenshotToast(tempFile);
        } catch (e: any) {
            addToast(e.message, 'error');
        }
    };

    const [screenshotToast, setScreenshotToast] = useState<string | null>(null);

    const addScreenshotToast = (imgPath: string) => {
        setScreenshotToast(imgPath);
        setTimeout(() => setScreenshotToast(null), 8000);
    };
    
    const handleScreenshotAction = async (action: 'copy' | 'save', imgPath: string) => {
        setScreenshotToast(null);
        if (action === 'copy') {
            await electron.utilsCopyImageClipboard(imgPath);
            addToast("Copied to clipboard", 'success');
        } else {
            const d = new Date();
            const dateStr = d.toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-');
            const defaultPath = await electron.utilsGetPath('pictures') + `\\screenshot_${dateStr}.png`;
            const savePath = await electron.utilsSaveFileDialog(defaultPath, [{ name: 'Images', extensions: ['png'] }]);
            if (savePath) {
                await electron.utilsCopyFile(imgPath, savePath);
                addToast("Screenshot saved", 'success');
            }
        }
    };


    return (
        <div className="flex flex-col h-screen bg-background text-foreground transition-colors overflow-hidden">
            {/* TOOLBAR */}
            <header className="h-14 border-b border-border flex items-center px-4 justify-between shrink-0 bg-card">
                <div className="flex items-center space-x-4">
                    <div className="flex items-center space-x-2 text-primary font-bold text-lg">
                        <Monitor className="w-6 h-6" />
                        <span>MirrorDesk</span>
                    </div>

                    <div className="flex items-center space-x-2">
                        <select 
                            className="bg-transparent border border-input rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-ring text-sm w-48"
                            value={selectedDevice || ''}
                            onChange={(e) => setSelectedDevice(e.target.value)}
                        >
                            {devices.length === 0 ? (
                                <option value="">No devices found</option>
                            ) : (
                                devices.map(d => (
                                    <option key={d.id} value={d.id}>{d.model} ({d.id})</option>
                                ))
                            )}
                        </select>
                        {isMirroring && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                                <span className="w-2 h-2 mr-1.5 bg-green-500 rounded-full animate-pulse"></span>
                                Connected
                            </span>
                        )}
                        {status && (
                            <div className="flex items-center space-x-3 ml-2 text-sm text-muted-foreground">
                                <div className="flex items-center space-x-1">
                                    <Battery className={cn("w-4 h-4", 
                                        status.battery > 50 ? 'text-green-500' :
                                        status.battery > 20 ? 'text-amber-500' : 'text-red-500'
                                    )} />
                                    <span>{status.battery}%</span>
                                </div>
                                <div className="flex items-center space-x-1">
                                    {status.isWifi ? <Wifi className="w-4 h-4 text-blue-500"/> : <Usb className="w-4 h-4 text-gray-500"/>}
                                    <span>{status.isWifi ? 'Wi-Fi' : 'USB'}</span>
                                </div>
                                {status.ip && (
                                    <div className="flex items-center space-x-1 px-2 py-1 rounded-md bg-background/80 border border-border">
                                        <span className="text-xs font-medium">IP:</span>
                                        <span className="text-xs">{status.ip}</span>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex items-center space-x-2">
                    <button 
                        onClick={handleScreenshot}
                        disabled={!selectedDevice}
                        className="p-2 hover:bg-accent hover:text-accent-foreground rounded-md disabled:opacity-50 flex items-center space-x-2 text-sm font-medium transition-colors"
                    >
                        <Camera className="w-4 h-4" />
                        <span>Screenshot</span>
                    </button>
                    <button 
                        onClick={handleKeepAwake}
                        disabled={!selectedDevice}
                        className={cn(
                            "p-2 rounded-md disabled:opacity-50 flex items-center space-x-2 text-sm font-medium transition-colors",
                            keepAwake ? 'text-green-500 bg-green-100/50 dark:bg-green-950' : 'hover:bg-accent hover:text-accent-foreground'
                        )}
                    >
                        <Sun className="w-4 h-4" />
                        <span>Keep Awake</span>
                    </button>
                    <div className="w-px h-6 bg-border mx-1"></div>
                    <button onClick={toggleTheme} className="p-2 hover:bg-accent rounded-md">
                        {theme === 'dark' ? <Moon className="w-4 h-4"/> : <Sun className="w-4 h-4"/>}
                    </button>
                    <button 
                        onClick={() => setShowSettings(!showSettings)}
                        className={cn("p-2 rounded-md transition-colors", showSettings ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')}
                    >
                        <Settings className="w-4 h-4" />
                    </button>
                </div>
            </header>

            {/* MAIN CONTENT */}
            <main className="flex-1 flex overflow-hidden relative">
                <div className="flex-1 p-8 overflow-y-auto">
                    {!selectedDevice ? (
                        <div className="flex flex-col items-center justify-center h-full max-w-md mx-auto text-center space-y-6">
                            <div className="w-24 h-24 bg-accent/50 rounded-full flex items-center justify-center">
                                <Smartphone className="w-12 h-12 text-primary" />
                            </div>
                            <h2 className="text-2xl font-bold tracking-tight">No Device Found</h2>
                            <p className="text-muted-foreground">
                                Please enable USB Debugging on your Android device and plug it in, or connect via Wi-Fi.
                            </p>
                            <button 
                                onClick={() => setShowWifiConnect(true)}
                                className="inline-flex items-center justify-center px-4 py-2 border border-input rounded-md font-medium hover:bg-accent"
                            >
                                <Wifi className="w-4 h-4 mr-2" /> Connect via Wi-Fi
                            </button>
                        </div>
                    ) : (
                        <div className="flex flex-col h-full max-w-4xl mx-auto space-y-8 w-full p-4">
                            <div ref={containerRef} className="p-0 rounded-xl bg-card border shadow-sm flex flex-col items-center justify-center flex-1 relative overflow-hidden h-full w-full">
                                {!isMirroring ? (
                                    <div className="flex flex-col items-center">
                                        <Monitor className="w-16 h-16 text-muted-foreground mb-4" />
                                        <h3 className="text-xl font-semibold mb-2">Ready to Mirror</h3>
                                        <p className="text-muted-foreground mb-8 text-center max-w-sm">
                                            Connect your {status?.model || 'Android device'} natively via WebCodecs.
                                        </p>
                                        <button 
                                            onClick={toggleMirror}
                                            className="inline-flex items-center justify-center px-8 py-3 rounded-md font-medium shadow-sm transition-all text-white bg-primary hover:bg-primary/90"
                                        >
                                            <Play className="w-5 h-5 mr-3" />
                                            Start Mirroring
                                        </button>
                                    </div>
                                ) : (
                                    <>
                                                <MirrorView deviceId={selectedDevice} />
                                        <div className="absolute top-4 right-4 z-50 w-80 p-3 space-y-3 rounded-2xl bg-slate-950/80 border border-white/10 text-xs text-white shadow-2xl">
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="font-semibold">Stream Debug</span>
                                                <button
                                                    onClick={handleReconnect}
                                                    className="px-2 py-1 rounded-md bg-slate-700/90 hover:bg-slate-600"
                                                >Reconnect</button>
                                            </div>
                                            <div className="grid grid-cols-2 gap-2">
                                                <div className="rounded-lg bg-slate-900/90 p-2 border border-white/10">
                                                    <div className="text-[10px] uppercase text-slate-400">Connection</div>
                                                    <div className="mt-1 text-sm">{status?.isWifi ? 'Wi-Fi' : 'USB'}</div>
                                                    <div className="mt-1 text-slate-400">{status?.ip || 'No IP'}</div>
                                                </div>
                                                <div className="rounded-lg bg-slate-900/90 p-2 border border-white/10">
                                                    <div className="text-[10px] uppercase text-slate-400">Device</div>
                                                    <div className="mt-1 text-sm">{status?.model || 'Unknown'}</div>
                                                    <div className="mt-1 text-slate-400">{status?.battery}% battery</div>
                                                </div>
                                            </div>
                                            <div className="max-h-36 overflow-y-auto rounded-lg bg-slate-900/90 p-2 border border-white/10 text-[11px] leading-tight">
                                                {debugLogs.length === 0 ? (
                                                    <div className="text-slate-500">No debug messages yet.</div>
                                                ) : (
                                                    debugLogs.map((log, index) => (
                                                        <div key={`${log}-${index}`} className="mb-1 border-b border-white/5 pb-1 last:border-b-0 last:mb-0">{log}</div>
                                                    ))
                                                )}
                                            </div>
                                        </div>
                                        <button 
                                            onClick={toggleMirror}
                                            className="absolute bottom-4 left-4 z-50 inline-flex items-center justify-center px-4 py-2 rounded-md font-medium shadow-lg transition-all text-white bg-destructive hover:bg-destructive/90 text-sm"
                                        >
                                            <div className="w-4 h-4 mr-2 rounded-sm border-2 border-current flex items-center justify-center"><div className="w-2 h-2 bg-current rounded-sm"></div></div> Stop Mirroring
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* SETTINGS PANEL */}
                {showSettings && (
                    <div className="w-80 border-l border-border bg-card p-6 overflow-y-auto shadow-xl">
                        <h3 className="font-semibold text-lg mb-6 flex items-center"><Settings className="w-4 h-4 mr-2"/> Settings</h3>
                        
                        <div className="space-y-6">
                            <div className="space-y-3">
                                <label className="text-sm font-medium">Resolution</label>
                                <select 
                                    className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                                    value={settings.maxSize || 0}
                                    onChange={(e) => saveSettings({ ...settings, maxSize: Number(e.target.value) || undefined })}
                                >
                                    <option value={0}>Original</option>
                                    <option value={1440}>1440p</option>
                                    <option value={1080}>1080p</option>
                                    <option value={720}>720p</option>
                                    <option value={480}>480p</option>
                                </select>
                            </div>

                            <div className="space-y-3">
                                <label className="text-sm font-medium">Video Bitrate</label>
                                <select 
                                    className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                                    value={settings.videoBitrate || ''}
                                    onChange={(e) => saveSettings({ ...settings, videoBitrate: e.target.value || undefined })}
                                >
                                    <option value="">Default</option>
                                    <option value="16M">Ultra (16 Mbps)</option>
                                    <option value="8M">High (8 Mbps)</option>
                                    <option value="4M">Medium (4 Mbps)</option>
                                    <option value="2M">Low (2 Mbps)</option>
                                </select>
                            </div>

                            <div className="space-y-3">
                                <label className="text-sm font-medium">Frame Rate</label>
                                <select 
                                    className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                                    value={settings.maxFps || 0}
                                    onChange={(e) => saveSettings({ ...settings, maxFps: Number(e.target.value) || undefined })}
                                >
                                    <option value={0}>Default</option>
                                    <option value={120}>120 FPS</option>
                                    <option value={60}>60 FPS</option>
                                    <option value={30}>30 FPS</option>
                                </select>
                            </div>
                        </div>
                    </div>
                )}
            </main>

            {/* MODALS & TOASTS */}
            {showWifiConnect && (
                <div className="absolute inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
                    <div className="bg-card border shadow-lg rounded-xl max-w-sm w-full p-6">
                        <h3 className="text-lg font-semibold mb-2">Connect via Wi-Fi</h3>
                        <p className="text-sm text-muted-foreground mb-6">
                            Make sure your phone and PC are on the same Wi-Fi network. 
                            Enable "Wireless debugging" on your Android 11+ device and enter the IP and port below.
                        </p>
                        <input 
                            type="text" 
                            placeholder="e.g. 192.168.1.5:5555"
                            className="w-full bg-background border border-input rounded-md px-4 py-2 text-sm mb-4"
                            value={wifiIp}
                            onChange={(e) => setWifiIp(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleConnectWifi()}
                        />
                                <div className="space-y-3">
                            <button
                                className="w-full px-4 py-2 rounded-md bg-slate-800 text-slate-100 hover:bg-slate-700"
                                disabled={!selectedDevice || autoDiscoverInProgress}
                                onClick={handleDiscoverIp}
                            >
                                {autoDiscoverInProgress ? 'Discovering IP…' : 'Auto discover device IP'}
                            </button>
                            <button
                                className="w-full px-4 py-2 rounded-md bg-slate-800 text-slate-100 hover:bg-slate-700"
                                disabled={!selectedDevice}
                                onClick={handleEnableWifi}
                            >Enable Wireless Debugging (adb tcpip 5555)</button>
                        </div>
                        <div className="flex justify-end space-x-2 mt-2">
                            <button className="px-4 py-2 text-sm rounded-md hover:bg-accent" onClick={() => setShowWifiConnect(false)}>Cancel</button>
                            <button className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground font-medium" onClick={handleConnectWifi}>Connect</button>
                        </div>
                    </div>
                </div>
            )}

            {screenshotToast && (
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 p-4 bg-card border rounded-xl shadow-xl z-50 flex flex-col items-center space-y-4 w-72 animate-in fade-in slide-in-from-bottom-4">
                    <div className="flex items-center space-x-2 text-sm font-medium">
                        <Camera className="w-5 h-5 text-primary" />
                        <span>Screenshot captured!</span>
                    </div>
                    <div className="flex space-x-2 w-full">
                        <button onClick={() => handleScreenshotAction('copy', screenshotToast)} className="flex-1 py-1.5 px-3 bg-accent hover:bg-accent/80 rounded border text-xs font-medium">Copy Image</button>
                        <button onClick={() => handleScreenshotAction('save', screenshotToast)} className="flex-1 py-1.5 px-3 bg-primary text-primary-foreground hover:bg-primary/90 rounded text-xs font-medium">Save As...</button>
                    </div>
                </div>
            )}

            <div className="absolute bottom-6 right-6 flex flex-col space-y-2 z-40">
                {toasts.map(toast => (
                    <div key={toast.id} className={cn(
                        "px-4 py-3 rounded-lg shadow-lg border text-sm flex items-center space-x-3 transition-opacity duration-300",
                        toast.type === 'success' ? 'bg-card border-green-500/20 text-foreground' : 'bg-destructive text-destructive-foreground'
                    )}>
                        {toast.type === 'success' ? <CheckCircle2 className="w-4 h-4 text-green-500" /> : <div className="w-4 h-4" />}
                        <span>{toast.msg}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

export default App;
