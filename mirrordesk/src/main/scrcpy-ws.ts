import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'child_process';
import net from 'net';
import fs from 'fs';
import { EventEmitter } from 'events';

export interface ScrcpyDebugEvent {
    category: 'ADB' | 'SERVER' | 'SOCKET' | 'WEBSOCKET' | 'STREAM' | 'CONTROL';
    message: string;
    detail?: Record<string, any>;
}

export class ScrcpyWsManager extends EventEmitter {
    private wss: WebSocketServer;
    private clients: Set<WebSocket> = new Set();
    private deviceSocket: net.Socket | null = null;
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
                if (typeof msg === 'string' || typeof (msg as any) === 'string') {
                    try {
                        const text = JSON.parse(msg.toString());
                        if (text?.type === 'ping') {
                            ws.send(JSON.stringify({ type: 'pong', ts: text.ts }));
                        }
                        return;
                    } catch { /* ignore */ }
                    return;
                }

                // Forward binary control messages to the device socket
                const buf = msg as Buffer;
                if (this.deviceSocket && !this.deviceSocket.destroyed) {
                    this.deviceSocket.write(buf);
                    this.reportDebug({ category: 'CONTROL', message: 'Forwarded control message', detail: { bytes: buf.length } });
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
        this.reportDebug({ category: 'ADB', message: 'Pushing scrcpy-server.jar', detail: { deviceId } });
        await this.runAdbCommand(['-s', deviceId, 'push', this.serverBinaryPath, '/data/local/tmp/scrcpy-server.jar']);
        this.reportDebug({ category: 'ADB', message: 'Server push complete' });
    }

    private async setupForward(deviceId: string) {
        this.reportDebug({ category: 'ADB', message: 'Setting up ADB forward', detail: { port: this.forwardPort } });
        await this.runAdbCommand(['-s', deviceId, 'forward', '--remove', `tcp:${this.forwardPort}`]).catch(() => {});
        // Forward to the ws-scrcpy server's TCP port 8886
        await this.runAdbCommand(['-s', deviceId, 'forward', `tcp:${this.forwardPort}`, 'tcp:8886']);
        this.reportDebug({ category: 'ADB', message: 'ADB forward created', detail: { port: this.forwardPort, remote: 'tcp:8886' } });
    }

    private startServerProcess(deviceId: string, _settings?: any) {
        // ws-scrcpy forked server arguments: version type log_level port listenAll
        const args = [
            '-s', deviceId,
            'shell',
            'CLASSPATH=/data/local/tmp/scrcpy-server.jar',
            'nohup', 'app_process',
            '/', 'com.genymobile.scrcpy.Server',
            '1.19-ws7',
            'web',
            'ERROR',
            '8886',
            'false',
        ];

        this.reportDebug({ category: 'SERVER', message: 'Starting ws-scrcpy server', detail: { args } });
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
            this.cleanupSocket();
            this.scheduleReconnect();
        });
    }

    private connectDeviceSocket() {
        if (this.deviceSocket) {
            this.deviceSocket.destroy();
            this.deviceSocket = null;
        }
        this.forwardedBytes = 0;
        this.forwardedPackets = 0;

        this.reportDebug({ category: 'SOCKET', message: 'Connecting device socket', detail: { port: this.forwardPort } });
        this.deviceSocket = net.connect({ port: this.forwardPort, host: '127.0.0.1' });

        this.deviceSocket.on('connect', () => {
            this.reportDebug({ category: 'SOCKET', message: 'Device socket connected' });
            this.reconnectAttempts = 0;
        });

        this.deviceSocket.on('data', (data) => {
            if (!data.length) return;
            this.forwardedBytes += data.length;
            this.forwardedPackets += 1;

            // Forward raw data as-is. The ws-scrcpy server sends:
            //   1. scrcpy_initial magic bytes + device/displays metadata (first message)
            //   2. scrcpy_message magic bytes for clipboard/push responses
            //   3. Raw H264 NAL units with Annex B start codes (0x00 0x00 0x00 0x01)
            this.broadcast(data);

            if (this.forwardedPackets % 100 === 0) {
                this.reportDebug({
                    category: 'STREAM',
                    message: 'Forwarding data',
                    detail: { packets: this.forwardedPackets, bytes: this.forwardedBytes },
                });
            }
            if (this.forwardedPackets <= 5) {
                this.reportDebug({
                    category: 'STREAM',
                    message: 'Data preview',
                    detail: {
                        idx: this.forwardedPackets,
                        size: data.length,
                        hex: data.slice(0, Math.min(48, data.length)).toString('hex'),
                    },
                });
            }
        });

        this.deviceSocket.on('error', (err) => {
            this.reportDebug({ category: 'SOCKET', message: `Device socket error: ${err.message}` });
            this.deviceSocket = null;
            this.scheduleReconnect();
        });

        this.deviceSocket.on('close', () => {
            this.reportDebug({ category: 'SOCKET', message: 'Device socket closed' });
            this.deviceSocket = null;
            this.scheduleReconnect();
        });
    }

    private cleanupSocket() {
        if (this.deviceSocket) {
            this.deviceSocket.destroy();
            this.deviceSocket = null;
        }
    }

    private scheduleReconnect() {
        if (this.reconnectTimer || this.reconnectAttempts >= 5) return;
        this.reconnectAttempts += 1;
        this.reportDebug({ category: 'SOCKET', message: `Scheduling reconnect attempt ${this.reconnectAttempts}` });
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.serverProcess && !this.serverProcess.killed) {
                this.connectDeviceSocket();
            }
        }, 1500);
    }

    public async start(deviceId: string, _settings?: any) {
        this.stop();
        try {
            await this.pushServer(deviceId);
            await this.setupForward(deviceId);
            this.startServerProcess(deviceId, _settings);
            await new Promise(r => setTimeout(r, 1000));
            this.connectDeviceSocket();
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
        this.cleanupSocket();
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
