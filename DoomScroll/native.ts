/*
 * DoomScroll – runs in the Electron main process
 * TikTok, YouTube and Instagram refuse to be framed (X-Frame-Options / frame-ancestors) and Vencord owns the only
 * onHeadersReceived hook, so an <iframe> is out. A WebContentsView inside Discord's window loads but is never
 * painted there (stays visibilityState "hidden"), so the feed lives in a frameless child window that we keep
 * exactly on top of the chat area. It has its own persistent session, so logins survive restarts and never touch
 * Discord's session.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, IpcMainInvokeEvent, session, shell, WebContents } from "electron";

export interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ViewState {
    url: string;
    canGoBack: boolean;
    muted: boolean;
}

const PARTITION = "persist:vencord-doomscroll";
/** Sites allowed to open popups (logins); everything else opens in the normal browser */
const POPUP_HOSTS = /(^|\.)(tiktok\.com|youtube\.com|google\.com|instagram\.com|facebook\.com|apple\.com|twitter\.com|x\.com)$/;

const PAUSE_SCRIPT = "(() => { for (const v of document.querySelectorAll('video')) if (!v.paused) { v.dataset.vcDoomPaused = '1'; v.pause(); } })()";
const RESUME_SCRIPT = "(() => { for (const v of document.querySelectorAll('video[data-vc-doom-paused]')) { delete v.dataset.vcDoomPaused; v.play().catch(() => {}); } })()";

/**
 * There's no per-page volume in Electron, so we set it on the media elements. Re-applied whenever a video loads or
 * starts (the feeds create a new element per clip); the site's own volume control still works within a clip.
 */
const volumeScript = (volume: number) => `(() => {
    window.__vcDoomVolume = ${volume};
    if (!window.__vcDoomVolumeHooked) {
        window.__vcDoomVolumeHooked = true;
        const apply = e => {
            const m = e.target;
            if (m instanceof HTMLMediaElement && Math.abs(m.volume - window.__vcDoomVolume) > 0.005) m.volume = window.__vcDoomVolume;
        };
        for (const ev of ["loadedmetadata", "play"]) document.addEventListener(ev, apply, true);
    }
    for (const m of document.querySelectorAll("video, audio")) m.volume = ${volume};
})()`;

/** The feed window */
let feed: BrowserWindow | null = null;
/** Discord's window it sits on */
let parent: BrowserWindow | null = null;
/** Where the renderer wants the feed (window pixels, relative to Discord's content area), null = hidden */
let wanted: Bounds | null = null;
let shown = false;
let zoom = 1;
let volume = 1;
let pauseWhenHidden = true;

function userAgent() {
    // Some sites block or degrade "Electron" / "discord" user agents - pretend to be the matching Chrome
    const major = process.versions.chrome.split(".")[0];
    const os = process.platform === "darwin"
        ? "Macintosh; Intel Mac OS X 10_15_7"
        : process.platform === "linux" ? "X11; Linux x86_64" : "Windows NT 10.0; Win64; x64";
    return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const alive = () => feed && !feed.isDestroyed() ? feed : null;

// Discord's Electron (42) dropped webContents.get/setZoomFactor - use the zoomFactor property where they're gone
function getZoom(wc: WebContents) {
    try {
        return typeof wc.getZoomFactor === "function" ? wc.getZoomFactor() : (wc.zoomFactor || 1);
    } catch {
        return 1;
    }
}

function applyZoom(wc: WebContents, factor: number) {
    try {
        if (typeof wc.setZoomFactor === "function") wc.setZoomFactor(factor);
        else wc.zoomFactor = factor;
    } catch { }
}

// ---------------------------------------------------------------- Window

const parentEvents = {
    move: () => place(),
    resize: () => place(),
    maximize: () => place(),
    unmaximize: () => place(),
    restore: () => place(),
    show: () => place(),
    "enter-full-screen": () => place(),
    "leave-full-screen": () => place(),
    minimize: () => hideFeed(),
    hide: () => hideFeed(),
    closed: () => destroy()
} as const;

function bindParent(w: BrowserWindow | null) {
    if (parent && !parent.isDestroyed())
        for (const [ev, fn] of Object.entries(parentEvents)) parent.removeListener(ev as any, fn);
    parent = w;
    if (w)
        for (const [ev, fn] of Object.entries(parentEvents)) w.on(ev as any, fn);
}

function create(owner: BrowserWindow) {
    session.fromPartition(PARTITION).setUserAgent(userAgent());

    const w = new BrowserWindow({
        parent: owner,
        show: false,
        frame: false,
        thickFrame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: false,
        roundedCorners: false,
        backgroundColor: "#000000",
        title: "DoomScroll",
        webPreferences: {
            partition: PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            autoplayPolicy: "no-user-gesture-required"
        }
    });
    w.setMenu(null);

    const wc = w.webContents;
    wc.setWindowOpenHandler(({ url }) => {
        try {
            if (POPUP_HOSTS.test(new URL(url).hostname))
                return { action: "allow", overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true } };
        } catch { }
        if (/^https?:/i.test(url)) shell.openExternal(url);
        return { action: "deny" };
    });
    // Zoom is remembered per origin by Chromium - re-apply ours after every navigation
    wc.on("did-finish-load", () => applyZoom(wc, zoom));
    wc.on("dom-ready", () => wc.executeJavaScript(volumeScript(volume)).catch(() => { }));
    w.on("closed", () => {
        if (feed === w) {
            feed = null;
            shown = false;
        }
    });

    return w;
}

/** Puts the feed where the renderer wants it, or hides it */
function place() {
    const w = alive();
    if (!w) return;

    if (!wanted || !parent || parent.isDestroyed() || parent.isMinimized() || !parent.isVisible()) {
        hideFeed();
        return;
    }

    const content = parent.getContentBounds();
    w.setBounds({
        x: content.x + wanted.x,
        y: content.y + wanted.y,
        width: wanted.width,
        height: wanted.height
    });

    if (!shown) {
        shown = true;
        // Don't steal focus from Discord - the mouse wheel still scrolls the feed
        w.showInactive();
        w.webContents.executeJavaScript(RESUME_SCRIPT).catch(() => { });
    }
}

function hideFeed() {
    const w = alive();
    if (!w || !shown) return;
    shown = false;
    w.hide();
    if (pauseWhenHidden) w.webContents.executeJavaScript(PAUSE_SCRIPT).catch(() => { });
}

// ---------------------------------------------------------------- API (called from the renderer)

export function load(e: IpcMainInvokeEvent, url: string, zoomFactor: number, muted: boolean, vol: number, pause: boolean) {
    const owner = BrowserWindow.fromWebContents(e.sender);
    if (!owner) return false;

    if (alive() && parent !== owner) destroy();
    if (!alive()) {
        feed = create(owner);
        shown = false;
        bindParent(owner);
    }

    zoom = zoomFactor;
    volume = vol;
    pauseWhenHidden = pause;
    feed!.webContents.setAudioMuted(muted);
    feed!.webContents.loadURL(url).catch(() => { });
    return true;
}

export function hasView() {
    return !!alive();
}

/** null hides the feed. Bounds are CSS pixels of Discord's page. */
export function setBounds(e: IpcMainInvokeEvent, bounds: Bounds | null) {
    if (!bounds || bounds.width < 1 || bounds.height < 1) {
        wanted = null;
    } else {
        // Discord's own zoom (Ctrl +/-) scales CSS pixels relative to window pixels
        const z = getZoom(e.sender);
        wanted = {
            x: Math.round(bounds.x * z),
            y: Math.round(bounds.y * z),
            width: Math.round(bounds.width * z),
            height: Math.round(bounds.height * z)
        };
    }
    place();
}

export function setZoom(_: IpcMainInvokeEvent, factor: number) {
    zoom = factor;
    const w = alive();
    if (w) applyZoom(w.webContents, factor);
}

export function setMuted(_: IpcMainInvokeEvent, muted: boolean) {
    alive()?.webContents.setAudioMuted(muted);
}

export function setVolume(_: IpcMainInvokeEvent, vol: number) {
    volume = Math.max(0, Math.min(1, vol));
    alive()?.webContents.executeJavaScript(volumeScript(volume)).catch(() => { });
}

export function setPauseWhenHidden(_: IpcMainInvokeEvent, pause: boolean) {
    pauseWhenHidden = pause;
}

export function goBack() {
    const nav = alive()?.webContents.navigationHistory;
    if (nav?.canGoBack()) nav.goBack();
}

export function reload() {
    alive()?.webContents.reload();
}

export function focus() {
    const w = alive();
    if (w && shown) w.focus();
}

export function getState(): ViewState | null {
    const w = alive();
    if (!w) return null;
    return {
        url: w.webContents.getURL(),
        canGoBack: w.webContents.navigationHistory.canGoBack(),
        muted: w.webContents.isAudioMuted()
    };
}

export function openExternal() {
    const url = alive()?.webContents.getURL();
    if (url && /^https?:/i.test(url)) shell.openExternal(url);
}

/** Logs out of everything by wiping the feed's session */
export async function clearData() {
    await session.fromPartition(PARTITION).clearStorageData();
    alive()?.webContents.reload();
}

export function destroy() {
    const w = feed;
    feed = null;
    shown = false;
    wanted = null;
    bindParent(null);
    if (w && !w.isDestroyed()) w.destroy();
}
