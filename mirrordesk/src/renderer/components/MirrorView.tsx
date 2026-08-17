import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { WebCodecsPlayer } from '../player/WebCodecsPlayer';
import { MsePlayer } from '../player/MsePlayer';
import { BasePlayer } from '../player/BasePlayer';
import { InteractionHandler } from '../control/InteractionHandler';
import { ControlMessage } from '../control/ControlMessage';
import ScreenInfo from '../player/ScreenInfo';
import Rect from '../player/Rect';
import Size from '../player/Size';
import { RecordingManager } from './RecordingManager';
import type { MirrorSettings } from '../../shared/types';

const DEV_MODE = import.meta.env.DEV;

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
    bytesPerSec: number;
}

interface DiagnosticData {
    nalCounts: Record<number, number>;
    totalNals: number;
    totalBytes: number;
    decodeCount: number;
    decodeErrors: number;
    spsCount: number;
    ppsCount: number;
    idrCount: number;
    parsedSps: string;
    parsedPps: string;
    configured: boolean;
    codec: string;
    canvasWidth: number;
    canvasHeight: number;
}

interface MirrorViewProps {
    deviceId: string;
    wsUrl?: string;
    settings?: MirrorSettings;
    showDiagnostics?: boolean;
}

export interface MirrorViewHandle {
    startRecording(): boolean;
    stopRecording(): ArrayBuffer | null;
}

const MAGIC_BYTES_INITIAL = new Uint8Array([
    0x73, 0x63, 0x72, 0x63, 0x70, 0x79, 0x5f, 0x69,
    0x6e, 0x69, 0x74, 0x69, 0x61, 0x6c,
]);
const MAGIC_BYTES_MESSAGE = new Uint8Array([
    0x73, 0x63, 0x72, 0x63, 0x70, 0x79, 0x5f, 0x6d,
    0x65, 0x73, 0x73, 0x61, 0x67, 0x65,
]);
const DEVICE_NAME_LENGTH = 64;
const DISPLAY_INFO_LENGTH = 24; // displayId u32, width u32, height u32, rotation u32, layerStack u32, flags u32

// ws-scrcpy 1.19-ws7 control message type for changing stream parameters (video settings).
const TYPE_CHANGE_STREAM_PARAMETERS = 101;
// Serialized VideoSettings payload length (see VideoSettings.BASE_BUFFER_LENGTH).
const VIDEO_SETTINGS_LENGTH = 35;

function arraysEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function matchMagic(data: Uint8Array, magic: Uint8Array): boolean {
    if (data.length < magic.length) return false;
    return arraysEqual(data.subarray(0, magic.length), magic);
}

interface ParsedInitialInfo {
    /** Number of header bytes consumed (everything before the trailing encoder list / client id). */
    consumed: number;
    deviceName: string;
    width: number;
    height: number;
    rotation: number;
}

/**
 * Attempt to parse the scrcpy_initial header from the buffered bytes. Returns null until
 * enough bytes are available (or if the data does not look like an initial info message).
 * Layout (ws-scrcpy fork): magic(14) + device name(64) + u32 display count, then for each
 * display: 24 bytes display info + u32 connections count + optional length-prefixed
 * screenInfo and videoSettings. The trailing encoder list and client id (last u32) are
 * left unconsumed — the player's stream parser tolerates that trailing garbage.
 */
function tryParseInitialInfo(buf: Uint8Array): ParsedInitialInfo | null {
    const magicLen = MAGIC_BYTES_INITIAL.length;
    if (buf.length < magicLen + DEVICE_NAME_LENGTH) return null;
    if (!matchMagic(buf, MAGIC_BYTES_INITIAL)) return null;

    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let offset = magicLen;

    const nameBytes = buf.subarray(offset, offset + DEVICE_NAME_LENGTH);
    offset += DEVICE_NAME_LENGTH;

    if (buf.length < offset + 4) return null;
    const displayCount = view.getUint32(offset, false);
    offset += 4;

    let width = 0;
    let height = 0;
    let rotation = 0;
    for (let i = 0; i < displayCount; i++) {
        if (buf.length < offset + DISPLAY_INFO_LENGTH) return null;
        if (i === 0) {
            width = view.getUint32(offset + 4, false);
            height = view.getUint32(offset + 8, false);
            rotation = view.getUint32(offset + 12, false);
        }
        offset += DISPLAY_INFO_LENGTH;
        if (buf.length < offset + 4) return null;
        offset += 4; // connections count
        if (buf.length < offset + 4) return null;
        const screenInfoLen = view.getUint32(offset, false);
        offset += 4;
        if (buf.length < offset + screenInfoLen) return null;
        offset += screenInfoLen;
        if (buf.length < offset + 4) return null;
        const videoSettingsLen = view.getUint32(offset, false);
        offset += 4;
        if (buf.length < offset + videoSettingsLen) return null;
        offset += videoSettingsLen;
    }

    const nullTerm = nameBytes.indexOf(0);
    const valid = nullTerm >= 0 ? nameBytes.subarray(0, nullTerm) : nameBytes;
    let deviceName: string;
    try {
        deviceName = new TextDecoder().decode(valid);
    } catch {
        return null;
    }
    if (deviceName.length === 0) return null;
    // Printable ASCII check — a real device name never contains control bytes.
    for (let i = 0; i < deviceName.length; i++) {
        const c = deviceName.charCodeAt(i);
        if (c < 0x20 || c > 0x7e) return null;
    }

    return { consumed: offset, deviceName, width, height, rotation };
}

/**
 * Build the TYPE_CHANGE_STREAM_PARAMETERS (101) control message carrying the serialized
 * VideoSettings: 1 byte type + 35 byte VideoSettings payload. Bounds are maxSize x maxSize
 * (0 = no bounds / original resolution, mirroring scrcpy's --max-size semantics).
 */
function buildStreamParametersMessage(settings: MirrorSettings): Uint8Array<ArrayBuffer> {
    const maxSize = settings.maxSize ?? 0;
    const bitRate = settings.bitRate ?? 8000000;
    const maxFps = settings.maxFps ?? 60;
    const buf = new Uint8Array(1 + VIDEO_SETTINGS_LENGTH);
    const view = new DataView(buf.buffer);
    let offset = 0;
    view.setUint8(offset++, TYPE_CHANGE_STREAM_PARAMETERS);
    view.setInt32(offset, bitRate, false); offset += 4;   // bitRate
    view.setInt32(offset, maxFps, false); offset += 4;    // maxFps
    view.setInt8(offset, 10); offset += 1;                // iFrameInterval (seconds)
    view.setInt16(offset, maxSize, false); offset += 2;   // bounds width
    view.setInt16(offset, maxSize, false); offset += 2;   // bounds height
    view.setInt16(offset, 0, false); offset += 2;         // crop left
    view.setInt16(offset, 0, false); offset += 2;         // crop top
    view.setInt16(offset, 0, false); offset += 2;         // crop right
    view.setInt16(offset, 0, false); offset += 2;         // crop bottom
    view.setInt8(offset, 0); offset += 1;                 // sendFrameMeta
    view.setInt8(offset, -1); offset += 1;                // lockedVideoOrientation
    view.setInt32(offset, 0, false); offset += 4;         // displayId
    view.setInt32(offset, 0, false); offset += 4;         // codecOptions length
    view.setInt32(offset, 0, false); offset += 4;         // encoderName length
    return buf;
}

function hexPreview(data: ArrayLike<number>, max: number = 32): string {
    const len = Math.min(data.length, max);
    const parts: string[] = [];
    for (let i = 0; i < len; i++) {
        parts.push(data[i].toString(16).padStart(2, '0'));
    }
    return parts.join(' ');
}

export const MirrorView = forwardRef<MirrorViewHandle, MirrorViewProps>(function MirrorView(
    { deviceId, wsUrl = 'ws://localhost:8080', settings = {}, showDiagnostics = false }: MirrorViewProps,
    ref,
) {
    const containerRef = useRef<HTMLDivElement>(null);
    const playerRef = useRef<BasePlayer | null>(null);
    const interactionRef = useRef<InteractionHandler | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const hasInitialInfo = useRef(false);
    const pendingInitialInfo = useRef<Uint8Array>(new Uint8Array(0));
    const settingsRef = useRef<MirrorSettings>(settings);
    settingsRef.current = settings;
    const recordingRef = useRef<RecordingManager>(new RecordingManager());
    const diagnosticsRef = useRef<DiagnosticData>({
        nalCounts: {}, totalNals: 0, totalBytes: 0,
        decodeCount: 0, decodeErrors: 0,
        spsCount: 0, ppsCount: 0, idrCount: 0,
        parsedSps: '', parsedPps: '',
        configured: false, codec: '',
        canvasWidth: 0, canvasHeight: 0,
    });
    const [diagnostics, setDiagnostics] = useState<DiagnosticData>(diagnosticsRef.current);

    const statsRef = useRef<MirrorStats>({
        wsState: 'idle',
        playerName: 'none',
        decoderState: 'idle',
        receivedBytes: 0,
        framesDecoded: 0,
        droppedFrames: 0,
        reconnectCount: 0,
        deviceName: '',
        bytesPerSec: 0,
    });
    const [stats, setStats] = useState<MirrorStats>(statsRef.current);
    const [players, setPlayers] = useState<PlayerInfo[]>([]);
    const [activeCodeName, setActiveCodeName] = useState('');

    const updateStats = useCallback((update: Partial<MirrorStats>) => {
        statsRef.current = { ...statsRef.current, ...update };
        setStats({ ...statsRef.current });
    }, []);

    const byteCounterRef = useRef({ bytes: 0, time: Date.now() });

    const detectPlayers = useCallback(() => {
        const detected: PlayerInfo[] = [];
        detected.push({
            name: 'WebCodecs',
            codeName: 'webcodecs',
            supported: WebCodecsPlayer.isSupported(),
            active: false,
        });
        detected.push({
            name: 'MSE',
            codeName: 'mse',
            supported: MsePlayer.isSupported(),
            active: false,
        });
        setPlayers(detected);
        return detected;
    }, []);

    const selectPlayer = useCallback((codec: string, deviceId: string): BasePlayer => {
        if (codec === 'mse' && MsePlayer.isSupported()) {
            if (DEV_MODE) console.log('[MirrorView] Selected MSE Player');
            setActiveCodeName('mse');
            updateStats({ playerName: 'MSE', decoderState: 'configuring' });
            return new MsePlayer(deviceId);
        }
        if (WebCodecsPlayer.isSupported()) {
            if (DEV_MODE) console.log('[MirrorView] Selected WebCodecs player');
            setActiveCodeName('webcodecs');
            updateStats({ playerName: 'WebCodecs', decoderState: 'configuring' });
            return new WebCodecsPlayer(deviceId);
        }
        throw new Error('No supported video decoder found. Requires WebCodecs or MSE.');
    }, [updateStats]);

    const switchPlayer = useCallback((codec: string) => {
        const ws = socketRef.current;
        if (ws) ws.close();
        const oldPlayer = playerRef.current;
        if (oldPlayer) {
            oldPlayer.stop();
        }
        const container = containerRef.current;
        if (!container) return;

        setActiveCodeName('');
        updateStats({ decoderState: 'switching', playerName: 'Switching...' });
        hasInitialInfo.current = false;
        pendingInitialInfo.current = new Uint8Array(0);

        setTimeout(() => {
            if (!containerRef.current) return;
            const playerMount = container.querySelector('.player-mount');
            if (playerMount) {
                container.removeChild(playerMount);
            }
            const newMount = document.createElement('div');
            newMount.className = 'player-mount';
            newMount.style.width = '100%';
            newMount.style.height = '100%';
            newMount.style.display = 'flex';
            newMount.style.alignItems = 'center';
            newMount.style.justifyContent = 'center';
            newMount.style.position = 'relative';
            containerRef.current.appendChild(newMount);

            let player: BasePlayer;
            try {
                player = selectPlayer(codec, deviceId);
            } catch (e: any) {
                console.error('[MirrorView] Player switch error:', e.message);
                updateStats({ decoderState: 'error', playerName: e.message });
                return;
            }
            playerRef.current = player;
            player.setParent(newMount);
            player.play();

            const ws = new WebSocket(wsUrl);
            socketRef.current = ws;
            ws.binaryType = 'arraybuffer';
            updateStats({ wsState: 'connecting' });
            setupWsHandlers(ws);
        }, 100);
    }, [deviceId, wsUrl, selectPlayer, updateStats]);

    const streamDumpRef = useRef<Uint8Array[]>([]);
    const streamDumpSizeRef = useRef(0);
    const MAX_DUMP = 5 * 1024 * 1024;

    const downloadStreamDump = useCallback(() => {
        if (streamDumpSizeRef.current === 0) return;
        const total = streamDumpRef.current.reduce((s, u) => s + u.length, 0);
        const combined = new Uint8Array(total);
        let offset = 0;
        for (const chunk of streamDumpRef.current) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }
        const blob = new Blob([combined], { type: 'video/h264' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `debug-stream-${Date.now()}.h264`;
        a.click();
        URL.revokeObjectURL(url);
        if (DEV_MODE) console.log(`[MirrorView] Downloaded stream dump: ${(total / 1024 / 1024).toFixed(2)} MB`);
    }, []);

    const collectDiagnostics = useCallback(() => {
        const player = playerRef.current;
        if (!player) return;
        const diag: DiagnosticData = {
            nalCounts: {},
            totalNals: 0,
            totalBytes: 0,
            decodeCount: 0,
            decodeErrors: 0,
            spsCount: 0,
            ppsCount: 0,
            idrCount: 0,
            parsedSps: '',
            parsedPps: '',
            configured: false,
            codec: '',
            canvasWidth: 0,
            canvasHeight: 0,
        };
        if (player instanceof WebCodecsPlayer) {
            const wc = player as WebCodecsPlayer;
            const wd = wc.getDiagnostics();
            diag.nalCounts = wd.parserStats.nalCounts;
            diag.totalNals = wd.parserStats.totalNals;
            diag.totalBytes = wd.parserStats.totalBytes;
            diag.decodeCount = wd.decodeCount;
            diag.decodeErrors = wd.decodeErrors;
            diag.spsCount = wd.spsCount;
            diag.ppsCount = wd.ppsCount;
            diag.idrCount = wd.idrCount;
            diag.parsedSps = wd.lastSps;
            diag.parsedPps = wd.lastPps;
            diag.configured = wd.configured;
            diag.codec = wd.configCodec;
        } else if (player instanceof MsePlayer) {
            const mp = player as MsePlayer;
            const md = mp.getDiagnostics();
            diag.nalCounts = md.parserStats.nalCounts;
            diag.totalNals = md.parserStats.totalNals;
            diag.totalBytes = md.parserStats.totalBytes;
            diag.configured = md.ready;
            diag.codec = `${md.videoWidth}x${md.videoHeight}`;
            diag.decodeCount = md.framesAppended;
            diag.decodeErrors = md.appendErrors;
        }
        const canvas = player['tag'] as HTMLCanvasElement | undefined;
        if (canvas) {
            diag.canvasWidth = canvas.width;
            diag.canvasHeight = canvas.height;
        }
        diagnosticsRef.current = diag;
        setDiagnostics({ ...diag });
    }, []);

    const setupWsHandlers = useCallback((ws: WebSocket) => {
        ws.onopen = () => {
            if (DEV_MODE) console.log('[MirrorView] WebSocket connected');
            updateStats({ wsState: 'open' });
            // The ws-scrcpy server only starts the encoder after it receives a
            // TYPE_CHANGE_STREAM_PARAMETERS control message — without it no video flows.
            try {
                ws.send(buildStreamParametersMessage(settingsRef.current));
                if (DEV_MODE) console.log('[MirrorView] Sent stream parameters', settingsRef.current);
            } catch (e: any) {
                console.error('[MirrorView] Failed to send stream parameters:', e.message);
            }
        };

        ws.onmessage = (event) => {
            const raw = event.data;

            if (typeof raw === 'string') {
                try {
                    const msg = JSON.parse(raw);
                    if (msg.type === 'ping') return;
                } catch { }
                return;
            }

            if (!(raw instanceof ArrayBuffer)) return;
            const data = new Uint8Array(raw);
            const prevBytes = statsRef.current.receivedBytes;
            updateStats({ receivedBytes: prevBytes + data.length });

            const now = Date.now();
            const bc = byteCounterRef.current;
            if (now - bc.time > 1000) {
                const elapsed = (now - bc.time) / 1000;
                const bps = bc.bytes / elapsed;
                updateStats({ bytesPerSec: Math.round(bps) });
                bc.bytes = 0;
                bc.time = now;
            }
            bc.bytes += data.length;

            // Stream dump
            if (streamDumpSizeRef.current < MAX_DUMP) {
                streamDumpRef.current.push(data);
                streamDumpSizeRef.current += data.length;
            }

            // --- Initial info handling (buffered) ---
            // The scrcpy_initial message is sent as the FIRST bytes after connect, but
            // TCP may split it across several WS messages, so accumulate until we can
            // parse the header. Never attempt to decode video from it.
            if (!hasInitialInfo.current) {
                const pending = pendingInitialInfo.current;
                const combined = new Uint8Array(pending.length + data.length);
                combined.set(pending);
                combined.set(data, pending.length);
                pendingInitialInfo.current = combined;

                const parsed = tryParseInitialInfo(combined);
                if (!parsed) {
                    if (DEV_MODE && combined.length < 1024) {
                        console.log(`[MirrorView] Buffering initial info (${combined.length} bytes), waiting for more`);
                        // Once we have enough bytes that parsing should succeed, dump the
                        // head of the message so the wire format is visible (a real device
                        // name shows up as printable ASCII here; zeros/garbage mean the
                        // server sends a different format).
                        if (combined.length >= MAGIC_BYTES_INITIAL.length + DEVICE_NAME_LENGTH) {
                            console.warn('[WS] First msg hex:', hexPreview(combined, 32));
                        }
                    }
                    return;
                }

                hasInitialInfo.current = true;
                pendingInitialInfo.current = new Uint8Array(0);
                updateStats({ deviceName: parsed.deviceName });
                if (DEV_MODE) console.log(`[WS] initial info parsed: device="${parsed.deviceName}" ${parsed.width}x${parsed.height}`);

                const player = playerRef.current;
                if (player && parsed.width > 0 && parsed.height > 0) {
                    player.setScreenInfo(new ScreenInfo(
                        new Rect(0, 0, parsed.width, parsed.height),
                        new Size(parsed.width, parsed.height),
                        parsed.rotation,
                    ));
                }

                // Everything after the parsed header is the tail of the initial info
                // (encoder list + client id). Feed it to the player — the stream parser
                // drops it gracefully until real NAL start codes arrive.
                const tail = combined.subarray(parsed.consumed);
                if (tail.length > 0 && player && player.getState() === BasePlayer.STATE.PLAYING) {
                    player.pushFrame(tail);
                }
                return;
            }

            // Handle scrcpy_message (device messages — clipboard etc., ignored here)
            if (matchMagic(data, MAGIC_BYTES_MESSAGE)) {
                if (DEV_MODE) console.log(`[MirrorView] MESSAGE (ignored): ${data.length} bytes`);
                return;
            }

            if (DEV_MODE) console.log(`[MirrorView] WS message: ${data.length} bytes, hex=[${hexPreview(data, 24)}]`);

            // Feed to player
            const player = playerRef.current;
            if (player && player.getState() === BasePlayer.STATE.PLAYING) {
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
    }, [updateStats]);

    // Recording controls (used by the toolbar Record button in App.tsx)
    useImperativeHandle(ref, () => ({
        startRecording(): boolean {
            const player = playerRef.current;
            if (!player || recordingRef.current.isActive()) return false;
            const screenInfo = player.getScreenInfo();
            const width = screenInfo?.videoSize.width ?? 0;
            const height = screenInfo?.videoSize.height ?? 0;
            if (!width || !height) return false;

            recordingRef.current.start(width, height);
            if (player instanceof WebCodecsPlayer) {
                player.onEncodedChunk = (chunk, isKey, description) => {
                    recordingRef.current.addVideoChunk(chunk, isKey, description);
                };
            } else if (player instanceof MsePlayer) {
                player.onSample = (data, isKey, timestamp) => {
                    recordingRef.current.addRawNal(data, isKey, timestamp);
                };
            }
            if (DEV_MODE) console.log(`[MirrorView] Recording started ${width}x${height}`);
            return true;
        },
        stopRecording(): ArrayBuffer | null {
            const player = playerRef.current;
            if (player instanceof WebCodecsPlayer) {
                player.onEncodedChunk = null;
            } else if (player instanceof MsePlayer) {
                player.onSample = null;
            }
            return recordingRef.current.stop();
        },
    }), []);

    useEffect(() => {
        if (!deviceId || !containerRef.current) return;
        const container = containerRef.current;

        detectPlayers();

        let player: BasePlayer;
        try {
            player = selectPlayer('webcodecs', deviceId);
        } catch (e: any) {
            console.error('[MirrorView] No player available:', e.message);
            updateStats({ decoderState: 'error', playerName: e.message });
            return;
        }
        playerRef.current = player;
        hasInitialInfo.current = false;
        pendingInitialInfo.current = new Uint8Array(0);

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
        setupWsHandlers(ws);

        const diagInterval = setInterval(collectDiagnostics, 500);

        return () => {
            if (DEV_MODE) console.log('[MirrorView] Cleanup');
            clearInterval(diagInterval);
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
    }, [deviceId, wsUrl]);

    const handleControlMessage = useCallback((msg: ControlMessage) => {
        const ws = socketRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(msg.toBuffer());
        }
    }, []);

    const nalTypes: { type: number; name: string; count: number }[] = [];
    for (const [typeStr, count] of Object.entries(diagnostics.nalCounts)) {
        const type = parseInt(typeStr);
        const names: Record<number, string> = { 1: 'P', 5: 'IDR', 6: 'SEI', 7: 'SPS', 8: 'PPS', 9: 'AUD' };
        nalTypes.push({ type, name: names[type] || `U${type}`, count });
    }
    nalTypes.sort((a, b) => b.count - a.count);

    const playerIndicator = players.map(p => (
        <span
            key={p.codeName}
            className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium mr-1 cursor-pointer ${
                p.codeName === activeCodeName
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                    : p.supported
                    ? 'bg-slate-700/50 text-slate-400 hover:bg-slate-600/50'
                    : 'bg-red-900/20 text-red-400 line-through'
            }`}
            onClick={() => {
                if (p.supported && p.codeName !== activeCodeName) {
                    switchPlayer(p.codeName);
                }
            }}
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

            {showDiagnostics && (
            <div className="absolute left-4 top-4 z-50 w-80 rounded-2xl bg-slate-950/90 border border-white/10 p-3 text-xs text-white shadow-2xl font-mono">
                <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-semibold">Stream Diagnostics</span>
                    <div className="flex items-center gap-1">
                        <span className={`w-2 h-2 rounded-full ${stats.wsState === 'open' ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                    </div>
                </div>

                <div className="mb-2 flex flex-wrap gap-1">
                    {playerIndicator}
                </div>

                <div className="grid grid-cols-2 gap-1.5 mb-1.5">
                    <div className="rounded-lg bg-slate-900/90 p-1.5 border border-white/10">
                        <div className="text-[10px] uppercase text-slate-500">WS</div>
                        <div className={`text-xs font-medium ${statusColor}`}>{stats.wsState}</div>
                    </div>
                    <div className="rounded-lg bg-slate-900/90 p-1.5 border border-white/10">
                        <div className="text-[10px] uppercase text-slate-500">Decode</div>
                        <div className={`text-xs font-medium ${decoderColor}`}>{diagnostics.configured ? '✓' : '…'}</div>
                    </div>
                    <div className="rounded-lg bg-slate-900/90 p-1.5 border border-white/10">
                        <div className="text-[10px] uppercase text-slate-500">Canvas</div>
                        <div className="text-xs font-medium">{diagnostics.canvasWidth > 0 ? `${diagnostics.canvasWidth}x${diagnostics.canvasHeight}` : '—'}</div>
                    </div>
                    <div className="rounded-lg bg-slate-900/90 p-1.5 border border-white/10">
                        <div className="text-[10px] uppercase text-slate-500">KB/s</div>
                        <div className="text-xs font-medium">{(stats.bytesPerSec / 1024).toFixed(1)}</div>
                    </div>
                </div>

                <div className="grid grid-cols-4 gap-1 mb-1.5">
                    <div className="text-center">
                        <div className="text-[9px] text-slate-500">SPS</div>
                        <div className="text-xs font-bold text-blue-400">{diagnostics.spsCount}</div>
                    </div>
                    <div className="text-center">
                        <div className="text-[9px] text-slate-500">PPS</div>
                        <div className="text-xs font-bold text-purple-400">{diagnostics.ppsCount}</div>
                    </div>
                    <div className="text-center">
                        <div className="text-[9px] text-slate-500">IDR</div>
                        <div className="text-xs font-bold text-green-400">{diagnostics.idrCount}</div>
                    </div>
                    <div className="text-center">
                        <div className="text-[9px] text-slate-500">NAL</div>
                        <div className="text-xs font-bold text-amber-400">{diagnostics.totalNals}</div>
                    </div>
                </div>

                <div className="mb-1.5 flex flex-wrap gap-1">
                    {nalTypes.slice(0, 6).map(nt => (
                        <span key={nt.type} className="text-[9px] px-1 py-0.5 rounded bg-slate-800 text-slate-400">
                            {nt.name}:{nt.count}
                        </span>
                    ))}
                </div>

                <div className="text-[10px] space-y-0.5 text-slate-400">
                    <div>{stats.deviceName || 'Connecting…'} | Codec: {diagnostics.codec || '—'}</div>
                    <div>Decodes: {diagnostics.decodeCount} | Errors: {diagnostics.decodeErrors}</div>
                    <div>Frames: {stats.framesDecoded} | KB: {(stats.receivedBytes / 1024).toFixed(1)}</div>
                </div>

                <div className="mt-2 flex gap-1">
                    <button
                        onClick={downloadStreamDump}
                        className="text-[9px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 disabled:opacity-30"
                        disabled={streamDumpSizeRef.current === 0}
                    >
                        Download debug-stream.h264
                    </button>
                </div>
            </div>
            )}
        </div>
    );
});
