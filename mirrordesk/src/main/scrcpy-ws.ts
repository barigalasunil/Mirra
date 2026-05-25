import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'child_process';
import net from 'net';
import fs from 'fs';
import { EventEmitter } from 'events';

export interface ScrcpyDebugEvent {
    category: 'ADB' | 'SERVER' | 'SOCKET' | 'WEBSOCKET' | 'STREAM' | 'DECODER' | 'CONTROL';
    message: string;
    detail?: Record<string, any>;
}

export class ScrcpyWsManager extends EventEmitter {
    private wss: WebSocketServer;
    private clients: Set<WebSocket> = new Set();
    private videoSocket: net.Socket | null = null;
    private controlSocket: net.Socket | null = null;
    private forwardedBytes = 0;
    private forwardedPackets = 0;
    private serverProcess: any = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private reconnectAttempts = 0;
    private forwardPort = 27183;
    private readonly adbPath: string;
    private readonly serverBinaryPath: string;

    constructor(port: number = 8080, adbPath: string, serverBinaryPath: string) {
        super();
        this.adbPath = adbPath;
        this.serverBinaryPath = serverBinaryPath;
        this.wss = new WebSocketServer({ port });
        this.setupWebSocketServer();
        this.wss.on('listening', () => {
            this.reportDebug({ category: 'WEBSOCKET', message: `WebSocket server listening on port ${port}` });
        });
        this.wss.on('error', (err) => {
            this.reportDebug({ category: 'WEBSOCKET', message: `WebSocket server error: ${err.message}` });
        });
    }

    private setupWebSocketServer() {
        this.wss.on('connection', (ws) => {
            this.clients.add(ws);
            this.reportDebug({ category: 'WEBSOCKET', message: 'WebSocket client connected', detail: { clients: this.clients.size } });

            ws.on('close', () => {
                this.clients.delete(ws);
                this.reportDebug({ category: 'WEBSOCKET', message: 'WebSocket client disconnected', detail: { clients: this.clients.size } });
            });

            ws.on('message', (msg) => {
                // Handle text messages (ping/pong)
                if (typeof msg === 'string' || typeof (msg as any) === 'string') {
                    try {
                        const text = JSON.parse(msg.toString());
                        if (text?.type === 'ping') {
                            ws.send(JSON.stringify({ type: 'pong', ts: text.ts }));
                        }
                        return;
                    } catch {
                        // ignore non-JSON text
                    }
                    return;
                }

                // Forward binary control messages to the device control socket
                const buf = msg as Buffer;
                if (this.controlSocket && !this.controlSocket.destroyed) {
                    this.controlSocket.write(buf);
                    this.reportDebug({ category: 'CONTROL', message: 'Forwarded control message to device', detail: { bytes: buf.length } });
                } else {
                    this.reportDebug({ category: 'CONTROL', message: 'Control socket not available, dropping message', detail: { bytes: buf.length } });
                }
            });
        });
    }

    private reportDebug(event: ScrcpyDebugEvent) {
        console.log(`[ScrcpyWsManager][${event.category}] ${event.message}`, event.detail || '');
        this.emit('debug', event);
    }

    private runAdbCommand(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const proc = spawn(this.adbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', (chunk) => stdout += chunk.toString());
            proc.stderr.on('data', (chunk) => stderr += chunk.toString());
            proc.on('close', (code) => {
                if (code === 0) resolve(stdout.trim());
                else reject(new Error(stderr.trim() || stdout.trim() || `adb exited ${code}`));
            });
        });
    }

    private async pushServer(deviceId: string) {
        if (!fs.existsSync(this.serverBinaryPath)) {
            throw new Error(`scrcpy server binary not found at ${this.serverBinaryPath}`);
        }
        this.reportDebug({ category: 'ADB', message: 'Pushing scrcpy-server.jar to device', detail: { deviceId } });
        await this.runAdbCommand(['-s', deviceId, 'push', this.serverBinaryPath, '/data/local/tmp/scrcpy-server.jar']);
        this.reportDebug({ category: 'ADB', message: 'Server push complete' });
    }

    private async setupForward(deviceId: string) {
        this.reportDebug({ category: 'ADB', message: 'Setting up ADB forward', detail: { port: this.forwardPort } });
        await this.runAdbCommand(['-s', deviceId, 'forward', '--remove', `tcp:${this.forwardPort}`]).catch(() => {});
        await this.runAdbCommand(['-s', deviceId, 'forward', `tcp:${this.forwardPort}`, 'localabstract:scrcpy']);
        this.reportDebug({ category: 'ADB', message: 'ADB forward created', detail: { port: this.forwardPort } });
    }

    private startServerProcess(deviceId: string, settings: any) {
        const args = [
            '-s', deviceId,
            'shell',
            'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
            'app_process', '/', 'com.genymobile.scrcpy.Server',
            '2.4',
            'log_level=debug',
            'max_size=1920',
            'bit_rate=8000000',
            'max_fps=60',
            'tunnel_forward=true',
            'control=true',
            'raw_stream=true',
        ];

        if (settings?.maxSize) args.push(`max_size=${settings.maxSize}`);
        if (settings?.videoBitrate) {
            const br = typeof settings.videoBitrate === 'string'
                ? parseInt(settings.videoBitrate.replace(/[^0-9]/g, ''), 10) * (settings.videoBitrate.includes('M') ? 1000000 : 1000)
                : settings.videoBitrate;
            args.push(`bit_rate=${br}`);
        }
        if (settings?.maxFps) args.push(`max_fps=${settings.maxFps}`);

        this.reportDebug({ category: 'SERVER', message: 'Starting scrcpy server', detail: { args } });
        this.serverProcess = spawn(this.adbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

        this.serverProcess.stdout.on('data', (chunk: Buffer) => {
            const lines = chunk.toString().split('\n').filter(l => l.trim());
            for (const line of lines) {
                this.reportDebug({ category: 'SERVER', message: line });
            }
        });
        this.serverProcess.stderr.on('data', (chunk: Buffer) => {
            const lines = chunk.toString().split('\n').filter(l => l.trim());
            for (const line of lines) {
                this.reportDebug({ category: 'SERVER', message: `stderr: ${line}` });
            }
        });
        this.serverProcess.on('exit', (code: number) => {
            this.reportDebug({ category: 'SERVER', message: `Server exited with code ${code}` });
            this.cleanupSockets();
            this.scheduleReconnect();
        });
    }

    private connectVideoSocket() {
        if (this.videoSocket) {
            this.videoSocket.destroy();
            this.videoSocket = null;
        }
        this.forwardedBytes = 0;
        this.forwardedPackets = 0;

        this.reportDebug({ category: 'SOCKET', message: 'Connecting video socket', detail: { port: this.forwardPort } });
        this.videoSocket = net.connect({ port: this.forwardPort, host: '127.0.0.1' });

        this.videoSocket.on('connect', () => {
            this.reportDebug({ category: 'SOCKET', message: 'Video socket connected' });
            this.reconnectAttempts = 0;
            // Connect control socket now that video is established.
            // The server accepts video first, then control.
            this.connectControlSocket();
        });

        this.videoSocket.on('data', (data) => {
            if (!data.length) return;
            this.forwardedBytes += data.length;
            this.forwardedPackets += 1;

            // Forward raw H264 data directly (no 64-byte header with raw_stream=true)
            this.broadcast(data);

            if (this.forwardedPackets % 100 === 0) {
                this.reportDebug({
                    category: 'STREAM',
                    message: 'Forwarding video',
                    detail: { packets: this.forwardedPackets, bytes: this.forwardedBytes },
                });
            }
            if (this.forwardedPackets <= 10) {
                this.reportDebug({
                    category: 'STREAM',
                    message: 'H264 data preview',
                    detail: {
                        idx: this.forwardedPackets,
                        size: data.length,
                        hex: data.slice(0, Math.min(32, data.length)).toString('hex'),
                    },
                });
            }
        });

        this.videoSocket.on('error', (err) => {
            this.reportDebug({ category: 'SOCKET', message: `Video socket error: ${err.message}` });
            this.videoSocket = null;
            this.scheduleReconnect();
        });

        this.videoSocket.on('close', () => {
            this.reportDebug({ category: 'SOCKET', message: 'Video socket closed' });
            this.videoSocket = null;
            this.scheduleReconnect();
        });
    }

    private connectControlSocket() {
        if (this.controlSocket) {
            this.controlSocket.destroy();
            this.controlSocket = null;
        }

        this.reportDebug({ category: 'SOCKET', message: 'Connecting control socket', detail: { port: this.forwardPort } });
        this.controlSocket = net.connect({ port: this.forwardPort, host: '127.0.0.1' });

        this.controlSocket.on('connect', () => {
            this.reportDebug({ category: 'SOCKET', message: 'Control socket connected' });
        });

        this.controlSocket.on('data', (data) => {
            this.reportDebug({ category: 'CONTROL', message: 'Received data on control socket', detail: { size: data.length } });
        });

        this.controlSocket.on('error', (err) => {
            this.reportDebug({ category: 'SOCKET', message: `Control socket error: ${err.message}` });
            this.controlSocket = null;
        });

        this.controlSocket.on('close', () => {
            this.reportDebug({ category: 'SOCKET', message: 'Control socket closed' });
            this.controlSocket = null;
        });
    }

    private cleanupSockets() {
        if (this.videoSocket) {
            this.videoSocket.destroy();
            this.videoSocket = null;
        }
        if (this.controlSocket) {
            this.controlSocket.destroy();
            this.controlSocket = null;
        }
    }

    private scheduleReconnect() {
        if (this.reconnectTimer || this.reconnectAttempts >= 5) return;
        this.reconnectAttempts += 1;
        const attempt = this.reconnectAttempts;
        this.reportDebug({ category: 'SOCKET', message: `Scheduling reconnect attempt ${attempt}` });
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.serverProcess && !this.serverProcess.killed) {
                this.connectVideoSocket();
            }
        }, 1500);
    }

    public async start(deviceId: string, settings: any) {
        this.stop();
        try {
            await this.pushServer(deviceId);
            await this.setupForward(deviceId);
            this.startServerProcess(deviceId, settings);
            // Give server time to start and create LocalServerSocket
            await new Promise(r => setTimeout(r, 800));
            this.connectVideoSocket();
        } catch (err: any) {
            this.reportDebug({ category: 'ADB', message: `Failed to start stream: ${err.message}` });
            throw err;
        }
    }

    public stop() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectAttempts = 0;
        this.cleanupSockets();
        if (this.serverProcess) {
            this.serverProcess.kill();
            this.serverProcess = null;
        }
        this.forwardedBytes = 0;
        this.forwardedPackets = 0;
    }

    private broadcast(data: Buffer) {
        this.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        });
    }
}
