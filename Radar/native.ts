/*
 * Radar – runs in the Electron main process
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, IpcMainInvokeEvent } from "electron";

/** Windows already waiting for "focus" (otherwise listeners pile up) */
const waiting = new WeakSet<BrowserWindow>();

/**
 * Flash the taskbar icon until the window regains focus.
 * If Discord currently has focus, nothing happens.
 */
export function flashFrame(event: IpcMainInvokeEvent) {
    const own = BrowserWindow.fromWebContents(event.sender);
    const windows = own ? [own] : BrowserWindow.getAllWindows();
    let flashed = false;

    for (const win of windows) {
        if (!win || win.isDestroyed() || win.isFocused()) continue;
        win.flashFrame(true);
        flashed = true;

        if (!waiting.has(win)) {
            waiting.add(win);
            win.once("focus", () => {
                waiting.delete(win);
                if (!win.isDestroyed()) win.flashFrame(false);
            });
        }
    }
    return flashed;
}

/** Stop flashing immediately (e.g. when the plugin is disabled) */
export function stopFlash(event: IpcMainInvokeEvent) {
    const own = BrowserWindow.fromWebContents(event.sender);
    for (const win of own ? [own] : BrowserWindow.getAllWindows()) {
        if (win && !win.isDestroyed()) win.flashFrame(false);
    }
}
