/*
 * OpSec – runs in the Electron main process
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, IpcMainInvokeEvent } from "electron";

/**
 * Capture protection: the Discord window appears blank/black in screenshots, screen recordings and
 * screen shares (including "entire screen").
 * Windows 10 (2004+) / Windows 11 / macOS.
 */
export function setContentProtection(event: IpcMainInvokeEvent, enabled: boolean) {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    win.setContentProtection(enabled);
    return true;
}

/**
 * Scam/phishing blocklist (one domain per line). Discord-AntiScam, maintained daily.
 * The URL is hardcoded here so the renderer cannot make us fetch arbitrary pages.
 */
const SCAM_LIST_URL = "https://raw.githubusercontent.com/Discord-AntiScam/scam-links/main/list.txt";
const MAX_SIZE = 8 * 1024 * 1024;

/** Fetches the blocklist. Returns null if anything goes wrong (no network, error page, too large …). */
export async function fetchScamBlocklist(_: IpcMainInvokeEvent): Promise<string | null> {
    try {
        const res = await fetch(SCAM_LIST_URL, { signal: AbortSignal.timeout(20_000), cache: "no-store" });
        if (!res.ok) return null;
        const text = await res.text();
        return text.length > MAX_SIZE ? null : text;
    } catch {
        return null;
    }
}
