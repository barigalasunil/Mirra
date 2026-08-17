import path from 'path';
import { app } from 'electron';
import fs from 'fs';
import { spawn } from 'child_process';
import type { IosDevice } from '../shared/types';

export function getPymobiledevicePath(): string {
    // Dev mode: resolve from project root
    // Packaged: resolve from app resources
    const base = app.isPackaged
        ? process.resourcesPath
        : path.join(__dirname, '..', '..', 'resources');
    return path.join(base, 'ios', 'pymobiledevice3.exe');
}

export function getIosResourcesPath(): string {
    const base = app.isPackaged
        ? process.resourcesPath
        : path.join(__dirname, '..', '..', 'resources');
    return path.join(base, 'ios');
}

export function isPymobiledeviceInstalled(): boolean {
    return fs.existsSync(getPymobiledevicePath());
}

// Helper: run pymobiledevice3 with args, return stdout as string
// Throws if exit code != 0
export async function runPmd3(args: string[]): Promise<string> {
    const binPath = getPymobiledevicePath();

    return new Promise((resolve, reject) => {
        const proc = spawn(binPath, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d: Buffer) => stdout += d.toString());
        proc.stderr.on('data', (d: Buffer) => stderr += d.toString());
        proc.on('close', (code: number) => {
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(`pymobiledevice3 exit ${code}: ${stderr.trim()}`));
        });
        proc.on('error', (err: Error) => reject(err));
    });
}

// List connected iOS devices (USB only for now).
// Output of `pymobiledevice3 usbmux list` is a JSON array like:
//   [ { "Identifier": "abc123", "DeviceName": "John's iPhone",
//       "ProductType": "iPhone16,2", "ProductVersion": "17.4" } ]
export async function listIosDevices(): Promise<IosDevice[]> {
    if (!isPymobiledeviceInstalled()) {
        // Binary not present — return empty silently, no error log.
        return [];
    }
    try {
        const raw = await runPmd3(['usbmux', 'list']);
        // output may have log lines before JSON — find the JSON array
        const jsonStart = raw.indexOf('[');
        const jsonEnd = raw.lastIndexOf(']');
        if (jsonStart === -1) return [];
        const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
        return parsed.map((d: any) => ({
            udid: d.Identifier ?? d.udid ?? '',
            name: d.DeviceName ?? d.name ?? 'iPhone',
            productType: d.ProductType ?? '',
            iosVersion: d.ProductVersion ?? d.iosVersion ?? '',
        }));
    } catch (err) {
        console.error('[iOS] listIosDevices error:', err);
        return [];
    }
}

// Take a screenshot of the given iOS device.
// iOS 17+ / Developer Mode path first, iOS 14-16 fallback.
export async function takeIosScreenshot(
    udid: string,
    outputPath: string
): Promise<void> {
    try {
        await runPmd3(['developer', 'dvt', 'screenshot',
            '--udid', udid, outputPath]);
    } catch {
        // iOS 14-16 fallback
        await runPmd3(['developer', 'screenshot', '--udid', udid, outputPath]);
    }
}
