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
    nalUnits: number;
    spsCount: number;
    ppsCount: number;
    idrCount: number;
    reconnectCount: number;
}

interface MirrorViewProps {
    deviceId: string;
    wsUrl?: string;
}

type NalType = 'sps' | 'pps' | 'idr' | 'sei' | 'other';

function getNalType(nal: Uint8Array): NalType | null {
    if (nal.length === 0) return null;
    const type = nal[0] & 0x1f;
    switch (type) {
        case 7: return 'sps';
        case 8: return 'pps';
        case 5: return 'idr';
        case 6: return 'sei';
        default: return 'other';
    }
}

function findStartCode(data: Uint8Array, offset = 0): [number, number] {
    for (let i = offset; i + 2 < data.length; i++) {
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
            return [i, 3];
        }
        if (i + 3 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
            return [i, 4];
        }
    }
    return [-1, 0];
}

export function MirrorView({ deviceId, wsUrl = 'ws://localhost:8080' }: MirrorViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const playerRef = useRef<BasePlayer | null>(null);
    const interactionRef = useRef<InteractionHandler | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const bufferRef = useRef<Uint8Array>(new Uint8Array());
    const statsRef = useRef<MirrorStats>({
        wsState: 'idle',
        playerName: 'none',
        decoderState: 'idle',
        receivedBytes: 0,
        framesDecoded: 0,
        droppedFrames: 0,
        nalUnits: 0,
        spsCount: 0,
        ppsCount: 0,
        idrCount: 0,
        reconnectCount: 0,
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
        // WebCodecs - primary
        detected.push({
            name: 'WebCodecs',
            codeName: 'webcodecs',
            supported: WebCodecsPlayer.isSupported(),
            active: false,
        });
        // MSE - fallback 1
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
        // Try WebCodecs first
        if (WebCodecsPlayer.isSupported()) {
            console.log('[MirrorView] Selected WebCodecs player');
            setActiveCodeName('webcodecs');
            updateStats({ playerName: 'WebCodecs', decoderState: 'configuring' });
            return new WebCodecsPlayer(deviceId);
        }
        // Fallback to MSE
        if (MsePlayer.isSupported()) {
            console.log('[MirrorView] Selected MSE Player fallback');
            setActiveCodeName('mse');
            updateStats({ playerName: 'MSE Player', decoderState: 'configuring' });
            return new MsePlayer(deviceId);
        }
        throw new Error('No supported video decoder found. Requires WebCodecs or MSE.');
    }, [updateStats]);

    // Parse NAL units from raw H264 byte stream
    const parseNalUnits = useCallback((chunk: Uint8Array): Uint8Array[] => {
        const buffer = new Uint8Array(bufferRef.current.length + chunk.length);
        buffer.set(bufferRef.current, 0);
        buffer.set(chunk, bufferRef.current.length);
        const nals: Uint8Array[] = [];
        let offset = 0;

        while (true) {
            const [start, prefixLen] = findStartCode(buffer, offset);
            if (start === -1) {
                // No start code found — preserve up to 3 trailing bytes for
                // potential straddling start code across the next chunk
                const keep = Math.min(buffer.length, 3);
                bufferRef.current = buffer.subarray(buffer.length - keep);
                return nals;
            }

            const [nextStart] = findStartCode(buffer, start + prefixLen);
            if (nextStart === -1) {
                bufferRef.current = buffer.subarray(start);
                return nals;
            }

            const nal = buffer.subarray(start + prefixLen, nextStart);
            if (nal.length > 0) {
                nals.push(nal);
            }
            offset = nextStart;
        }
    }, []);

    const processNalUnits = useCallback((nals: Uint8Array[], player: BasePlayer) => {
        const localStats = statsRef.current;
        for (const nal of nals) {
            localStats.nalUnits++;
            const type = getNalType(nal);
            if (type === 'sps') localStats.spsCount++;
            else if (type === 'pps') localStats.ppsCount++;
            else if (type === 'idr') localStats.idrCount++;
            player.pushFrame(nal);
        }
        updateStats({
            nalUnits: localStats.nalUnits,
            spsCount: localStats.spsCount,
            ppsCount: localStats.ppsCount,
            idrCount: localStats.idrCount,
        });
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

        // 1. Detect available players
        detectPlayers();

        // 2. Select best player
        let player: BasePlayer;
        try {
            player = selectPlayer(deviceId);
        } catch (e: any) {
            console.error('[MirrorView] No player available:', e.message);
            updateStats({ decoderState: 'error', playerName: e.message });
            return;
        }
        playerRef.current = player;

        // 3. Mount player in container
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

        // 4. Setup interaction handler
        const interaction = new InteractionHandler(player, handleControlMessage);
        interactionRef.current = interaction;

        // 5. Update stats when frames are decoded
        player.setOnFrame((_frame: VideoFrame) => {
            updateStats({
                framesDecoded: statsRef.current.framesDecoded + 1,
                decoderState: 'playing',
            });
        });

        // 6. Connect WebSocket
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

            // Handle JSON device-info message from main process
            if (typeof raw === 'string') {
                try {
                    const msg = JSON.parse(raw);
                    if (msg.type === 'device-info') {
                        console.log('[MirrorView] Device info:', msg.deviceName);
                        return;
                    }
                } catch { /* ignore */ }
                return;
            }

            // Binary H264 data
            if (raw instanceof ArrayBuffer) {
                const data = new Uint8Array(raw);
                updateStats({ receivedBytes: statsRef.current.receivedBytes + data.length });
                const nals = parseNalUnits(data);
                if (nals.length > 0) {
                    processNalUnits(nals, player);
                }
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
            bufferRef.current = new Uint8Array();
        };
    }, [deviceId, wsUrl, detectPlayers, selectPlayer, parseNalUnits, processNalUnits, updateStats, handleControlMessage]);

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
                    <span>SPS: {stats.spsCount}</span>
                    <span>PPS: {stats.ppsCount}</span>
                    <span>IDR: {stats.idrCount}</span>
                    <span>NAL: {stats.nalUnits}</span>
                    <span>Bytes: {(stats.receivedBytes / 1024).toFixed(1)}KB</span>
                    <span>Reconn: {stats.reconnectCount}</span>
                </div>
            </div>
        </div>
    );
}
