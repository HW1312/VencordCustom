/*
 * StreamOverlay – Design options (shared by settings, URL builder and overlay page)
 * Pure TypeScript without browser/Node dependencies – used in the renderer AND in the main process.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const DEFAULT_PORT = 6480;

export type Layout = "list" | "row" | "grid";
export type Shape = "circle" | "rounded" | "square";
export type Effect = "glow" | "bounce" | "ring";
export type Background = "none" | "pill" | "card";

export interface OverlayConfig {
    layout: Layout;
    showUsers: boolean;
    showNames: boolean;
    onlySpeaking: boolean;
    hideMuted: boolean;
    avatarSize: number;
    shape: Shape;
    effect: Effect;
    accent: string;
    fontSize: number;
    background: Background;
    showIcons: boolean;
    showHeader: boolean;
    animated: boolean;
    chat: boolean;
    chatMax: number;
    chatFade: number;
}

export type ConfigKey = keyof OverlayConfig;

export const DEFAULTS: OverlayConfig = {
    layout: "list",
    showUsers: true,
    showNames: true,
    onlySpeaking: false,
    hideMuted: false,
    avatarSize: 48,
    shape: "circle",
    effect: "glow",
    accent: "#43b581",
    fontSize: 16,
    background: "pill",
    showIcons: true,
    showHeader: false,
    animated: true,
    chat: false,
    chatMax: 5,
    chatFade: 30
};

/** Short names of the URL parameters (?layout=row&size=64 …) */
export const PARAMS: Record<ConfigKey, string> = {
    layout: "layout",
    showUsers: "users",
    showNames: "names",
    onlySpeaking: "speaking",
    hideMuted: "hidemuted",
    avatarSize: "size",
    shape: "shape",
    effect: "effect",
    accent: "accent",
    fontSize: "font",
    background: "bg",
    showIcons: "icons",
    showHeader: "header",
    animated: "animated",
    chat: "chat",
    chatMax: "chatmax",
    chatFade: "fade"
};

export const ENUMS: Partial<Record<ConfigKey, readonly string[]>> = {
    layout: ["list", "row", "grid"],
    shape: ["circle", "rounded", "square"],
    effect: ["glow", "bounce", "ring"],
    background: ["none", "pill", "card"]
};

export const RANGES: Partial<Record<ConfigKey, readonly [number, number]>> = {
    avatarSize: [16, 160],
    fontSize: [8, 48],
    chatMax: [1, 30],
    chatFade: [0, 600]
};

export const CONFIG_KEYS = Object.keys(DEFAULTS) as ConfigKey[];

export const isHexColor = (v: string) => /^#?[0-9a-f]{3,8}$/i.test(v);

/** Query string with all options that differ from the default (empty = use settings from Discord) */
export function buildQuery(cfg: OverlayConfig, extra: Record<string, string> = {}) {
    const q = new URLSearchParams();
    for (const key of CONFIG_KEYS) {
        const value = cfg[key];
        if (value === DEFAULTS[key]) continue;
        if (typeof value === "boolean") q.set(PARAMS[key], value ? "1" : "0");
        else if (key === "accent") q.set(PARAMS[key], String(value).replace("#", "").toLowerCase());
        else q.set(PARAMS[key], String(value));
    }
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    const s = q.toString();
    return s ? "?" + s : "";
}
