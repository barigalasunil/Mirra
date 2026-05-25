"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachScrcpy = attachScrcpy;
exports.updateScrcpyBounds = updateScrcpyBounds;
const koffi_1 = __importDefault(require("koffi"));
const user32 = koffi_1.default.load('user32.dll');
// Define HWND as a pointer
const HWND = koffi_1.default.pointer('HWND', koffi_1.default.types.void);
const FindWindowA = user32.func('__stdcall', 'FindWindowA', HWND, ['str', 'str']);
const SetParent = user32.func('__stdcall', 'SetParent', HWND, [HWND, HWND]);
const MoveWindow = user32.func('__stdcall', 'MoveWindow', 'bool', [HWND, 'int', 'int', 'int', 'int', 'bool']);
const SetWindowLongA = user32.func('__stdcall', 'SetWindowLongA', 'long', [HWND, 'int', 'long']);
const GetWindowLongA = user32.func('__stdcall', 'GetWindowLongA', 'long', [HWND, 'int']);
const GWL_STYLE = -16;
const WS_POPUP = 0x80000000;
const WS_CAPTION = 0x00C00000;
const WS_THICKFRAME = 0x00040000;
const WS_CHILD = 0x40000000;
async function attachScrcpy(parentBuffer, windowTitle, rect) {
    // Wait until scrcpy window is created
    let childHwnd = null;
    let attempts = 0;
    while (!childHwnd && attempts < 50) { // 5 seconds wait
        childHwnd = FindWindowA(null, windowTitle);
        if (!childHwnd) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }
    }
    if (!childHwnd) {
        console.error('Could not find scrcpy window to attach');
        return false;
    }
    // Change style to child window and strip borders
    let style = GetWindowLongA(childHwnd, GWL_STYLE);
    // Remove popup, caption, thickframe
    style = style & ~WS_POPUP & ~WS_CAPTION & ~WS_THICKFRAME;
    // Add child style
    style = style | WS_CHILD;
    SetWindowLongA(childHwnd, GWL_STYLE, style);
    // Set parent directly with the buffer
    SetParent(childHwnd, parentBuffer);
    // Move it to match the view internally
    MoveWindow(childHwnd, rect.x, rect.y, rect.w, rect.h, true);
    return childHwnd;
}
function updateScrcpyBounds(childHwnd, rect) {
    if (childHwnd) {
        MoveWindow(childHwnd, rect.x, rect.y, rect.w, rect.h, true);
    }
}
