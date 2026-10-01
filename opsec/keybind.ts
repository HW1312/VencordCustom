/*
 * OpSec – Keybind: stored as "ctrl+shift+KeyL", displayed as "Ctrl + Shift + L"
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const DEFAULT_KEYBIND = "ctrl+shift+KeyL";

export interface Keybind {
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
    code: string;
}

export function parseKeybind(s: string | undefined): Keybind {
    const parts = (s || DEFAULT_KEYBIND).split("+");
    const code = parts.pop() || "KeyL";
    return {
        ctrl: parts.includes("ctrl"),
        shift: parts.includes("shift"),
        alt: parts.includes("alt"),
        meta: parts.includes("meta"),
        code
    };
}

export function serializeKeybind(k: Keybind) {
    return [k.ctrl && "ctrl", k.shift && "shift", k.alt && "alt", k.meta && "meta", k.code].filter(Boolean).join("+");
}

const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

export const isModifierCode = (code: string) => MODIFIER_CODES.test(code);

export function keybindFromEvent(e: KeyboardEvent): Keybind {
    return { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, code: e.code };
}

export function matchesKeybind(e: KeyboardEvent, k: Keybind) {
    return e.code === k.code && e.ctrlKey === k.ctrl && e.shiftKey === k.shift && e.altKey === k.alt && e.metaKey === k.meta;
}

/** Valid = at least one modifier key, or an F key */
export function isValidKeybind(k: Keybind) {
    return !isModifierCode(k.code) && (k.ctrl || k.alt || k.meta || /^F\d{1,2}$/.test(k.code));
}

const CODE_NAMES: Record<string, string> = {
    Space: "Space", Enter: "Enter", Escape: "Esc", Backspace: "Backspace", Tab: "Tab", Delete: "Del", Insert: "Ins",
    Home: "Home", End: "End", PageUp: "PgUp", PageDown: "PgDn", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
    Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Backslash: "\\",
    Comma: ",", Period: ".", Slash: "/", IntlBackslash: "<", Pause: "Pause", ScrollLock: "ScrollLock", PrintScreen: "PrtSc"
};

export function keyName(code: string) {
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    if (code.startsWith("Numpad")) return "Num " + code.slice(6);
    return CODE_NAMES[code] ?? code;
}

/** Individual keys for display as key chips */
export function keybindParts(k: Keybind) {
    return [k.ctrl && "Ctrl", k.shift && "Shift", k.alt && "Alt", k.meta && "Win", keyName(k.code)].filter(Boolean) as string[];
}

export const formatKeybind = (k: Keybind) => keybindParts(k).join(" + ");

/** Known Discord/system shortcuts you should better not override */
const KNOWN: Record<string, string> = {
    "ctrl+shift+KeyM": "Discord: Mute",
    "ctrl+shift+KeyD": "Discord: Deafen",
    "ctrl+shift+KeyI": "Developer tools",
    "ctrl+shift+KeyU": "Discord: Upload file",
    "ctrl+shift+KeyA": "Discord: Collapse category",
    "ctrl+shift+KeyN": "Discord: Create server",
    "ctrl+shift+KeyT": "Discord: Start call",
    "ctrl+shift+KeyH": "Discord: Help",
    "ctrl+KeyK": "Discord: Quick switcher",
    "ctrl+KeyR": "Reload Discord",
    "ctrl+KeyF": "Discord: Search",
    "ctrl+KeyE": "Discord: Emoji picker",
    "ctrl+KeyG": "Discord: GIF picker",
    "ctrl+KeyS": "Discord: Sticker picker",
    "ctrl+KeyC": "Copy",
    "ctrl+KeyV": "Paste",
    "ctrl+KeyX": "Cut",
    "ctrl+KeyZ": "Undo",
    "ctrl+KeyA": "Select all",
    "ctrl+KeyB": "Bold",
    "ctrl+KeyI": "Italic",
    "ctrl+KeyU": "Underline",
    "alt+F4": "Close window",
    "ctrl+Slash": "Discord: Keyboard shortcuts",
    "ctrl+Comma": "Discord: Settings"
};

export function keybindConflict(k: Keybind) {
    return KNOWN[serializeKeybind(k)] ?? null;
}

/** While a new keybind is being recorded, the panic key must not trigger */
export const recording = { active: false };
