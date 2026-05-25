"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScrcpyWsManager = void 0;
const ws_1 = require("ws");
const child_process_1 = require("child_process");
const net_1 = __importDefault(require("net"));
const fs_1 = __importDefault(require("fs"));
const events_1 = require("events");
class ScrcpyWsManager extends events_1.EventEmitter {
    wss;
    clients = new Set();
    deviceSocket = null;
    forwardedBytes = 0;
    forwardedPackets = 0;
    serverProcess = null;
    reconnectTimer = null;
    reconnectAttempts = 0;
    forwardPort = 27183;
    adbPath;
    serverBinaryPath;
    constructor(port = 8080, adbPath, serverBinaryPath) {
        super();
        this.adbPath = adbPath;
        this.serverBinaryPath = serverBinaryPath;
        this.wss = new ws_1.WebSocketServer({ port });
        this.setupWebSocketServer();
        this.wss.on('listening', () => {
            this.reportDebug({ category: 'WEBSOCKET', message: `WebSocket server listening on port ${port}` });
        });
        this.wss.on('error', (err) => {
            this.reportDebug({ category: 'WEBSOCKET', message: `WebSocket server error: ${err.message}` });
        });
    }
    setupWebSocketServer() {
        this.wss.on('connection', (ws) => {
            this.clients.add(ws);
            this.reportDebug({ category: 'WEBSOCKET', message: 'WebSocket client connected', detail: { clients: this.clients.size } });
            ws.on('close', () => {
                this.clients.delete(ws);
                this.reportDebug({ category: 'WEBSOCKET', message: 'WebSocket client disconnected', detail: { clients: this.clients.size } });
            });
            ws.on('message', (msg) => {
                if (typeof msg === 'string' || typeof msg === 'string') {
                    try {
                        const text = JSON.parse(msg.toString());
                        if (text?.type === 'ping') {
                            ws.send(JSON.stringify({ type: 'pong', ts: text.ts }));
                        }
                        return;
                    }
                    catch { /* ignore */ }
                    return;
                }
                // Forward binary control messages to the device socket
                const buf = msg;
                if (this.deviceSocket && !this.deviceSocket.destroyed) {
                    this.deviceSocket.write(buf);
                    this.reportDebug({ category: 'CONTROL', message: 'Forwarded control message', detail: { bytes: buf.length } });
                }
            });
        });
    }
    reportDebug(event) {
        console.log(`[ScrcpyWsManager][${event.category}] ${event.message}`, event.detail || '');
        this.emit('debug', event);
    }
    runAdbCommand(args) {
        return new Promise((resolve, reject) => {
            const proc = (0, child_process_1.spawn)(this.adbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', (chunk) => stdout += chunk.toString());
            proc.stderr.on('data', (chunk) => stderr += chunk.toString());
            proc.on('close', (code) => {
                if (code === 0)
                    resolve(stdout.trim());
                else
                    reject(new Error(stderr.trim() || stdout.trim() || `adb exited ${code}`));
            });
        });
    }
    async pushServer(deviceId) {
        if (!fs_1.default.existsSync(this.serverBinaryPath)) {
            throw new Error(`scrcpy server binary not found at ${this.serverBinaryPath}`);
        }
        this.reportDebug({ category: 'ADB', message: 'Pushing scrcpy-server.jar', detail: { deviceId } });
        await this.runAdbCommand(['-s', deviceId, 'push', this.serverBinaryPath, '/data/local/tmp/scrcpy-server.jar']);
        this.reportDebug({ category: 'ADB', message: 'Server push complete' });
    }
    async setupForward(deviceId) {
        this.reportDebug({ category: 'ADB', message: 'Setting up ADB forward', detail: { port: this.forwardPort } });
        await this.runAdbCommand(['-s', deviceId, 'forward', '--remove', `tcp:${this.forwardPort}`]).catch(() => { });
        // Forward to the ws-scrcpy server's TCP port 8886
        await this.runAdbCommand(['-s', deviceId, 'forward', `tcp:${this.forwardPort}`, 'tcp:8886']);
        this.reportDebug({ category: 'ADB', message: 'ADB forward created', detail: { port: this.forwardPort, remote: 'tcp:8886' } });
    }
    startServerProcess(deviceId, _settings) {
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
        this.serverProcess = (0, child_process_1.spawn)(this.adbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.serverProcess.stdout.on('data', (chunk) => {
            const lines = chunk.toString().split('\n').filter(l => l.trim());
            for (const line of lines) {
                this.reportDebug({ category: 'SERVER', message: line });
            }
        });
        this.serverProcess.stderr.on('data', (chunk) => {
            const lines = chunk.toString().split('\n').filter(l => l.trim());
            for (const line of lines) {
                this.reportDebug({ category: 'SERVER', message: `stderr: ${line}` });
            }
        });
        this.serverProcess.on('exit', (code) => {
            this.reportDebug({ category: 'SERVER', message: `Server exited with code ${code}` });
            this.cleanupSocket();
            this.scheduleReconnect();
        });
    }
    connectDeviceSocket() {
        if (this.deviceSocket) {
            this.deviceSocket.destroy();
            this.deviceSocket = null;
        }
        this.forwardedBytes = 0;
        this.forwardedPackets = 0;
        this.reportDebug({ category: 'SOCKET', message: 'Connecting device socket', detail: { port: this.forwardPort } });
        this.deviceSocket = net_1.default.connect({ port: this.forwardPort, host: '127.0.0.1' });
        this.deviceSocket.on('connect', () => {
            this.reportDebug({ category: 'SOCKET', message: 'Device socket connected' });
            this.reconnectAttempts = 0;
        });
        this.deviceSocket.on('data', (data) => {
            if (!data.length)
                return;
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
    cleanupSocket() {
        if (this.deviceSocket) {
            this.deviceSocket.destroy();
            this.deviceSocket = null;
        }
    }
    scheduleReconnect() {
        if (this.reconnectTimer || this.reconnectAttempts >= 5)
            return;
        this.reconnectAttempts += 1;
        this.reportDebug({ category: 'SOCKET', message: `Scheduling reconnect attempt ${this.reconnectAttempts}` });
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.serverProcess && !this.serverProcess.killed) {
                this.connectDeviceSocket();
            }
        }, 1500);
    }
    async start(deviceId, _settings) {
        this.stop();
        try {
            await this.pushServer(deviceId);
            await this.setupForward(deviceId);
            this.startServerProcess(deviceId, _settings);
            await new Promise(r => setTimeout(r, 1000));
            this.connectDeviceSocket();
        }
        catch (err) {
            this.reportDebug({ category: 'ADB', message: `Failed to start stream: ${err.message}` });
            throw err;
        }
    }
    stop() {
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
    broadcast(data) {
        this.clients.forEach((client) => {
            if (client.readyState === ws_1.WebSocket.OPEN) {
                client.send(data);
            }
        });
    }
}
exports.ScrcpyWsManager = ScrcpyWsManager;
