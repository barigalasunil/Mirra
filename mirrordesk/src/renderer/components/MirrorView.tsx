import { useEffect, useRef, useState, useCallback } from 'react';
import { WebCodecsPlayer } from '../player/WebCodecsPlayer';
import { MsePlayer } from '../player/MsePlayer';
import { BasePlayer } from '../player/BasePlayer';
import { InteractionHandler } from '../control/InteractionHandler';
import { ControlMessage } from '../control/ControlMessage';

interface PlayerInfo {
    name: string;
    codeName: string;
    supported: boolean;
    active: boolean;
}

interface MirrorStats {
    wsState: string;
    playerName: string;
    decoderState: string;
    receivedBytes: number;
    framesDecoded: number;
    droppedFrames: number;
    reconnectCount: number;
    deviceName: string;
}

interface MirrorViewProps {
    deviceId: string;
    wsUrl?: string;
}

// ws-scrcpy magic byte constants
const MAGIC_BYTES_INITIAL = new Uint8Array([
    0x73, 0x63, 0x72, 0x63, 0x70, 0x79, 0x5f, 0x69,
    0x6e, 0x69, 0x74, 0x69, 0x61, 0x6c,
]); // "scrcpy_initial"
const MAGIC_BYTES_MESSAGE = new Uint8Array([
    0x73, 0x63, 0x72, 0x63, 0x70, 0x79, 0x5f, 0x6d,
    0x65, 0x73, 0x73, 0x61, 0x67, 0x65,
]); // "scrcpy_message"
const DEVICE_NAME_LENGTH = 64;

function arraysEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function parseDeviceName(data: Uint8Array): string {
    const nameBytes = data.subarray(MAGIC_BYTES_INITIAL.length, MAGIC_BYTES_INITIAL.length + DEVICE_NAME_LENGTH);
    const nullTerm = nameBytes.indexOf(0);
    const valid = nullTerm >= 0 ? nameBytes.subarray(0, nullTerm) : nameBytes;
    return new TextDecoder().decode(valid);
}

export function MirrorView({ deviceId, wsUrl = 'ws://localhost:8080' }: MirrorViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const playerRef = useRef<BasePlayer | null>(null);
    const interactionRef = useRef<InteractionHandler | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const hasInitialInfo = useRef(false);
    const statsRef = useRef<MirrorStats>({
        wsState: 'idle',
        playerName: 'none',
        decoderState: 'idle',
        receivedBytes: 0,
        framesDecoded: 0,
        droppedFrames: 0,
        reconnectCount: 0,
        deviceName: '',
    });
    const [stats, setStats] = useState<MirrorStats>(statsRef.current);
    const [players, setPlayers] = useState<PlayerInfo[]>([]);
    const [activeCodeName, setActiveCodeName] = useState('');

    const updateStats = useCallback((update: Partial<MirrorStats>) => {
        statsRef.current = { ...statsRef.current, ...update };
        setStats({ ...statsRef.current });
    }, []);

    const detectPlayers = useCallback(() => {
        const detected: PlayerInfo[] = [];
        detected.push({
            name: 'WebCodecs',
            codeName: 'webcodecs',
            supported: WebCodecsPlayer.isSupported(),
            active: false,
        });
        detected.push({
            name: 'MSE Player',
            codeName: 'mse',
            supported: MsePlayer.isSupported(),
            active: false,
        });
        setPlayers(detected);
        return detected;
    }, []);

    const selectPlayer = useCallback((deviceId: string): BasePlayer => {
        if (WebCodecsPlayer.isSupported()) {
            console.log('[MirrorView] Selected WebCodecs player');
            setActiveCodeName('webcodecs');
            updateStats({ playerName: 'WebCodecs', decoderState: 'configuring' });
            return new WebCodecsPlayer(deviceId);
        }
        if (MsePlayer.isSupported()) {
            console.log('[MirrorView] Selected MSE Player fallback');
            setActiveCodeName('mse');
            updateStats({ playerName: 'MSE Player', decoderState: 'configuring' });
            return new MsePlayer(deviceId);
        }
        throw new Error('No supported video decoder found. Requires WebCodecs or MSE.');
    }, [updateStats]);

    const handleControlMessage = useCallback((msg: ControlMessage) => {
        const ws = socketRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(msg.toBuffer());
        }
    }, []);

    useEffect(() => {
        if (!deviceId || !containerRef.current) return;
        const container = containerRef.current;

        detectPlayers();

        let player: BasePlayer;
        try {
            player = selectPlayer(deviceId);
        } catch (e: any) {
            console.error('[MirrorView] No player available:', e.message);
            updateStats({ decoderState: 'error', playerName: e.message });
            return;
        }
        playerRef.current = player;
        hasInitialInfo.current = false;

        const playerMount = document.createElement('div');
        playerMount.className = 'player-mount';
        playerMount.style.width = '100%';
        playerMount.style.height = '100%';
        playerMount.style.display = 'flex';
        playerMount.style.alignItems = 'center';
        playerMount.style.justifyContent = 'center';
        playerMount.style.position = 'relative';
        container.appendChild(playerMount);

        player.setParent(playerMount);
        player.play();

        const interaction = new InteractionHandler(player, handleControlMessage);
        interactionRef.current = interaction;

        player.setOnFrame((_frame: VideoFrame) => {
            updateStats({
                framesDecoded: statsRef.current.framesDecoded + 1,
                decoderState: 'playing',
            });
        });

        const ws = new WebSocket(wsUrl);
        socketRef.current = ws;
        ws.binaryType = 'arraybuffer';
        updateStats({ wsState: 'connecting' });

        ws.onopen = () => {
            console.log('[MirrorView] WebSocket connected');
            updateStats({ wsState: 'open' });
        };

        ws.onmessage = (event) => {
            const raw = event.data;

            if (typeof raw === 'string') {
                try {
                    const msg = JSON.parse(raw);
                    if (msg.type === 'ping') return;
                } catch { /* ignore */ }
                return;
            }

            if (!(raw instanceof ArrayBuffer)) return;
            const data = new Uint8Array(raw);
            updateStats({ receivedBytes: statsRef.current.receivedBytes + data.length });

            // Handle ws-scrcpy initial info header (first message from server)
            if (!hasInitialInfo.current && data.length >= MAGIC_BYTES_INITIAL.length) {
                const magic = data.subarray(0, MAGIC_BYTES_INITIAL.length);
                if (arraysEqual(magic, MAGIC_BYTES_INITIAL)) {
                    const deviceName = parseDeviceName(data);
                    console.log('[MirrorView] Device:', deviceName);
                    updateStats({ deviceName });
                    hasInitialInfo.current = true;
                    return;
                }
            }

            // Handle scrcpy_message (clipboard/push response)
            if (data.length >= MAGIC_BYTES_MESSAGE.length) {
                const magic = data.subarray(0, MAGIC_BYTES_MESSAGE.length);
                if (arraysEqual(magic, MAGIC_BYTES_MESSAGE)) {
                    console.log('[MirrorView] Device message received, size:', data.length);
                    return;
                }
            }

            // Forward raw H264 data (with Annex B start codes) directly to player
            if (player.getState() === BasePlayer.STATE.PLAYING) {
                player.pushFrame(data);
            }
        };

        ws.onclose = () => {
            console.warn('[MirrorView] WebSocket closed');
            updateStats({
                wsState: 'closed',
                reconnectCount: statsRef.current.reconnectCount + 1,
            });
        };

        ws.onerror = (event) => {
            console.error('[MirrorView] WebSocket error:', event);
            updateStats({ wsState: 'error' });
        };

        return () => {
            console.log('[MirrorView] Cleanup');
            ws.close();
            interaction.release();
            player.stop();
            if (playerMount.parentNode) {
                playerMount.parentNode.removeChild(playerMount);
            }
            playerRef.current = null;
            interactionRef.current = null;
            socketRef.current = null;
        };
    }, [deviceId, wsUrl, detectPlayers, selectPlayer, updateStats, handleControlMessage]);

    const playerIndicator = players.map(p => (
        <span
            key={p.codeName}
            className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium mr-1 ${
                p.codeName === activeCodeName
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    : p.supported
                    ? 'bg-slate-700/50 text-slate-400'
                    : 'bg-red-900/20 text-red-400 line-through'
            }`}
        >
            {p.name}
            {p.codeName === activeCodeName && ' ✓'}
        </span>
    ));

    const statusColor = stats.wsState === 'open'
        ? 'text-emerald-300'
        : stats.wsState === 'connecting'
        ? 'text-amber-300'
        : 'text-red-300';

    const decoderColor = stats.decoderState === 'playing'
        ? 'text-emerald-300'
        : stats.decoderState === 'configuring'
        ? 'text-amber-300'
        : stats.decoderState === 'error'
        ? 'text-red-300'
        : 'text-slate-400';

    return (
        <div className="relative w-full h-full flex items-center justify-center bg-black overflow-hidden rounded-lg">
            <div
                ref={containerRef}
                className="w-full h-full flex items-center justify-center"
            />

            {/* Debug overlay */}
            <div className="absolute left-4 top-4 z-50 w-72 rounded-2xl bg-slate-950/80 border border-white/10 p-3 text-xs text-white shadow-2xl">
                <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-semibold">Stream Status</span>
                    <div className="flex items-center gap-1">
                        <span className={`w-2 h-2 rounded-full ${stats.wsState === 'open' ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                    </div>
                </div>
                <div className="mb-2 flex flex-wrap gap-1">
                    {playerIndicator}
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                    <div className="rounded-lg bg-slate-900/90 p-1.5 border border-white/10">
                        <div className="text-[10px] uppercase text-slate-400">WebSocket</div>
                        <div className={`text-xs font-medium ${statusColor}`}>{stats.wsState}</div>
                    </div>
                    <div className="rounded-lg bg-slate-900/90 p-1.5 border border-white/10">
                        <div className="text-[10px] uppercase text-slate-400">Decoder</div>
                        <div className={`text-xs font-medium ${decoderColor}`}>{stats.playerName} / {stats.decoderState}</div>
                    </div>
                    <div className="rounded-lg bg-slate-900/90 p-1.5 border border-white/10">
                        <div className="text-[10px] uppercase text-slate-400">Frames</div>
                        <div className="text-xs font-medium">{stats.framesDecoded}</div>
                    </div>
                    <div className="rounded-lg bg-slate-900/90 p-1.5 border border-white/10">
                        <div className="text-[10px] uppercase text-slate-400">Dropped</div>
                        <div className="text-xs font-medium text-amber-400">{stats.droppedFrames}</div>
                    </div>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-400">
                    <span>{stats.deviceName || 'Connecting...'}</span>
                    <span>KB: {(stats.receivedBytes / 1024).toFixed(1)}</span>
                    <span>Reconn: {stats.reconnectCount}</span>
                </div>
            </div>
        </div>
    );
}
