/*
 * PeekAnything – hold-key handling and peek state
 * Only a lone hold of the key counts: any other key or a click while waiting cancels it, so shortcuts
 * (Ctrl+C, Alt+Click, Alt+Arrow, Alt+Tab ...) keep working and never flash a preview.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { insertTextIntoChatInputBox } from "@utils/discord";
import { SelectedChannelStore } from "@webpack/common";

import { settings } from "./index";
import { callHit, Hit, resolveTarget, streamsIn, targetKey } from "./targets";

// ---------------------------------------------------------------- State

export interface PeekState {
    hit: Hit | null;
    /** Snapshot of the anchor position when the hit was taken */
    rect: DOMRect | null;
    pinned: boolean;
    /** Which stream of the call is shown (call peek) */
    callIndex: number;
}

let state: PeekState = { hit: null, rect: null, pinned: false, callIndex: 0 };
const listeners = new Set<() => void>();

export const getState = () => state;

export function subscribe(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

function setState(patch: Partial<PeekState>) {
    state = { ...state, ...patch };
    listeners.forEach(fn => {
        try {
            fn();
        } catch { /* keep the others */ }
    });
}

// ---------------------------------------------------------------- Focus

/** Element that had focus before the preview opened (usually the chat input) */
let savedFocus: HTMLElement | null = null;

function restoreFocus() {
    const el = savedFocus;
    savedFocus = null;
    const active = document.activeElement;
    // Only if the focus went to nowhere or into the preview – never steal it from somewhere the user chose
    if (!el?.isConnected || (active && active !== document.body && !active.closest(".vc-peek-root"))) return;
    try {
        el.focus({ preventScroll: true });
    } catch { /* gone */ }
}

// ---------------------------------------------------------------- Open / close

function show(hit: Hit) {
    if (!state.hit) {
        const active = document.activeElement as HTMLElement | null;
        savedFocus = active && active !== document.body ? active : null;
    }
    const sameTarget = targetKey(hit.target) === targetKey(state.hit?.target);
    setState({
        hit,
        rect: hit.anchor?.getBoundingClientRect() ?? null,
        callIndex: sameTarget ? state.callIndex : 0
    });
}

export function closePeek() {
    if (!state.hit) return;
    setState({ hit: null, rect: null, pinned: false, callIndex: 0 });
    restoreFocus();
}

export function pinPeek() {
    if (state.hit && !state.pinned) setState({ pinned: true });
}

export function switchTo(hit: Hit) {
    setState({ hit, callIndex: 0, rect: state.rect });
}

export function stepCallStream(dir: 1 | -1) {
    if (state.hit?.target.kind !== "call") return false;
    const count = streamsIn(SelectedChannelStore.getVoiceChannelId()).length;
    if (count < 2) return false;
    setState({ callIndex: (state.callIndex + dir + count) % count });
    return true;
}

export function setCallIndex(i: number) {
    setState({ callIndex: i });
}

// ---------------------------------------------------------------- Key matching

const MODIFIER_CODES: Record<string, string[]> = {
    alt: ["AltLeft", "AltRight"],
    ctrl: ["ControlLeft", "ControlRight"],
    shift: ["ShiftLeft", "ShiftRight"]
};

function isTriggerKey(e: KeyboardEvent) {
    const { key, customKey } = settings.store;
    if (key === "custom") return !!customKey && e.code === customKey;
    return (MODIFIER_CODES[key] ?? MODIFIER_CODES.alt).includes(e.code);
}

/** No other modifier than the trigger itself */
function isLone(e: KeyboardEvent) {
    const { key } = settings.store;
    return (key === "alt" || !e.altKey)
        && (key === "ctrl" || !e.ctrlKey)
        && (key === "shift" || !e.shiftKey)
        && !e.metaKey;
}

const isModifierTrigger = () => settings.store.key !== "custom";

function isEditable(el: EventTarget | null) {
    const node = el as HTMLElement | null;
    return !!node && (node.isContentEditable || node.tagName === "TEXTAREA" || (node.tagName === "INPUT" && !["checkbox", "radio", "button", "range"].includes((node as HTMLInputElement).type)));
}

/** A tap of a custom (typing) key in a text field: put the character back that we held back */
function typeHeldChar(target: EventTarget | null, char: string) {
    const el = target as HTMLElement | null;
    if (!el || char.length !== 1) return;
    try {
        if (el.isContentEditable) {
            insertTextIntoChatInputBox(char);
        } else if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
            el.setRangeText(char, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, "end");
            el.dispatchEvent(new Event("input", { bubbles: true }));
        }
    } catch { /* not typeable */ }
}

// ---------------------------------------------------------------- Hold tracking

let mouse = { x: -1, y: -1 };
/** Trigger key is down and still counts as a lone hold */
let holding = false;
/** Trigger key is down but a combo happened – ignore until it is released */
let tainted = false;
let openTimer: ReturnType<typeof setTimeout> | undefined;
/** For custom typing keys: the held-back character and where it should go */
let heldChar: { char: string; target: EventTarget | null; } | null = null;
let moveFrame = 0;

function cancelHold() {
    clearTimeout(openTimer);
    openTimer = undefined;
    holding = false;
}

function hitAtMouse(): Hit | null {
    if (mouse.x < 0) return null;
    return resolveTarget(document.elementFromPoint(mouse.x, mouse.y));
}

function openNow() {
    openTimer = undefined;
    if (!holding) return;
    const hit = hitAtMouse() ?? callHit();
    if (!hit) return;
    // A new hold replaces a pinned preview with a fresh (unpinned) one
    if (state.pinned) setState({ pinned: false });
    show(hit);
}

function onKeyDown(e: KeyboardEvent) {
    // Pinned or open preview: Escape closes it and must not reach Discord (Escape there marks the channel read)
    if (e.key === "Escape" && state.hit) {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancelHold();
        closePeek();
        return;
    }

    if (isTriggerKey(e)) {
        if (!isModifierTrigger() && isEditable(e.target) && !tainted && isLone(e)) {
            // Typing key: hold it back, it is typed on release if no preview opened
            e.preventDefault();
            if (!e.repeat && !holding) heldChar = { char: e.key, target: e.target };
        }
        if (e.repeat || tainted || holding) return;
        if (!isLone(e)) {
            tainted = true;
            return;
        }
        holding = true;
        clearTimeout(openTimer);
        openTimer = setTimeout(openNow, Math.max(0, Number(settings.store.holdDelay) || 0));
        return;
    }

    if (!holding) return;

    // While the preview is open: arrows switch between the streams of your call
    if (state.hit && !state.pinned && (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "ArrowRight" || e.key === "ArrowDown")) {
        if (stepCallStream(e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
        }
    }

    // Any other key: it was a shortcut, not a peek
    cancelHold();
    tainted = true;
    heldChar = null;
    if (!state.pinned) closePeek();
}

function onKeyUp(e: KeyboardEvent) {
    if (!isTriggerKey(e)) return;
    const wasPeek = holding && !!state.hit;
    const wasHolding = holding;
    cancelHold();
    tainted = false;

    if (heldChar) {
        const pending = heldChar;
        heldChar = null;
        if (!wasPeek && wasHolding) typeHeldChar(pending.target, pending.char);
    }

    // A lone Alt release would otherwise focus the (hidden) menu in some setups
    if (wasHolding && e.key === "Alt") e.preventDefault();
    if (wasPeek && !state.pinned) closePeek();
}

function onMouseMove(e: MouseEvent) {
    mouse = { x: e.clientX, y: e.clientY };
    if (!holding || !state.hit || state.pinned || moveFrame) return;
    moveFrame = requestAnimationFrame(() => {
        moveFrame = 0;
        if (!holding || !state.hit || state.pinned) return;
        const el = document.elementFromPoint(mouse.x, mouse.y);
        // Moving over the card itself keeps the current preview
        if (!el || el.closest(".vc-peek-root")) return;
        const hit = resolveTarget(el);
        if (hit && targetKey(hit.target) !== targetKey(state.hit.target)) show(hit);
    });
}

function onPointerDown(e: PointerEvent) {
    const inside = (e.target as Element | null)?.closest?.(".vc-peek-root");
    if (inside) {
        pinPeek();
        return;
    }
    // A click while waiting is a shortcut (Alt+Click marks unread etc.)
    if (holding && !state.hit) {
        cancelHold();
        tainted = true;
        heldChar = null;
        return;
    }
    if (state.hit) {
        cancelHold();
        if (holding) tainted = true;
        closePeek();
    }
}

function onWheel(e: WheelEvent) {
    if (!state.hit || state.hit.target.kind !== "call") return;
    // Holding: the wheel switches streams anywhere; pinned: only over the card
    const overCard = !!(e.target as Element | null)?.closest?.(".vc-peek-root");
    if (!holding && !(state.pinned && overCard)) return;
    if (Math.abs(e.deltaY) < 4) return;
    if (stepCallStream(e.deltaY > 0 ? 1 : -1)) {
        e.preventDefault();
        e.stopPropagation();
    }
}

function onBlur() {
    cancelHold();
    tainted = false;
    heldChar = null;
    if (!state.pinned) closePeek();
}

let lastWheel = 0;
function onWheelThrottled(e: WheelEvent) {
    if (!state.hit || state.hit.target.kind !== "call") return;
    const now = Date.now();
    if (now - lastWheel < 180) {
        const overCard = !!(e.target as Element | null)?.closest?.(".vc-peek-root");
        if (holding || (state.pinned && overCard)) e.preventDefault();
        return;
    }
    lastWheel = now;
    onWheel(e);
}

// ---------------------------------------------------------------- Lifecycle

export function startController() {
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("mousemove", onMouseMove, { capture: true, passive: true });
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("wheel", onWheelThrottled, { capture: true, passive: false });
    window.addEventListener("blur", onBlur);
}

export function stopController() {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("wheel", onWheelThrottled, true);
    window.removeEventListener("blur", onBlur);
    cancelAnimationFrame(moveFrame);
    moveFrame = 0;
    cancelHold();
    tainted = false;
    heldChar = null;
    closePeek();
}
