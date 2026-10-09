/*
 * OpSec – UI: title bar button, popout with sidebar (Overview / Protection / Curtain / Check),
 * settings (same UI in the plugin window), link warning, streaming protection picker
 * (servers/channels) and scam blocklist status
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { useForceUpdater } from "@utils/react";
import { findComponentByCodeLazy } from "@webpack";
import { Alerts, ConnectedAccountsStore, GuildChannelStore, GuildStore, IconUtils, Popout, React, showToast, Tooltip, useEffect, useLayoutEffect, useMemo, useRef, UserSettingsProtoStore, UserStore, useState, useStateFromStores } from "@webpack/common";
import type { ReactNode } from "react";

import { Check, CHECKS, CheckStatus, getAuditSummary, loadConsents, onConsentsChange, runFix } from "./audit";
import { BLOCKLIST_SOURCE, getBlocklistStatus, onBlocklistChange, refreshBlocklist } from "./blocklist";
import { buildCurtain, CURTAIN_ICONS, CurtainAnimation, CurtainIconName, CurtainOptions, CurtainStyle, DEFAULT_CURTAIN_TEXT, isCurtainShown, MASK_PATH, onCurtainChange, showCurtain, toggleCurtain } from "./curtain";
import { getConfig, getCurtainOptions, getIdList, getPanicKey, setOption, setIds, setProfile, settings, toggleId, UploadEditorMode } from "./index";
import { DEFAULT_KEYBIND, isModifierCode, isValidKeybind, Keybind, keybindConflict, keybindFromEvent, keybindParts, recording, serializeKeybind } from "./keybind";
import type { LinkAnalysis } from "./links";
import { ConfigKey, Profile } from "./profiles";
import { isGuardActive, isGuardPreview, onGuardChange, previewGuard, stopPreview } from "./stream";

const cl = classNameFactory("vc-opsec-");
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

const PLATFORM = navigator.platform.toLowerCase();
const HAS_CONTENT_PROTECTION = PLATFORM.startsWith("win") || PLATFORM.startsWith("mac");

// ---------------------------------------------------------------- Icons

const ICONS = {
    keyboard: "M20 5H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z",
    game: "M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4-3c-.83 0-1.5-.67-1.5-1.5S18.67 9 19.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z",
    eyeOff: "M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z",
    eye: "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z",
    photo: "M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z",
    file: "M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z",
    link: "M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z",
    warning: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
    wand: "M7.5 5.6 10 7 8.6 4.5 10 2 7.5 3.4 5 2l1.4 2.5L5 7zm12 9.8L17 14l1.4 2.5L17 19l2.5-1.4L22 19l-1.4-2.5L22 14zM22 2l-2.5 1.4L17 2l1.4 2.5L17 7l2.5-1.4L22 7l-1.4-2.5zm-7.63 5.29a.996.996 0 0 0-1.41 0L1.29 18.96c-.39.39-.39 1.02 0 1.41l2.34 2.34c.39.39 1.02.39 1.41 0L16.7 11.05c.39-.39.39-1.02 0-1.41l-2.33-2.35zm-1.03 5.49-2.12-2.12 2.44-2.44 2.12 2.12-2.44 2.44z",
    camOff: "M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z",
    monitor: "M21 2H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H3V4h18v12z",
    shieldCheck: "M12 2 4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm-1.06 13.54L7.4 12l1.41-1.41 2.12 2.12 4.24-4.24 1.41 1.41-5.64 5.66z",
    dashboard: "M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z",
    tune: "M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z",
    bolt: "M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66.19-.34.05-.08.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15C12.96 17.55 11 21 11 21z",
    play: "M8 5v14l11-7z",
    cast: "M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2a9 9 0 0 1 9 9h2c0-6.08-4.93-11-11-11z",
    brush: "M7 14c-1.66 0-3 1.34-3 3 0 1.31-1.16 2-2 2 .92 1.22 2.49 2 4 2 2.21 0 4-1.79 4-4 0-1.66-1.34-3-3-3zm13.71-9.37-1.34-1.34a.996.996 0 0 0-1.41 0L9 12.25 11.75 15l8.96-8.96a.996.996 0 0 0 0-1.41z",
    block: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9A7.902 7.902 0 0 1 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1A7.902 7.902 0 0 1 20 12c0 4.42-3.58 8-8 8z",
    chevron: "M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z",
    restore: "M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18z",
    settings: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"
};

type IconName = keyof typeof ICONS;

function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden>
            <path fill="currentColor" d={ICONS[name]} />
        </svg>
    );
}

export function MaskIcon({ size = 20, className }: { size?: number; className?: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={classes(cl("icon"), className)} aria-hidden>
            <path fill="currentColor" d={MASK_PATH} />
        </svg>
    );
}

// ---------------------------------------------------------------- Texts

const PROFILES: { value: Profile; label: string; description: string; }[] = [
    { value: "standard", label: "Standard", description: "Protects against tracking, IP loggers and metadata leaks without making Discord feel any different." },
    { value: "paranoid", label: "Paranoid", description: "Maximum stealth: invisible online and while typing, every link is confirmed, edit images before upload, window invisible in recordings and covered when you click away." },
    { value: "custom", label: "Manual", description: "Configure everything yourself. Starts with the values of the previous profile." }
];

interface OptionInfo {
    key: ConfigKey;
    label: string;
    short: string;
    icon: IconName;
    hint: string;
    hidden?: boolean;
}

const OPTIONS: Record<ConfigKey, OptionInfo> = {
    silentTyping: { key: "silentTyping", icon: "keyboard", label: "Type invisibly", short: "Invisible typing", hint: "Others don't see \"… is typing\". Otherwise it reveals that you're online and when you reply." },
    hideActivity: { key: "hideActivity", icon: "game", label: "Hide activity", short: "Hide activity", hint: "No \"Playing …\" / \"Listening to Spotify\". Otherwise it reveals habits and online times." },
    invisibleStatus: { key: "invisibleStatus", icon: "eyeOff", label: "Status \"Invisible\"", short: "Invisible online", hint: "You appear offline but can use Discord completely normally." },
    dangerousLinkWarning: { key: "dangerousLinkWarning", icon: "warning", label: "Warn about dangerous links", short: "Link protection", hint: "Asks before IP loggers (Grabify & co.), phishing lookalikes (dlscord, steamcommunlty …) or punycode tricks are opened." },
    cleanSentLinks: { key: "cleanSentLinks", icon: "wand", label: "Remove tracking from sent links", short: "Clean links", hint: "Removes utm_, fbclid, YouTube/Spotify \"si\" etc. These reveal who shared the link." },
    cleanClickedLinks: { key: "cleanClickedLinks", icon: "link", label: "Remove tracking from clicked links", short: "Clean clicks", hint: "Links from others are opened without tracking parameters." },
    confirmExternalLinks: { key: "confirmExternalLinks", icon: "link", label: "Confirm every external link", short: "Confirm links", hint: "Every click reveals your IP address to the target site. This way you see exactly where it goes beforehand." },
    scamBlocklist: { key: "scamBlocklist", icon: "block", label: "Scam blocklist (online)", short: "Scam blocklist", hint: "Over 35,000 known fake Nitro, Steam and phishing domains. Matches are marked red in chat and only opened after a warning. Only downloads the public list, sends nothing." },
    stripMetadata: { key: "stripMetadata", icon: "photo", label: "Strip metadata from images & videos", short: "Strip metadata", hint: "GPS location, device, serial number, capture time, software … (JPEG, PNG, WebP, MP4, MOV). Lossless." },
    anonymizeFilenames: { key: "anonymizeFilenames", icon: "file", label: "Anonymize filenames", short: "Filenames", hint: "\"IMG_20260930_143022.jpg\" or \"Screenshot from Max-PC\" becomes a random name." },
    uploadEditor: { key: "uploadEditor", icon: "brush", label: "Edit images before sending", short: "Image editor", hint: "Crop, redact names & tokens, pixelate, arrows & text – before a screenshot goes out. PNG, JPEG, WebP." },
    contentProtection: { key: "contentProtection", icon: "camOff", label: "Capture protection", short: "Capture protection", hint: "Discord is invisible in screenshots, recordings and screen shares – even to your own snipping tool.", hidden: !HAS_CONTENT_PROTECTION },
    curtainOnBlur: { key: "curtainOnBlur", icon: "eye", label: "Cover when you click away", short: "Auto curtain", hint: "As soon as another window is active, Discord is covered. Clicking back removes it." },
    panicHotkey: { key: "panicHotkey", icon: "bolt", label: "Panic key", short: "Panic key", hint: "Instantly covers Discord with a single key press." },
    screenshareGuard: { key: "screenshareGuard", icon: "cast", label: "Streaming protection", short: "Streaming protection", hint: "While you stream or share your screen: DMs blurred, selected servers & channels hidden, notifications muted." }
};

const TILES: ConfigKey[] = ["silentTyping", "hideActivity", "invisibleStatus", "stripMetadata", "dangerousLinkWarning", "cleanSentLinks", "screenshareGuard", "uploadEditor", "contentProtection", "curtainOnBlur"];

type TabId = "overview" | "protection" | "curtain" | "check";

const TABS: { id: TabId; label: string; icon: IconName | "mask"; }[] = [
    { id: "overview", label: "Overview", icon: "dashboard" },
    { id: "protection", label: "Protection", icon: "tune" },
    { id: "curtain", label: "Curtain", icon: "mask" },
    { id: "check", label: "Check", icon: "shieldCheck" }
];

// ---------------------------------------------------------------- Building blocks

/** Discord's own tooltip around any element (instead of the browser "title") */
export function Tip({ text, children }: { text: ReactNode; children: React.ReactElement<any>; }) {
    return (
        <Tooltip text={text}>
            {(tp: any) => {
                const own = children.props ?? {};
                const merged: Record<string, any> = { ...tp };
                for (const k of Object.keys(tp)) {
                    if (typeof tp[k] === "function" && typeof own[k] === "function") {
                        merged[k] = (e: any) => {
                            tp[k](e);
                            own[k](e);
                        };
                    }
                }
                return React.cloneElement(children, merged);
            }}
        </Tooltip>
    );
}

function Toggle({ checked, disabled }: { checked: boolean; disabled?: boolean; }) {
    return (
        <span className={classes(cl("switch"), checked && cl("switch-on"), disabled && cl("switch-disabled"))} aria-hidden>
            <span className={cl("switch-knob")} />
        </span>
    );
}

/** Whole row clickable, with its own animated switch */
function ToggleRow({ checked, onChange, label, hint, icon, disabled, sub }: {
    checked: boolean; onChange(v: boolean): void; label: ReactNode; hint?: ReactNode; icon?: IconName | "mask"; disabled?: boolean; sub?: boolean;
}) {
    const toggle = () => !disabled && onChange(!checked);
    return (
        <div
            role="switch"
            aria-checked={checked}
            aria-disabled={disabled}
            tabIndex={disabled ? -1 : 0}
            className={classes(cl("row"), sub && cl("row-sub"), disabled && cl("row-disabled"))}
            onClick={toggle}
            onKeyDown={e => {
                if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    toggle();
                }
            }}
        >
            {icon && <span className={classes(cl("row-icon"), checked && cl("row-icon-on"))}>{icon === "mask" ? <MaskIcon size={18} /> : <Icon name={icon} size={18} />}</span>}
            <span className={cl("row-text")}>
                <span className={cl("row-label")}>{label}</span>
                {hint && <span className={cl("row-hint")}>{hint}</span>}
            </span>
            <Toggle checked={checked} disabled={disabled} />
        </div>
    );
}

/** Measures the position of a child element for sliding highlights (tabs, segments) */
function useSlider<T extends string>(value: T) {
    const refs = useRef<Record<string, HTMLElement | null>>({});
    const [pos, setPos] = useState<{ left: number; width: number; ready: boolean; }>({ left: 0, width: 0, ready: false });

    useLayoutEffect(() => {
        const measure = () => {
            const node = refs.current[value];
            if (node) setPos(p => ({ left: node.offsetLeft, width: node.offsetWidth, ready: p.ready || p.width > 0 }));
        };
        measure();
        // Enable transitions after the first measurement (otherwise the highlight slides in from the left on open)
        const raf = requestAnimationFrame(() => {
            measure();
            setPos(p => ({ ...p, ready: true }));
        });
        return () => cancelAnimationFrame(raf);
    }, [value]);

    return { refs, pos };
}

function Segmented<T extends string>({ value, options, onChange, small }: {
    value: T;
    options: { value: T; label: string; }[];
    onChange(v: T): void;
    small?: boolean;
}) {
    const { refs, pos } = useSlider(value);
    return (
        <div className={classes(cl("seg"), small && cl("seg-small"))}>
            <span
                className={classes(cl("seg-thumb"), pos.ready && cl("animated"))}
                style={{ transform: `translateX(${pos.left}px)`, width: pos.width }}
            />
            {options.map(o => (
                <button
                    key={o.value}
                    ref={n => { refs.current[o.value] = n; }}
                    className={classes(cl("seg-item"), o.value === value && cl("seg-item-active"))}
                    onClick={() => onChange(o.value)}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function Sidebar({ value, onChange }: { value: TabId; onChange(t: TabId): void; }) {
    const { summary } = useAudit();

    return (
        <nav className={cl("sidebar")}>
            <div className={cl("brand")}>
                <span className={cl("brand-logo")}><MaskIcon size={18} /></span>
                <span className={cl("brand-text")}>
                    <span className={cl("brand-name")}>OpSec</span>
                    <span className={cl("brand-sub")}>Beneath the OS</span>
                </span>
            </div>

            <div className={cl("nav")} role="tablist" aria-orientation="vertical">
                {TABS.map(t => (
                    <button
                        key={t.id}
                        role="tab"
                        aria-selected={t.id === value}
                        className={classes(cl("nav-item"), t.id === value && cl("nav-item-active"))}
                        onClick={() => onChange(t.id)}
                    >
                        {t.icon === "mask" ? <MaskIcon size={18} /> : <Icon name={t.icon} size={18} />}
                        <span className={cl("nav-label")}>{t.label}</span>
                        {t.id === "check" && summary.warn > 0 && <span className={cl("nav-badge")}>{summary.warn}</span>}
                    </button>
                ))}
            </div>

        </nav>
    );
}

function Kbd({ keys, live }: { keys: string[]; live?: boolean; }) {
    return (
        <span className={cl("kbd-group")}>
            {keys.map((k, i) => (
                <span key={k + i} className={classes(cl("kbd"), live && cl("kbd-live"))} style={{ animationDelay: `${i * 40}ms` }}>{k}</span>
            ))}
        </span>
    );
}

function SectionTitle({ children, right }: { icon?: IconName | "mask"; children: ReactNode; right?: ReactNode; }) {
    return (
        <div className={cl("section-title")}>
            <span>{children}</span>
            {right && <span className={cl("section-right")}>{right}</span>}
        </div>
    );
}

function useCountUp(target: number, duration = 700) {
    const [value, setValue] = useState(0);
    const from = useRef(0);
    useEffect(() => {
        const start = performance.now(), a = from.current;
        let raf = 0;
        const step = (t: number) => {
            const p = Math.min(1, (t - start) / duration);
            const eased = 1 - Math.pow(1 - p, 3);
            const v = Math.round(a + (target - a) * eased);
            setValue(v);
            from.current = v;
            if (p < 1) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        return () => cancelAnimationFrame(raf);
    }, [target]);
    return value;
}

function ScoreRing({ ok, total, size = 76, stroke = 7 }: { ok: number; total: number; size?: number; stroke?: number; }) {
    const id = useMemo(() => "opsec-ring-" + Math.random().toString(36).slice(2), []);
    const [shown, setShown] = useState(false);
    useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r); }, []);
    const count = useCountUp(ok);

    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const pct = total ? ok / total : 0;
    const tone = pct >= 1 ? "good" : pct >= 0.7 ? "mid" : "bad";

    return (
        <div className={classes(cl("ring"), cl(`ring-${tone}`))} style={{ width: size, height: size }}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                <defs>
                    <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" className={cl("ring-stop-a")} />
                        <stop offset="100%" className={cl("ring-stop-b")} />
                    </linearGradient>
                </defs>
                <circle cx={size / 2} cy={size / 2} r={r} className={cl("ring-track")} strokeWidth={stroke} />
                <circle
                    cx={size / 2} cy={size / 2} r={r}
                    className={cl("ring-bar")}
                    strokeWidth={stroke}
                    stroke={`url(#${id})`}
                    strokeDasharray={c}
                    strokeDashoffset={shown ? c * (1 - pct) : c}
                    transform={`rotate(-90 ${size / 2} ${size / 2})`}
                />
            </svg>
            <div className={cl("ring-label")}>
                <span className={cl("ring-num")}>{count}</span>
                <span className={cl("ring-total")}>/{total}</span>
            </div>
        </div>
    );
}

function useCurtainShown() {
    const forceUpdate = useForceUpdater();
    useEffect(() => onCurtainChange(forceUpdate), []);
    return isCurtainShown();
}

// ---------------------------------------------------------------- Security check

function safeStatus(c: Check): CheckStatus {
    try {
        return c.status();
    } catch {
        return "unknown";
    }
}

function useAudit() {
    const forceUpdate = useForceUpdater();
    useEffect(() => {
        loadConsents();
        return onConsentsChange(forceUpdate);
    }, []);
    useStateFromStores(
        [UserSettingsProtoStore, ConnectedAccountsStore, UserStore],
        () => CHECKS.map(safeStatus).join(",")
    );
    return { summary: getAuditSummary(), refresh: forceUpdate };
}

function StatusIcon({ status }: { status: CheckStatus; }) {
    return (
        <span className={classes(cl("status"), cl(`status-${status}`))}>
            {status === "ok"
                ? <svg viewBox="0 0 24 24" width={14} height={14}><path className={cl("status-check")} d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" /></svg>
                : status === "warn"
                    ? <svg viewBox="0 0 24 24" width={14} height={14}><path fill="currentColor" d="M11 5h2.2l-.3 9h-1.6L11 5Zm1.1 11.2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z" /></svg>
                    : <svg viewBox="0 0 24 24" width={14} height={14}><path fill="currentColor" d="M12 5a4 4 0 0 1 4 4c0 1.6-1 2.4-1.8 3-.7.5-1.2.9-1.2 1.8v.7h-2v-.9c0-1.8 1-2.6 1.8-3.2.7-.5 1.2-.9 1.2-1.4a2 2 0 0 0-4 0H8a4 4 0 0 1 4-4Zm-1 11.5h2v2.2h-2z" /></svg>}
        </span>
    );
}

function CheckRow({ check, index, onDone }: { check: Check; index: number; onDone(): void; }) {
    const [busy, setBusy] = useState(false);
    const status = safeStatus(check);

    const fix = async () => {
        setBusy(true);
        try {
            await runFix(check);
        } catch {
            showToast(`OpSec: Failed to change "${check.title}"`, "failure");
        } finally {
            setBusy(false);
            onDone();
        }
    };

    return (
        <div className={classes(cl("check"), cl(`check-${status}`))} style={{ animationDelay: `${index * 35}ms` }}>
            <StatusIcon status={status} />
            <div className={cl("row-text")}>
                <span className={cl("row-label")}>
                    {check.title}
                    {status === "warn" && check.severity === "high" && <span className={cl("pill-danger")}>Important</span>}
                </span>
                <span className={cl("row-hint")}>{check.hint}</span>
            </div>
            {status === "warn" && check.fix && (
                <button className={classes(cl("btn"), cl("btn-small"), busy && cl("btn-busy"))} disabled={busy} onClick={fix}>
                    {busy ? <span className={cl("spinner")} /> : check.fixLabel ?? "Fix"}
                </button>
            )}
        </div>
    );
}

const AUTO_FIXABLE = (c: Check) => !!c.fix && c.id !== "mfa";

function CheckTab() {
    const { summary, refresh } = useAudit();
    const [busy, setBusy] = useState(false);
    const fixable = CHECKS.filter(c => AUTO_FIXABLE(c) && safeStatus(c) === "warn");
    const sorted = useMemo(() => {
        const order = { warn: 0, unknown: 1, ok: 2 } as const;
        const sev = { high: 0, medium: 1, low: 2 } as const;
        return [...CHECKS].sort((a, b) => order[safeStatus(a)] - order[safeStatus(b)] || sev[a.severity] - sev[b.severity]);
        // Only sort on open so rows don't jump after "Fix"
    }, []);

    const fixAll = async () => {
        setBusy(true);
        let failed = 0;
        for (const c of fixable) {
            try { await runFix(c); } catch { failed++; }
        }
        setBusy(false);
        refresh();
        showToast(
            failed ? `OpSec: ${fixable.length - failed} fixed, ${failed} failed` : `OpSec: ${fixable.length} ${fixable.length === 1 ? "setting" : "settings"} secured`,
            failed ? "failure" : "success"
        );
    };

    return (
        <>
            <div className={cl("hero")}>
                <ScoreRing ok={summary.ok} total={summary.total} />
                <div className={cl("hero-text")}>
                    <span className={cl("hero-title")}>
                        {summary.warn ? `${summary.warn} ${summary.warn === 1 ? "recommendation" : "recommendations"} open` : "Everything secured"}
                    </span>
                    <span className={cl("row-hint")}>
                        {summary.highWarn ? `${summary.highWarn} of them important. ` : ""}Audits your account and Discord's privacy settings.
                    </span>
                    {fixable.length > 0 && (
                        <button className={cl("btn")} disabled={busy} onClick={fixAll}>
                            {busy ? <span className={cl("spinner")} /> : <Icon name="shieldCheck" size={16} />}
                            {busy ? "Securing…" : fixable.length === 1 ? "Fix" : `Fix all ${fixable.length}`}
                        </button>
                    )}
                </div>
            </div>
            <div className={cl("checks")}>
                {sorted.map((c, i) => <CheckRow key={c.id} check={c} index={i} onDone={refresh} />)}
            </div>
        </>
    );
}

// ---------------------------------------------------------------- Overview

function ProfilePicker({ compact }: { compact?: boolean; }) {
    const { profile } = settings.use(["profile"]);
    const current = PROFILES.find(p => p.value === profile) ?? PROFILES[0];
    return (
        <div className={cl("profile")}>
            <Segmented value={current.value} options={PROFILES} onChange={setProfile} />
            {!compact && <div key={current.value} className={classes(cl("row-hint"), cl("fade-in"))}>{current.description}</div>}
        </div>
    );
}

function Tile({ info, on }: { info: OptionInfo; on: boolean; }) {
    const [pop, setPop] = useState(0);
    return (
        <Tip text={info.hint}>
        <button
            className={classes(cl("tile"), on && cl("tile-on"))}
            onClick={() => {
                setOption(info.key, !on);
                setPop(p => p + 1);
            }}
            aria-pressed={on}
        >
            <span key={pop} className={classes(cl("tile-icon"), pop > 0 && cl("pop"))}><Icon name={info.icon} size={16} /></span>
            <span className={cl("tile-text")}>
                <span className={cl("tile-label")}>{info.short}</span>
                <span className={cl("tile-state")}>{on ? "On" : "Off"}</span>
            </span>
            <Toggle checked={on} />
        </button>
        </Tip>
    );
}

function CurtainButton({ onAfter }: { onAfter?(): void; }) {
    const curtain = useCurtainShown();
    const { panicHotkey } = getConfig();
    settings.use(["panicKey"]);
    return (
        <button
            className={classes(cl("curtain-btn"), curtain && cl("curtain-btn-active"))}
            onClick={() => {
                onAfter?.();
                toggleCurtain();
            }}
        >
            <span className={cl("curtain-btn-icon")}><MaskIcon size={20} /></span>
            <span className={cl("row-text")}>
                <span className={cl("row-label")}>Activate curtain now</span>
                <span className={cl("row-hint")}>Covers Discord instantly</span>
            </span>
            {panicHotkey && <Kbd keys={keybindParts(getPanicKey())} />}
        </button>
    );
}

function StatusPanel({ goTo }: { goTo(t: TabId): void; }) {
    const { summary } = useAudit();
    const tone = summary.highWarn ? "bad" : summary.warn ? "warn" : "good";
    const pct = summary.total ? Math.round((summary.ok / summary.total) * 100) : 0;

    return (
        <div className={classes(cl("state"), cl(`state-${tone}`))}>
            <span className={cl("state-shield")}>
                <Icon name={tone === "good" ? "shieldCheck" : "warning"} size={28} />
            </span>
            <div className={cl("state-body")}>
                <span className={cl("state-title")}>
                    {tone === "good" ? "You are protected" : tone === "warn" ? "Almost fully protected" : "Action required"}
                </span>
                <span className={cl("row-hint")}>
                    {summary.ok} of {summary.total} checks passed
                    {summary.warn ? ` · ${summary.warn} open${summary.highWarn ? `, ${summary.highWarn} important` : ""}` : ""}
                </span>
                <span className={cl("meter")}><span className={cl("meter-fill")} style={{ width: `${pct}%` }} /></span>
            </div>
            <button className={classes(cl("btn"), tone === "good" && cl("btn-ghost"))} onClick={() => goTo("check")}>
                {tone === "good" ? "Details" : "Fix"}
            </button>
        </div>
    );
}

function Stats() {
    const { profile } = settings.use();
    const config = getConfig();
    const keys = TILES.filter(k => !OPTIONS[k].hidden);
    const active = keys.filter(k => config[k]).length;

    return (
        <div className={cl("stats")}>
            <div className={cl("stat")}>
                <span className={cl("stat-label")}>Modules active</span>
                <span className={cl("stat-value")}>{active}<span className={cl("stat-dim")}> / {keys.length}</span></span>
            </div>
            <div className={cl("stat")}>
                <span className={cl("stat-label")}>Profile</span>
                <span className={cl("stat-value")}>{PROFILES.find(p => p.value === profile)?.label ?? "Standard"}</span>
            </div>
            <div className={cl("stat")}>
                <span className={cl("stat-label")}>Panic key</span>
                <span className={cl("stat-value")}>{config.panicHotkey ? <Kbd keys={keybindParts(getPanicKey())} /> : <span className={cl("stat-dim")}>Off</span>}</span>
            </div>
        </div>
    );
}

function OverviewTab({ goTo, close }: { goTo(t: TabId): void; close?(): void; }) {
    settings.use();
    const config = getConfig();

    return (
        <>
            <StatusPanel goTo={goTo} />
            <Stats />
            <CurtainButton onAfter={close} />

            <SectionTitle>Profile</SectionTitle>
            <ProfilePicker />

            <SectionTitle right={<button className={cl("link-btn")} onClick={() => goTo("protection")}>All modules</button>}>
                Quick access
            </SectionTitle>
            <div className={cl("tiles")}>
                {TILES.filter(k => !OPTIONS[k].hidden).map(k => <Tile key={k} info={OPTIONS[k]} on={config[k]} />)}
            </div>
        </>
    );
}

// ---------------------------------------------------------------- Protection

const GROUPS: { title: string; icon: IconName; keys: ConfigKey[]; }[] = [
    { title: "Stealth", icon: "eyeOff", keys: ["silentTyping", "hideActivity", "invisibleStatus"] },
    { title: "Links", icon: "link", keys: ["dangerousLinkWarning", "scamBlocklist", "cleanSentLinks", "cleanClickedLinks", "confirmExternalLinks"] },
    { title: "Files", icon: "photo", keys: ["stripMetadata", "anonymizeFilenames", "uploadEditor"] },
    { title: "Screen", icon: "monitor", keys: ["contentProtection"] },
    { title: "Streaming", icon: "cast", keys: ["screenshareGuard"] }
];

const EDITOR_MODES: { value: UploadEditorMode; label: string; }[] = [
    { value: "ask", label: "Ask first" },
    { value: "always", label: "Always open" }
];

// ---------------------------------------------------------------- Scam blocklist

function useBlocklist() {
    const forceUpdate = useForceUpdater();
    useEffect(() => onBlocklistChange(forceUpdate), []);
    return getBlocklistStatus();
}

function formatAge(ts: number) {
    if (!ts) return "never";
    const min = Math.round((Date.now() - ts) / 60_000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    if (h < 48) return `${h} hr ago`;
    return `${Math.round(h / 24)} days ago`;
}

function BlocklistStatus({ enabled }: { enabled: boolean; }) {
    const st = useBlocklist();
    const update = async () => {
        const ok = await refreshBlocklist(true);
        showToast(ok ? `OpSec: Blocklist updated (${getBlocklistStatus().count.toLocaleString("en-US")} domains)` : "OpSec: Failed to load blocklist", ok ? "success" : "failure");
    };

    return (
        <div className={classes(cl("row"), cl("row-sub"), cl("row-static"), !enabled && cl("row-disabled"))}>
            <span className={cl("row-text")}>
                <span className={cl("row-label")}>
                    {st.count ? `${st.count.toLocaleString("en-US")} domains` : "Not loaded yet"}
                    {st.failed && <span className={cl("pill-danger")}>Error</span>}
                </span>
                <span className={cl("row-hint")}>Updated {formatAge(st.updated)} · Source: {BLOCKLIST_SOURCE} · automatically every 12 hr</span>
            </span>
            <button className={classes(cl("btn"), cl("btn-small"), cl("btn-ghost"))} disabled={!enabled || st.loading} onClick={update}>
                {st.loading ? <span className={cl("spinner")} /> : <Icon name="restore" size={14} />}
                {st.loading ? "Loading…" : "Update now"}
            </button>
        </div>
    );
}

// ---------------------------------------------------------------- Streaming protection

function useGuard() {
    const forceUpdate = useForceUpdater();
    useEffect(() => onGuardChange(forceUpdate), []);
    return { active: isGuardActive(), preview: isGuardPreview() };
}

function GuildIcon({ id, icon, name }: { id: string; icon?: string | null; name: string; }) {
    const url = icon ? IconUtils.getGuildIconURL({ id, icon, size: 64, canAnimate: false }) : undefined;
    return url
        ? <img className={cl("guild-icon")} src={url} alt="" />
        : <span className={cl("guild-icon")}>{name.split(/\s+/).map(w => w[0]).join("").slice(0, 3)}</span>;
}

function GuildChannels({ guildId, hidden }: { guildId: string; hidden: Set<string>; }) {
    const channels = useMemo(() => {
        try {
            const list = (GuildChannelStore.getChannels(guildId)?.SELECTABLE ?? []) as any[];
            return list.map(c => c.channel).filter(Boolean) as { id: string; name: string; }[];
        } catch {
            return [];
        }
    }, [guildId]);

    if (!channels.length) return <div className={classes(cl("row-hint"), cl("guild-channels"))}>No channels found.</div>;

    return (
        <div className={cl("guild-channels")}>
            {channels.map(c => (
                <Tip key={c.id} text={hidden.has(c.id) ? "Hidden on stream" : "Hide on stream"}>
                    <button
                        className={classes(cl("chip"), hidden.has(c.id) && cl("chip-on"))}
                        onClick={() => toggleId("guardHiddenChannels", c.id, !hidden.has(c.id))}
                    >
                        {hidden.has(c.id) && <Icon name="eyeOff" size={12} />}# {c.name}
                    </button>
                </Tip>
            ))}
        </div>
    );
}

function GuardPicker({ disabled }: { disabled: boolean; }) {
    settings.use(["guardHiddenGuilds", "guardHiddenChannels"]);
    // Only compare a string – a new array per query would re-render endlessly
    const guildKey = useStateFromStores([GuildStore], () => (GuildStore.getGuildIds?.() ?? []).join(","));
    const guilds = useMemo(() => GuildStore.getGuildsArray?.() ?? [], [guildKey]);
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState<string | null>(null);

    const hiddenGuilds = new Set(getIdList("guardHiddenGuilds"));
    const hiddenChannels = new Set(getIdList("guardHiddenChannels"));
    const q = query.trim().toLowerCase();
    const list = [...guilds]
        .filter(g => !q || g.name.toLowerCase().includes(q))
        .sort((a, b) => Number(hiddenGuilds.has(b.id)) - Number(hiddenGuilds.has(a.id)) || a.name.localeCompare(b.name));
    const ids = list.map(g => g.id);
    const allHidden = ids.every(id => hiddenGuilds.has(id));
    const noneHidden = !ids.some(id => hiddenGuilds.has(id));

    return (
        <div className={classes(cl("card-pad"), cl("row-sub"), disabled && cl("row-disabled"))}>
            <div className={cl("range-head")}>
                <span className={cl("row-label")}>Hide on stream</span>
                <span className={cl("range-value")}>{hiddenGuilds.size} {hiddenGuilds.size === 1 ? "server" : "servers"} · {hiddenChannels.size} {hiddenChannels.size === 1 ? "channel" : "channels"}</span>
            </div>
            <input className={cl("input")} value={query} placeholder="Search servers …" onChange={e => setQuery(e.currentTarget.value)} disabled={disabled} />
            <div className={cl("guild-bulk")}>
                <button className={classes(cl("btn"), cl("btn-small"), cl("btn-ghost"))} disabled={disabled || allHidden} onClick={() => setIds("guardHiddenGuilds", ids, true)}>
                    <Icon name="eyeOff" size={14} /> {q ? `Hide ${list.length} found` : "Hide all"}
                </button>
                <button className={classes(cl("btn"), cl("btn-small"), cl("btn-ghost"))} disabled={disabled || noneHidden} onClick={() => setIds("guardHiddenGuilds", ids, false)}>
                    <Icon name="eye" size={14} /> {q ? `Unhide ${list.length} found` : "Unhide all"}
                </button>
            </div>
            <div className={cl("guild-list")}>
                {list.map(g => {
                    const on = hiddenGuilds.has(g.id);
                    const expanded = open === g.id;
                    return (
                        <div key={g.id} className={classes(cl("guild"), on && cl("guild-on"))}>
                            <div
                                className={cl("guild-row")}
                                role="switch"
                                aria-checked={on}
                                aria-disabled={disabled}
                                tabIndex={disabled ? -1 : 0}
                                onClick={() => !disabled && toggleId("guardHiddenGuilds", g.id, !on)}
                                onKeyDown={e => {
                                    if (disabled || (e.key !== " " && e.key !== "Enter")) return;
                                    e.preventDefault();
                                    toggleId("guardHiddenGuilds", g.id, !on);
                                }}
                            >
                                <GuildIcon id={g.id} icon={g.icon} name={g.name} />
                                <span className={cl("guild-name")}>{g.name}</span>
                                {on && <span className={cl("guild-badge")}><Icon name="eyeOff" size={12} /> Hidden</span>}
                                <Tip text="Hide individual channels">
                                    <button
                                        className={classes(cl("icon-btn"), cl("guild-expand"), expanded && cl("guild-expand-open"))}
                                        disabled={disabled}
                                        onClick={e => { e.stopPropagation(); setOpen(expanded ? null : g.id); }}
                                        onKeyDown={e => e.stopPropagation()}
                                    >
                                        <Icon name="chevron" size={16} />
                                    </button>
                                </Tip>
                                <Toggle checked={on} disabled={disabled} />
                            </div>
                            {expanded && <GuildChannels guildId={g.id} hidden={hiddenChannels} />}
                        </div>
                    );
                })}
                {!list.length && <div className={cl("row-hint")}>No servers found.</div>}
            </div>
        </div>
    );
}

function GuardSettings({ enabled }: { enabled: boolean; }) {
    const s = settings.use(["guardNotifications", "guardBlurDms", "guardRevealOnHover", "guardStreamerMode"]);
    const { active, preview } = useGuard();
    const off = !enabled;

    return <>
        <div className={classes(cl("row"), cl("row-sub"), cl("row-static"), off && cl("row-disabled"))}>
            <span className={cl("row-text")}>
                <span className={cl("row-label")}>
                    <span className={classes(cl("dot"), active ? cl("dot-live") : cl("dot-idle"))} />
                    {active ? "Active – you are streaming" : preview ? "Preview running" : "Waiting for your next stream"}
                </span>
                <span className={cl("row-hint")}>Test shows blurring & hiding for 12 seconds without streaming.</span>
            </span>
            <button className={classes(cl("btn"), cl("btn-small"), preview && cl("btn-ghost"))} disabled={off || active} onClick={() => preview ? stopPreview() : previewGuard(12)}>
                <Icon name={preview ? "eyeOff" : "play"} size={14} /> {preview ? "Stop" : "Test"}
            </button>
        </div>
        <ToggleRow sub disabled={off} checked={s.guardBlurDms} onChange={v => settings.store.guardBlurDms = v}
            label="Blur DMs" hint="Direct message list and DM avatars in the server bar." />
        <ToggleRow sub disabled={off || !s.guardBlurDms} checked={s.guardRevealOnHover} onChange={v => settings.store.guardRevealOnHover = v}
            label="Reveal on hover" hint="Briefly uncover with the mouse – viewers will see it too." />
        <ToggleRow sub disabled={off} checked={s.guardNotifications} onChange={v => settings.store.guardNotifications = v}
            label="Mute notifications" hint="No desktop popups & sounds from Discord, no Vencord popups. Uses Discord's Streamer Mode (turned on along with it)." />
        <ToggleRow sub disabled={off} checked={s.guardStreamerMode} onChange={v => settings.store.guardStreamerMode = v}
            label="Turn on Discord's Streamer Mode" hint="Hides email, connections and invite links, among other things. Your previous state is restored afterwards." />
        <GuardPicker disabled={off} />
    </>;
}

function ProtectionTab() {
    const store = settings.use();
    const config = getConfig();

    const sub = (key: ConfigKey): ReactNode => {
        switch (key) {
            case "dangerousLinkWarning":
                return <>
                    <ToggleRow sub disabled={!config.dangerousLinkWarning} checked={store.highlightIpLoggers} onChange={v => settings.store.highlightIpLoggers = v}
                        label="Mark IP loggers red in chat" />
                    <ToggleRow sub disabled={!config.dangerousLinkWarning} checked={store.warnShorteners} onChange={v => settings.store.warnShorteners = v}
                        label="Also warn about short links" hint="bit.ly, tinyurl … the destination isn't visible before clicking." />
                </>;
            case "scamBlocklist":
                return <BlocklistStatus enabled={config.scamBlocklist} />;
            case "stripMetadata":
                return <ToggleRow sub disabled={!config.stripMetadata} checked={store.showUploadToast} onChange={v => settings.store.showUploadToast = v}
                    label="Show what was removed" />;
            case "uploadEditor":
                return (
                    <div className={classes(cl("card-pad"), cl("row-sub"), !config.uploadEditor && cl("row-disabled"))}>
                        <Segmented small value={store.uploadEditorMode as UploadEditorMode} options={EDITOR_MODES} onChange={v => settings.store.uploadEditorMode = v} />
                        <span className={cl("row-hint")}>
                            {store.uploadEditorMode === "always" ? "Every image opens the editor before sending." : "Ask briefly before each image: \"Edit image?\""} Closing = send the original (metadata is still stripped)."
                        </span>
                    </div>
                );
            case "screenshareGuard":
                return <GuardSettings enabled={config.screenshareGuard} />;
            case "anonymizeFilenames":
                return <ToggleRow sub disabled={!config.anonymizeFilenames} checked={store.anonymizeAllFiles} onChange={v => settings.store.anonymizeAllFiles = v}
                    label="Also rename documents" hint="Otherwise PDFs, ZIPs etc. keep their name – which is usually important there." />;
        }
        return null;
    };

    return (
        <>
            <SectionTitle icon="shieldCheck">Profile</SectionTitle>
            <ProfilePicker compact />
            <div className={cl("row-hint")}>Your original Discord settings are remembered and restored when turned off.</div>

            {GROUPS.map(g => {
                const keys = g.keys.filter(k => !OPTIONS[k].hidden);
                if (!keys.length) return null;
                return (
                    <div key={g.title} className={cl("group")}>
                        <SectionTitle icon={g.icon}>{g.title}</SectionTitle>
                        <div className={cl("card")}>
                            {keys.map(k => (
                                <div key={k}>
                                    <ToggleRow icon={OPTIONS[k].icon} checked={config[k]} onChange={v => setOption(k, v)} label={OPTIONS[k].label} hint={OPTIONS[k].hint} />
                                    {sub(k)}
                                </div>
                            ))}
                        </div>
                    </div>
                );
            })}

            <div className={cl("group")}>
                <SectionTitle icon="settings">General</SectionTitle>
                <div className={cl("card")}>
                    <ToggleRow icon="monitor" checked={store.showTitleBarButton} onChange={v => settings.store.showTitleBarButton = v}
                        label="Icon in the title bar" hint="When hidden, you can reach OpSec via Settings → Vencord → Plugins." />
                </div>
            </div>
        </>
    );
}

// ---------------------------------------------------------------- Curtain

const STYLES: { value: CurtainStyle; label: string; }[] = [
    { value: "mask", label: "Eye" },
    { value: "glass", label: "Frosted glass" },
    { value: "black", label: "Black" },
    { value: "update", label: "Update" },
    { value: "matrix", label: "Matrix" },
    { value: "radar", label: "Radar" },
    { value: "aurora", label: "Aurora" },
    { value: "lock", label: "Lock screen" },
    { value: "terminal", label: "Terminal" },
    { value: "bsod", label: "Blue screen" }
];

/** Disguise styles show something entirely different – there is no icon and no custom look */
const DISGUISES: CurtainStyle[] = ["update", "bsod"];

const ICON_CHOICES: { value: CurtainIconName; label: string; }[] = [
    { value: "eyeOff", label: "Eye" },
    { value: "lock", label: "Lock" },
    { value: "shield", label: "Shield" },
    { value: "ghost", label: "Ghost" },
    { value: "skull", label: "Skull" },
    { value: "moon", label: "Moon" },
    { value: "coffee", label: "Coffee" },
    { value: "custom", label: "Custom" }
];

function CurtainGlyph({ name, size = 18 }: { name: CurtainIconName; size?: number; }) {
    if (name === "custom") return <span className={cl("icon-pick-custom")}>Aa</span>;
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
            <path fill="currentColor" d={CURTAIN_ICONS[name]} />
        </svg>
    );
}

const ANIMATIONS: { value: CurtainAnimation; label: string; }[] = [
    { value: "fade", label: "Fade in" },
    { value: "zoom", label: "Zoom" },
    { value: "shutter", label: "Shutter" },
    { value: "glitch", label: "Glitch" }
];

const ACCENTS = ["#3ddc97", "#4c9bff", "#8b7bff", "#ff5c5c", "#ffb020", "#f4f4f5"];

function MockDiscord() {
    return (
        <div className={cl("mock")} aria-hidden>
            <div className={cl("mock-servers")}>{[0, 1, 2, 3].map(i => <i key={i} />)}</div>
            <div className={cl("mock-channels")}>{[70, 55, 80, 60, 45].map((w, i) => <i key={i} style={{ width: `${w}%` }} />)}</div>
            <div className={cl("mock-chat")}>
                {[[60, 85], [40, 70], [75, 50], [55, 90]].map(([a, b], i) => (
                    <div key={i} className={cl("mock-msg")}>
                        <span className={cl("mock-avatar")} style={{ background: ["#f47b67", "#5865f2", "#3ba55c", "#faa81a"][i] }} />
                        <span className={cl("mock-lines")}><i style={{ width: `${a}%` }} /><i style={{ width: `${b}%` }} /></span>
                    </div>
                ))}
                <div className={cl("mock-input")} />
            </div>
        </div>
    );
}

function CurtainPreview({ options, replay }: { options: CurtainOptions; replay: number; }) {
    const host = useRef<HTMLDivElement>(null);
    const node = useRef<HTMLDivElement | null>(null);
    const structural = [options.style, options.animation, options.showIcon, options.icon, options.iconCustom, options.showText, options.text, options.clickToUnlock, options.hotkeyLabel, options.style === "matrix" || options.style === "terminal" ? options.accent : "", replay];

    useEffect(() => {
        const inst = buildCurtain(options, true);
        node.current = inst.el;
        host.current?.appendChild(inst.el);
        return () => {
            inst.destroy();
            inst.el.remove();
            node.current = null;
        };
    }, structural);

    // Sliders only change CSS variables – no rebuild, no animation restart
    useEffect(() => {
        const n = node.current;
        if (!n) return;
        n.style.setProperty("--opsec-c-accent", options.accent);
        n.style.setProperty("--opsec-c-opacity", String(options.opacity / 100));
        n.style.setProperty("--opsec-c-blur", `${options.blur}px`);
    }, [options.accent, options.opacity, options.blur, ...structural]);

    return (
        <div className={cl("preview")} ref={host}>
            <MockDiscord />
        </div>
    );
}

function Range({ label, value, min, max, unit, onChange, disabled }: {
    label: string; value: number; min: number; max: number; unit: string; onChange(v: number): void; disabled?: boolean;
}) {
    const pct = ((value - min) / (max - min)) * 100;
    return (
        <label className={classes(cl("range"), disabled && cl("row-disabled"))}>
            <span className={cl("range-head")}>
                <span className={cl("row-label")}>{label}</span>
                <span className={cl("range-value")}>{value}{unit}</span>
            </span>
            <input
                type="range" min={min} max={max} value={value} disabled={disabled}
                style={{ "--pct": `${pct}%` } as any}
                onChange={e => onChange(Number(e.currentTarget.value))}
            />
        </label>
    );
}

function KeybindRecorder() {
    const { panicKey } = settings.use(["panicKey"]);
    const current = getPanicKey();
    const [rec, setRec] = useState(false);
    const [live, setLive] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(0);

    useEffect(() => {
        if (!rec) return;
        recording.active = true;
        setLive([]);
        setError(null);

        const partsOf = (e: KeyboardEvent) => [e.ctrlKey && "Ctrl", e.shiftKey && "Shift", e.altKey && "Alt", e.metaKey && "Win"].filter(Boolean) as string[];

        const onDown = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.code === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) return setRec(false);
            if (isModifierCode(e.code)) return setLive(partsOf(e));

            const k: Keybind = keybindFromEvent(e);
            if (!isValidKeybind(k)) {
                setLive(keybindParts(k));
                setError("Combine with Ctrl, Alt or Win – or use an F key.");
                return;
            }
            settings.store.panicKey = serializeKeybind(k);
            setSaved(s => s + 1);
            setRec(false);
        };
        const onUp = (e: KeyboardEvent) => setLive(partsOf(e));

        window.addEventListener("keydown", onDown, true);
        window.addEventListener("keyup", onUp, true);
        return () => {
            recording.active = false;
            window.removeEventListener("keydown", onDown, true);
            window.removeEventListener("keyup", onUp, true);
        };
    }, [rec]);

    const conflict = keybindConflict(current);

    return (
        <div className={cl("keybind")}>
            <button
                className={classes(cl("keybind-box"), rec && cl("keybind-rec"))}
                onClick={() => setRec(r => !r)}
            >
                {rec
                    ? live.length
                        ? <Kbd keys={[...live, "…"]} live />
                        : <span className={cl("keybind-prompt")}>Press your key combination …</span>
                    : <span key={saved} className={saved ? cl("flash") : undefined}><Kbd keys={keybindParts(current)} /></span>}
                <span className={cl("keybind-action")}>{rec ? "Esc = Cancel" : "Change"}</span>
            </button>
            {panicKey !== DEFAULT_KEYBIND && !rec && (
                <Tip text="Reset to Ctrl + Shift + L">
                    <button className={cl("icon-btn")} onClick={() => settings.store.panicKey = DEFAULT_KEYBIND}>
                        <Icon name="restore" size={16} />
                    </button>
                </Tip>
            )}
            {error && rec && <div className={classes(cl("row-hint"), cl("text-warn"))}>{error}</div>}
            {!rec && conflict && <div className={classes(cl("row-hint"), cl("text-warn"))}>Overrides "{conflict}".</div>}
        </div>
    );
}

function CurtainTab({ close }: { close?(): void; }) {
    const s = settings.use();
    const config = getConfig();
    const options = getCurtainOptions();
    const [replay, setReplay] = useState(0);
    const usesLook = !DISGUISES.includes(s.curtainStyle as CurtainStyle);
    const usesIcon = usesLook && s.curtainStyle !== "terminal";

    return (
        <>
            <div className={cl("preview-wrap")}>
                <CurtainPreview options={options} replay={replay} />
                <div className={cl("preview-actions")}>
                    <button className={classes(cl("btn"), cl("btn-ghost"), cl("btn-small"))} onClick={() => setReplay(r => r + 1)}>
                        <Icon name="play" size={14} /> Replay
                    </button>
                    <button className={classes(cl("btn"), cl("btn-small"))} onClick={() => { close?.(); setTimeout(() => showCurtain("manual"), close ? 150 : 0); }}>
                        <MaskIcon size={14} /> Test for real
                    </button>
                </div>
            </div>

            <SectionTitle icon="mask">Style</SectionTitle>
            <div className={cl("styles")}>
                {STYLES.map(st => (
                    <button
                        key={st.value}
                        className={classes(cl("style"), s.curtainStyle === st.value && cl("style-active"))}
                        onClick={() => settings.store.curtainStyle = st.value}
                    >
                        <span className={classes(cl("style-thumb"), cl(`thumb-${st.value}`))} style={{ "--opsec-c-accent": s.curtainAccent } as any}>
                            {st.value === "update"
                                ? <span className={cl("thumb-dots")} />
                                : st.value === "bsod"
                                    ? <span className={cl("thumb-sad")}>:(</span>
                                    : st.value === "terminal"
                                        ? <span className={cl("thumb-term")}>&gt;_</span>
                                        : st.value === "lock"
                                            ? <span className={cl("thumb-clock")}>12:30</span>
                                            : st.value !== "matrix" && <MaskIcon size={16} />}
                        </span>
                        <span>{st.label}</span>
                    </button>
                ))}
            </div>
            {s.curtainStyle === "update" && <div className={cl("row-hint")}>Disguises Discord as a running Windows update – nobody suspects a chat behind it.</div>}
            {s.curtainStyle === "bsod" && <div className={cl("row-hint")}>Disguises Discord as a Windows blue screen with counting-up progress.</div>}
            {s.curtainStyle === "terminal" && <div className={cl("row-hint")}>A terminal like in a hacker movie: types commands, runs progress bars and hex lines – endlessly. Your text appears as the window title.</div>}

            <SectionTitle icon="play">Animation</SectionTitle>
            <Segmented small value={s.curtainAnimation as CurtainAnimation} options={ANIMATIONS} onChange={v => { settings.store.curtainAnimation = v; setReplay(r => r + 1); }} />

            {usesLook && <>
                <SectionTitle icon="tune">Appearance</SectionTitle>
                <div className={cl("card")}>
                    <div className={cl("card-pad")}>
                        <Range label="Opacity" value={s.curtainOpacity} min={40} max={100} unit="%" onChange={v => settings.store.curtainOpacity = v} disabled={s.curtainStyle === "black"} />
                        <Range label="Blur" value={s.curtainBlur} min={0} max={40} unit=" px" onChange={v => settings.store.curtainBlur = v} disabled={s.curtainStyle === "black"} />
                        <div className={cl("range-head")}><span className={cl("row-label")}>Accent color</span></div>
                        <div className={cl("swatches")}>
                            {ACCENTS.map(a => (
                                <Tip key={a} text={a.toUpperCase()}>
                                    <button className={classes(cl("swatch"), s.curtainAccent.toLowerCase() === a && cl("swatch-active"))} style={{ background: a }} onClick={() => settings.store.curtainAccent = a} aria-label={a} />
                                </Tip>
                            ))}
                            <Tip text="Custom color">
                                <label className={classes(cl("swatch"), cl("swatch-custom"), !ACCENTS.includes(s.curtainAccent.toLowerCase()) && cl("swatch-active"))}>
                                    <input type="color" value={s.curtainAccent} onChange={e => settings.store.curtainAccent = e.currentTarget.value} />
                                </label>
                            </Tip>
                        </div>
                    </div>
                    {usesIcon && <ToggleRow icon="mask" checked={s.curtainShowIcon} onChange={v => settings.store.curtainShowIcon = v} label="Show icon" />}
                    {usesIcon && s.curtainShowIcon && (
                        <div className={cl("card-pad")}>
                            <div className={cl("icon-picks")}>
                                {ICON_CHOICES.map(i => (
                                    <Tip key={i.value} text={i.label}>
                                        <button
                                            aria-label={i.label}
                                            className={classes(cl("icon-pick"), s.curtainIcon === i.value && cl("icon-pick-active"))}
                                            onClick={() => settings.store.curtainIcon = i.value}
                                        >
                                            <CurtainGlyph name={i.value} />
                                        </button>
                                    </Tip>
                                ))}
                            </div>
                            {s.curtainIcon === "custom" && (
                                <input
                                    className={cl("input")}
                                    value={s.curtainIconCustom}
                                    maxLength={300}
                                    placeholder="Emoji (e.g. 🍕) or image link (https://…)"
                                    onChange={e => settings.store.curtainIconCustom = e.currentTarget.value}
                                />
                            )}
                        </div>
                    )}
                    <ToggleRow icon="file" checked={s.curtainShowText} onChange={v => settings.store.curtainShowText = v} label="Show text" hint="Enter your own text below – leave empty for the default text." />
                    {s.curtainShowText && (
                        <div className={cl("card-pad")}>
                            <input
                                className={cl("input")}
                                value={s.curtainText}
                                maxLength={60}
                                placeholder={DEFAULT_CURTAIN_TEXT}
                                onChange={e => settings.store.curtainText = e.currentTarget.value}
                            />
                        </div>
                    )}
                </div>
            </>}

            <SectionTitle icon="bolt">Trigger & unlock</SectionTitle>
            <div className={cl("card")}>
                <ToggleRow icon="bolt" checked={config.panicHotkey} onChange={v => setOption("panicHotkey", v)} label="Panic key" hint="Instantly covers Discord, press again to unlock." />
                {config.panicHotkey && <div className={cl("card-pad")}><KeybindRecorder /></div>}
                <ToggleRow icon="eye" checked={config.curtainOnBlur} onChange={v => setOption("curtainOnBlur", v)} label="Cover when you click away" hint="As soon as another window is active. Clicking back removes it." />
                <ToggleRow
                    icon="eyeOff"
                    checked={!s.curtainClickUnlock && config.panicHotkey}
                    disabled={!config.panicHotkey}
                    onChange={v => settings.store.curtainClickUnlock = !v}
                    label="Unlock only with panic key"
                    hint={config.panicHotkey ? "A click doesn't remove the curtain – anyone who doesn't know the key can't get in." : "Requires an active panic key."}
                />
            </div>
        </>
    );
}

// ---------------------------------------------------------------- Full UI

export function OpSecApp({ variant, close }: { variant: "popout" | "modal"; close?(): void; }) {
    const { lastTab } = settings.use(["lastTab"]);
    const tab = (TABS.some(t => t.id === lastTab) ? lastTab : "overview") as TabId;
    const goTo = (t: TabId) => settings.store.lastTab = t;

    return (
        <div className={classes(cl("app"), cl(`app-${variant}`), cl("no-intercept"), "vc-keep-motion")}>
            <Sidebar value={tab} onChange={goTo} />
            <main className={cl("main")}>
                <div className={cl("scroller")}>
                    <div key={tab} className={cl("pane")}>
                        {tab === "overview" && <OverviewTab goTo={goTo} close={close} />}
                        {tab === "protection" && <ProtectionTab />}
                        {tab === "curtain" && <CurtainTab close={close} />}
                        {tab === "check" && <CheckTab />}
                    </div>
                </div>
            </main>
        </div>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(() => <OpSecApp variant="modal" />, { noop: true });

// ---------------------------------------------------------------- Link warning

export function showLinkWarning(url: string, analysis: LinkAnalysis, open: () => void) {
    const danger = analysis.risk === "danger";
    const warn = analysis.risk === "warn";

    Alerts.show({
        title: danger ? "Dangerous link" : warn ? "Be careful with this link" : "Open external link?",
        body: (
            <div className={classes(cl("link-warning"), cl("no-intercept"), "vc-keep-motion")}>
                <div className={classes(cl("link-badge"), danger ? cl("link-badge-danger") : warn ? cl("link-badge-warn") : cl("link-badge-info"))}>
                    <Icon name={danger || warn ? "warning" : "link"} size={28} />
                </div>
                {analysis.reason
                    ? <div className={classes(cl("link-reason"), danger ? cl("link-danger") : cl("link-warn"))}>{analysis.reason}</div>
                    : <div className={cl("row-hint")}>The site learns your IP address when you open it.</div>}
                <div className={cl("link-host")}>{analysis.host || url}</div>
                <div className={cl("link-url")}>{url}</div>
            </div>
        ),
        confirmText: danger ? "Open anyway" : "Open",
        cancelText: "Cancel",
        onConfirm: open
    });
}

// ---------------------------------------------------------------- Title bar

function TitleBarButton() {
    const { showTitleBarButton, profile } = settings.use(["showTitleBarButton", "profile"]);
    const buttonRef = useRef(null);
    const [show, setShow] = useState(false);

    if (!showTitleBarButton) return null;

    return (
        <Popout
            position="bottom"
            align="left"
            animation={Popout.Animation.NONE}
            shouldShow={show}
            onRequestClose={() => setShow(false)}
            targetElementRef={buttonRef}
            renderPopout={() => (
                <ErrorBoundary noop>
                    <div className={classes(cl("popout"), "vc-keep-motion")}>
                        <OpSecApp variant="popout" close={() => setShow(false)} />
                    </div>
                </ErrorBoundary>
            )}
        >
            {(_, { isShown }) => (
                <HeaderBarIcon
                    ref={buttonRef}
                    className={classes(cl("btn-titlebar"), profile === "paranoid" && cl("btn-titlebar-hot"))}
                    onClick={() => setShow(v => !v)}
                    tooltip={isShown ? null : "OpSec"}
                    icon={() => <MaskIcon />}
                    selected={isShown}
                />
            )}
        </Popout>
    );
}

export function renderTitleBarButton() {
    return (
        <ErrorBoundary key="vc-opsec-titlebar" noop>
            <TitleBarButton />
        </ErrorBoundary>
    );
}
