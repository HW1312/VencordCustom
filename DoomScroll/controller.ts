/*
 * DoomScroll – keeps the native browser view glued to Discord's chat area
 * A cheap poll measures the area (it moves with channel switches, member list, window resizes, ...) and hides the
 * view whenever Discord shows something on top of it - the native view would otherwise cover modals and menus.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { notify } from "../_ui";
import { Native, settings } from "./index";
import type { Bounds } from "./native";
import { PlatformId, PLATFORMS } from "./platforms";

export const STRIP_HEIGHT = 40;
/** Drag handle on the left edge of the feed in the "side" layout */
export const HANDLE_WIDTH = 6;
export const MIN_SIDE_WIDTH = 280;
/** The chat keeps at least this much room next to the feed */
export const MIN_CHAT_WIDTH = 300;
const POLL_MS = 120;
const SQUEEZE_CLASS = "vc-doomscroll-squeeze";

export interface DoomState {
    open: boolean;
    platform: PlatformId | null;
    /** Area of the overlay (strip + view) in CSS pixels, null = nowhere to show it */
    rect: Bounds | null;
    /** Something of Discord's is on top, the view is hidden */
    covered: boolean;
}

let state: DoomState = { open: false, platform: null, rect: null, covered: false };
const listeners = new Set<() => void>();

export const getState = () => state;
export function subscribe(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}
function update(patch: Partial<DoomState>) {
    state = { ...state, ...patch };
    listeners.forEach(fn => fn());
}

// ---------------------------------------------------------------- Open / close

export async function openFeed(id: PlatformId) {
    if (!Native) {
        notify({ app: "DoomScroll", kind: "error", title: "DoomScroll only works in the Discord desktop app" });
        return;
    }

    settings.store.lastPlatform = id;
    if (state.platform !== id || !await Native.hasView()) {
        const { zoom, muted, volume, pauseWhenHidden } = settings.store;
        const ok = await Native.load(PLATFORMS[id].url, zoom / 100, muted, volume / 100, pauseWhenHidden);
        if (!ok) {
            notify({ app: "DoomScroll", kind: "error", title: "Couldn't open the feed" });
            return;
        }
    }

    update({ open: true, platform: id });
    startLoop();
}

export function closeFeed() {
    if (!state.open) return;
    stopLoop();
    Native?.setBounds(null);
    if (settings.store.keepLoaded) {
        update({ open: false, rect: null, covered: false });
    } else {
        Native?.destroy();
        update({ open: false, platform: null, rect: null, covered: false });
    }
}

export function toggleFeed(id: PlatformId = settings.store.lastPlatform as PlatformId) {
    if (state.open && state.platform === id) closeFeed();
    else openFeed(PLATFORMS[id] ? id : "tiktok");
}

export function reset() {
    stopLoop();
    Native?.destroy();
    update({ open: false, platform: null, rect: null, covered: false });
}

// ---------------------------------------------------------------- Finding the chat area

const visibleRect = (el: Element | null | undefined) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 150 && r.height > 150 ? r : null;
};

/**
 * replace: everything right of the channel list (header, chat, member list) - falls back to the chat itself
 * chat: only the messages + input; channel header and member list stay
 * side: the row holding chat + member list, which we squeeze with padding to make room on the right
 * Pages without a chat (friends, forums, ...) fall back to the whole page.
 */
function findArea(): HTMLElement | null {
    const chat = document.querySelector<HTMLElement>('main[class*="chatContent"]');
    const chatRow = chat?.parentElement;
    const page = document.querySelector<HTMLElement>('[class^="page_"], [class*=" page_"]');

    const { layout } = settings.store;
    const order = layout === "side" ? [chatRow, page] : layout === "chat" ? [chat, page] : [page, chatRow];
    return order.find(el => visibleRect(el)) ?? null;
}

/** Width of the area the side panel is docked into (for clamping while dragging) */
export function sideAreaWidth() {
    return visibleRect(findArea())?.width ?? window.innerWidth;
}

let squeezed: HTMLElement | null = null;
function squeeze(el: HTMLElement | null) {
    if (squeezed === el) return;
    squeezed?.classList.remove(SQUEEZE_CLASS);
    squeezed = el;
    el?.classList.add(SQUEEZE_CLASS);
}

const intersects = (a: DOMRect, b: Bounds) =>
    a.width > 0 && a.height > 0 && a.left < b.x + b.width && a.right > b.x && a.top < b.y + b.height && a.bottom > b.y;

/** Is anything of Discord's (modal, full-screen settings, menu, popout) on top of the view? */
function isCovered(view: Bounds) {
    // User / server settings are an extra full-screen layer
    if (document.querySelectorAll('[class*="layers_"] > [class*="layer_"]').length > 1) return true;
    // Modals always dim the whole window
    if (document.querySelector('[class*="layerContainer_"] [class*="backdrop_"]')) return true;
    // Menus & popouts only matter if they overlap the view
    for (const el of document.querySelectorAll('[class*="layerContainer_"] :is([role="menu"], [role="dialog"], [role="listbox"], [class*="popout"])')) {
        if (intersects(el.getBoundingClientRect(), view)) return true;
    }
    return false;
}

// ---------------------------------------------------------------- Loop

let timer: ReturnType<typeof setInterval> | null = null;
let lastSent = "";

function sameRect(a: Bounds | null, b: Bounds | null) {
    return a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
}

function tick() {
    const { layout, sideWidth } = settings.store;
    document.documentElement.style.setProperty("--vc-doomscroll-width", `${sideWidth}px`);

    const area = findArea();
    squeeze(layout === "side" ? area : null);

    let rect: Bounds | null = null;
    const r = visibleRect(area);
    if (r) {
        const width = layout === "side" ? Math.max(Math.min(sideWidth, r.width - MIN_CHAT_WIDTH), Math.min(MIN_SIDE_WIDTH, r.width)) : r.width;
        rect = { x: Math.round(r.right - width), y: Math.round(r.top), width: Math.round(width), height: Math.round(r.height) };
    }

    const handle = layout === "side" ? HANDLE_WIDTH : 0;
    const view = rect && { x: rect.x + handle, y: rect.y + STRIP_HEIGHT, width: rect.width - handle, height: rect.height - STRIP_HEIGHT };
    const covered = !!view && isCovered(view);

    if (!sameRect(rect, state.rect) || covered !== state.covered) update({ rect, covered });

    const send = covered || !view ? null : view;
    const key = JSON.stringify(send);
    if (key !== lastSent) {
        lastSent = key;
        Native?.setBounds(send);
    }
}

/** Re-measure right away (e.g. while dragging the divider) instead of waiting for the next poll */
export function refresh() {
    if (timer) tick();
}

function startLoop() {
    if (timer) return;
    lastSent = "";
    tick();
    timer = setInterval(tick, POLL_MS);
}

function stopLoop() {
    if (timer) clearInterval(timer);
    timer = null;
    lastSent = "";
    squeeze(null);
}
