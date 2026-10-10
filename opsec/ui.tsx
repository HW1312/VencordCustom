/*
 * OpSec – UI: title bar button, popout (Overview / Protection / Curtain / Check),
 * settings (same UI in the plugin settings), link warning, streaming protection picker
 * (servers/channels) and scam blocklist status. Built with the shared _ui kit.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { useForceUpdater } from "@utils/react";
import { findComponentByCodeLazy } from "@webpack";
import { ConnectedAccountsStore, GuildChannelStore, GuildStore, IconUtils, Popout, React, Tooltip, useEffect, useMemo, useRef, UserSettingsProtoStore, UserStore, useState, useStateFromStores } from "@webpack/common";
import type { ReactNode } from "react";

import { AppIcon, Badge, Button, confirm, Glyph, Group, Icon, IconButton, ICONS as UI_ICONS, notify, NotifyKind, Pill, Pills, Popover, Progress, Row, SearchField, Section, Segmented, Sheet, Slider, Spinner, State, Stats, TextField, Toggle, ToggleRow, UiColor } from "../_ui";
import { Check, CHECKS, CheckStatus, getAuditSummary, loadConsents, onConsentsChange, runFix } from "./audit";
import { BLOCKLIST_SOURCE, getBlocklistStatus, onBlocklistChange, refreshBlocklist } from "./blocklist";
import { buildCurtain, CURTAIN_ICONS, CurtainAnimation, CurtainIconName, CurtainOptions, CurtainStyle, DEFAULT_CURTAIN_TEXT, isCurtainShown, MASK_PATH, onCurtainChange, showCurtain, toggleCurtain } from "./curtain";
import { getConfig, getCurtainOptions, getIdList, getPanicKey, setIds, setOption, setProfile, settings, toggleId, UploadEditorMode } from "./index";
import { DEFAULT_KEYBIND, isModifierCode, isValidKeybind, Keybind, keybindConflict, keybindFromEvent, keybindParts, recording, serializeKeybind } from "./keybind";
import type { LinkAnalysis } from "./links";
import { ConfigKey, Profile } from "./profiles";
import { isGuardActive, isGuardPreview, onGuardChange, previewGuard, stopPreview } from "./stream";

const cl = classNameFactory("vc-opsec-");
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

const PLATFORM = navigator.platform.toLowerCase();
const HAS_CONTENT_PROTECTION = PLATFORM.startsWith("win") || PLATFORM.startsWith("mac");

/** App icon color of OpSec (window header, settings) */
export const OPSEC_COLOR: UiColor = "mint";

/** Plugin event notification (replaces Discord toasts); strips the old "OpSec: " prefix, the app name shows it */
export function opsecNotify(text: string, kind: NotifyKind = "success") {
    notify({ title: text.replace(/^OpSec: /, ""), kind, app: "OpSec" });
}

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
    bolt: "M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66.19-.34.05-.08.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15C12.96 17.55 11 21 11 21z",
    play: "M8 5v14l11-7z",
    cast: "M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2a9 9 0 0 1 9 9h2c0-6.08-4.93-11-11-11z",
    brush: "M7 14c-1.66 0-3 1.34-3 3 0 1.31-1.16 2-2 2 .92 1.22 2.49 2 4 2 2.21 0 4-1.79 4-4 0-1.66-1.34-3-3-3zm13.71-9.37-1.34-1.34a.996.996 0 0 0-1.41 0L9 12.25 11.75 15l8.96-8.96a.996.996 0 0 0 0-1.41z",
    block: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9A7.902 7.902 0 0 1 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1A7.902 7.902 0 0 1 20 12c0 4.42-3.58 8-8 8z",
    restore: "M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18z",
    mask: MASK_PATH,
    question: "M12 5a4 4 0 0 1 4 4c0 1.6-1 2.4-1.8 3-.7.5-1.2.9-1.2 1.8v.7h-2v-.9c0-1.8 1-2.6 1.8-3.2.7-.5 1.2-.9 1.2-1.4a2 2 0 0 0-4 0H8a4 4 0 0 1 4-4Zm-1 11.5h2v2.2h-2z"
};

type IconName = keyof typeof ICONS;

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
    color: UiColor;
    hint: string;
    hidden?: boolean;
}

const OPTIONS: Record<ConfigKey, OptionInfo> = {
    silentTyping: { key: "silentTyping", icon: "keyboard", color: "gray", label: "Type invisibly", short: "Invisible typing", hint: "Others don't see \"… is typing\". Otherwise it reveals that you're online and when you reply." },
    hideActivity: { key: "hideActivity", icon: "game", color: "purple", label: "Hide activity", short: "Hide activity", hint: "No \"Playing …\" / \"Listening to Spotify\". Otherwise it reveals habits and online times." },
    invisibleStatus: { key: "invisibleStatus", icon: "eyeOff", color: "indigo", label: "Status \"Invisible\"", short: "Invisible online", hint: "You appear offline but can use Discord completely normally." },
    dangerousLinkWarning: { key: "dangerousLinkWarning", icon: "warning", color: "orange", label: "Warn about dangerous links", short: "Link protection", hint: "Asks before IP loggers (Grabify & co.), phishing lookalikes (dlscord, steamcommunlty …) or punycode tricks are opened." },
    cleanSentLinks: { key: "cleanSentLinks", icon: "wand", color: "teal", label: "Remove tracking from sent links", short: "Clean links", hint: "Removes utm_, fbclid, YouTube/Spotify \"si\" etc. These reveal who shared the link." },
    cleanClickedLinks: { key: "cleanClickedLinks", icon: "link", color: "teal", label: "Remove tracking from clicked links", short: "Clean clicks", hint: "Links from others are opened without tracking parameters." },
    confirmExternalLinks: { key: "confirmExternalLinks", icon: "link", color: "blue", label: "Confirm every external link", short: "Confirm links", hint: "Every click reveals your IP address to the target site. This way you see exactly where it goes beforehand." },
    scamBlocklist: { key: "scamBlocklist", icon: "block", color: "red", label: "Scam blocklist (online)", short: "Scam blocklist", hint: "Over 35,000 known fake Nitro, Steam and phishing domains. Matches are marked red in chat and only opened after a warning. Only downloads the public list, sends nothing." },
    stripMetadata: { key: "stripMetadata", icon: "photo", color: "green", label: "Strip metadata from images & videos", short: "Strip metadata", hint: "GPS location, device, serial number, capture time, software … (JPEG, PNG, WebP, MP4, MOV). Lossless." },
    anonymizeFilenames: { key: "anonymizeFilenames", icon: "file", color: "blue", label: "Anonymize filenames", short: "Filenames", hint: "\"IMG_20260930_143022.jpg\" or \"Screenshot from Max-PC\" becomes a random name." },
    uploadEditor: { key: "uploadEditor", icon: "brush", color: "pink", label: "Edit images before sending", short: "Image editor", hint: "Crop, redact names & tokens, pixelate, arrows & text – before a screenshot goes out. PNG, JPEG, WebP." },
    contentProtection: { key: "contentProtection", icon: "camOff", color: "red", label: "Capture protection", short: "Capture protection", hint: "Discord is invisible in screenshots, recordings and screen shares – even to your own snipping tool.", hidden: !HAS_CONTENT_PROTECTION },
    curtainOnBlur: { key: "curtainOnBlur", icon: "eye", color: "mint", label: "Cover when you click away", short: "Auto curtain", hint: "As soon as another window is active, Discord is covered. Clicking back removes it." },
    panicHotkey: { key: "panicHotkey", icon: "bolt", color: "yellow", label: "Panic key", short: "Panic key", hint: "Instantly covers Discord with a single key press." },
    screenshareGuard: { key: "screenshareGuard", icon: "cast", color: "purple", label: "Streaming protection", short: "Streaming protection", hint: "While you stream or share your screen: DMs blurred, selected servers & channels hidden, notifications muted." }
};

const TILES: ConfigKey[] = ["silentTyping", "hideActivity", "invisibleStatus", "stripMetadata", "dangerousLinkWarning", "cleanSentLinks", "screenshareGuard", "uploadEditor", "contentProtection", "curtainOnBlur"];

type TabId = "overview" | "protection" | "curtain" | "check";

const TABS: { id: TabId; label: string; }[] = [
    { id: "overview", label: "Overview" },
    { id: "protection", label: "Protection" },
    { id: "curtain", label: "Curtain" },
    { id: "check", label: "Check" }
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

function OptGlyph({ name, color }: { name: IconName; color: UiColor; }) {
    return <Glyph path={ICONS[name]} color={color} />;
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
                <circle cx={size / 2} cy={size / 2} r={r} className={cl("ring-track")} strokeWidth={stroke} />
                <circle
                    cx={size / 2} cy={size / 2} r={r}
                    className={cl("ring-bar")}
                    strokeWidth={stroke}
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

const STATUS_GLYPH: Record<CheckStatus, { path: string; color: UiColor; }> = {
    ok: { path: UI_ICONS.check, color: "green" },
    warn: { path: ICONS.warning, color: "orange" },
    unknown: { path: ICONS.question, color: "gray" }
};

function CheckRow({ check, onDone }: { check: Check; onDone(): void; }) {
    const [busy, setBusy] = useState(false);
    const status = safeStatus(check);

    const fix = async () => {
        setBusy(true);
        try {
            await runFix(check);
        } catch {
            opsecNotify(`OpSec: Failed to change "${check.title}"`, "error");
        } finally {
            setBusy(false);
            onDone();
        }
    };

    return (
        <Row
            align="top"
            leading={<Glyph path={STATUS_GLYPH[status].path} color={STATUS_GLYPH[status].color} />}
            title={<>{check.title}{status === "warn" && check.severity === "high" && <> <Badge color="red">Important</Badge></>}</>}
            subtitle={check.hint}
            trailing={status === "warn" && check.fix
                ? busy ? <Spinner /> : <Button small variant="tinted" onClick={fix}>{check.fixLabel ?? "Fix"}</Button>
                : undefined}
        />
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
        opsecNotify(
            failed ? `OpSec: ${fixable.length - failed} fixed, ${failed} failed` : `OpSec: ${fixable.length} ${fixable.length === 1 ? "setting" : "settings"} secured`,
            failed ? "error" : "success"
        );
    };

    return (
        <>
            <Group className={cl("hero")}>
                <ScoreRing ok={summary.ok} total={summary.total} />
                <div className={cl("hero-text")}>
                    <span className={cl("hero-title")}>
                        {summary.warn ? `${summary.warn} ${summary.warn === 1 ? "recommendation" : "recommendations"} open` : "Everything secured"}
                    </span>
                    <span className={cl("hint")}>
                        {summary.highWarn ? `${summary.highWarn} of them important. ` : ""}Audits your account and Discord's privacy settings.
                    </span>
                    {fixable.length > 0 && (
                        <div>
                            <Button small icon={busy ? undefined : ICONS.shieldCheck} disabled={busy} onClick={fixAll}>
                                {busy ? "Securing…" : fixable.length === 1 ? "Fix" : `Fix all ${fixable.length}`}
                            </Button>
                        </div>
                    )}
                </div>
            </Group>
            <Section title="Checks">
                {sorted.map(c => <CheckRow key={c.id} check={c} onDone={refresh} />)}
            </Section>
        </>
    );
}

// ---------------------------------------------------------------- Overview

function ProfilePicker({ compact }: { compact?: boolean; }) {
    const { profile } = settings.use(["profile"]);
    const current = PROFILES.find(p => p.value === profile) ?? PROFILES[0];
    return (
        <Section title="Profile" footer={compact ? "Your original Discord settings are remembered and restored when turned off." : current.description} plain>
            <Segmented value={current.value} options={PROFILES} onChange={setProfile} />
        </Section>
    );
}

function Tile({ info, on }: { info: OptionInfo; on: boolean; }) {
    return (
        <Tip text={info.hint}>
            <button
                type="button"
                className={classes(cl("tile"), on && cl("tile-on"))}
                onClick={() => setOption(info.key, !on)}
                aria-pressed={on}
            >
                <Glyph path={ICONS[info.icon]} color={on ? info.color : "gray"} size={26} />
                <span className={cl("tile-text")}>
                    <span className={cl("tile-label")}>{info.short}</span>
                    <span className={cl("tile-state")}>{on ? "On" : "Off"}</span>
                </span>
            </button>
        </Tip>
    );
}

function CurtainButton({ onAfter }: { onAfter?(): void; }) {
    const curtain = useCurtainShown();
    const { panicHotkey } = getConfig();
    settings.use(["panicKey"]);
    return (
        <Section>
            <Row
                leading={<Glyph path={MASK_PATH} color={curtain ? "green" : OPSEC_COLOR} />}
                title="Activate curtain now"
                subtitle="Covers Discord instantly"
                trailing={panicHotkey ? <Kbd keys={keybindParts(getPanicKey())} /> : undefined}
                onClick={() => {
                    onAfter?.();
                    toggleCurtain();
                }}
            />
        </Section>
    );
}

function StatusPanel({ goTo }: { goTo(t: TabId): void; }) {
    const { summary } = useAudit();
    const tone = summary.highWarn ? "bad" : summary.warn ? "warn" : "good";
    const color: UiColor = tone === "good" ? "green" : tone === "warn" ? "orange" : "red";
    const pct = summary.total ? Math.round((summary.ok / summary.total) * 100) : 0;

    return (
        <Section>
            <Row
                leading={<AppIcon path={tone === "good" ? ICONS.shieldCheck : ICONS.warning} color={color} size={40} />}
                title={tone === "good" ? "You are protected" : tone === "warn" ? "Almost fully protected" : "Action required"}
                subtitle={`${summary.ok} of ${summary.total} checks passed${summary.warn ? ` · ${summary.warn} open${summary.highWarn ? `, ${summary.highWarn} important` : ""}` : ""}`}
                trailing={<Button small variant={tone === "good" ? "gray" : "filled"} onClick={() => goTo("check")}>{tone === "good" ? "Details" : "Fix"}</Button>}
            >
                <div className={cl("meter")}><Progress value={pct / 100} color={color} /></div>
            </Row>
        </Section>
    );
}

function OverviewStats() {
    const { profile } = settings.use();
    const config = getConfig();
    const keys = TILES.filter(k => !OPTIONS[k].hidden);
    const active = keys.filter(k => config[k]).length;

    return (
        <Stats items={[
            { value: <>{active}<span className={cl("dim")}> / {keys.length}</span></>, label: "Modules active", color: "green" },
            { value: PROFILES.find(p => p.value === profile)?.label ?? "Standard", label: "Profile" },
            { value: config.panicHotkey ? <Kbd keys={keybindParts(getPanicKey())} /> : <span className={cl("dim")}>Off</span>, label: "Panic key" }
        ]} />
    );
}

function OverviewTab({ goTo, close }: { goTo(t: TabId): void; close?(): void; }) {
    settings.use();
    const config = getConfig();

    return (
        <>
            <StatusPanel goTo={goTo} />
            <OverviewStats />
            <CurtainButton onAfter={close} />
            <ProfilePicker />
            <Section title="Quick access" right={<Button small variant="plain" onClick={() => goTo("protection")}>All modules</Button>} plain>
                <div className={cl("tiles")}>
                    {TILES.filter(k => !OPTIONS[k].hidden).map(k => <Tile key={k} info={OPTIONS[k]} on={config[k]} />)}
                </div>
            </Section>
        </>
    );
}

// ---------------------------------------------------------------- Protection

const GROUPS: { title: string; keys: ConfigKey[]; }[] = [
    { title: "Stealth", keys: ["silentTyping", "hideActivity", "invisibleStatus"] },
    { title: "Links", keys: ["dangerousLinkWarning", "scamBlocklist", "cleanSentLinks", "cleanClickedLinks", "confirmExternalLinks"] },
    { title: "Files", keys: ["stripMetadata", "anonymizeFilenames", "uploadEditor"] },
    { title: "Screen", keys: ["contentProtection"] },
    { title: "Streaming", keys: ["screenshareGuard"] }
];

const EDITOR_MODES: { value: UploadEditorMode; label: string; }[] = [
    { value: "ask", label: "Ask first" },
    { value: "always", label: "Always open" }
];

/** Indented option below a module (no glyph) */
function SubToggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange(v: boolean): void; label: ReactNode; hint?: ReactNode; disabled?: boolean; }) {
    return (
        <div className={cl("sub")}>
            <ToggleRow checked={checked} onChange={onChange} title={label} subtitle={hint} disabled={disabled} />
        </div>
    );
}

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
        opsecNotify(ok ? `OpSec: Blocklist updated (${getBlocklistStatus().count.toLocaleString("en-US")} domains)` : "OpSec: Failed to load blocklist", ok ? "success" : "error");
    };

    return (
        <div className={cl("sub")}>
            <Row
                dim={!enabled}
                title={<>{st.count ? `${st.count.toLocaleString("en-US")} domains` : "Not loaded yet"}{st.failed && <> <Badge color="red">Error</Badge></>}</>}
                subtitle={`Updated ${formatAge(st.updated)} · Source: ${BLOCKLIST_SOURCE} · automatically every 12 hr`}
                trailing={
                    <Button small variant="gray" icon={st.loading ? undefined : ICONS.restore} disabled={!enabled || st.loading} onClick={update}>
                        {st.loading ? "Loading…" : "Update now"}
                    </Button>
                }
            />
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

    if (!channels.length) return <div className={classes(cl("hint"), cl("guild-channels"))}>No channels found.</div>;

    return (
        <div className={cl("guild-channels")}>
            <Pills>
                {channels.map(c => (
                    <Pill
                        key={c.id}
                        selected={hidden.has(c.id)}
                        icon={hidden.has(c.id) ? ICONS.eyeOff : undefined}
                        title={hidden.has(c.id) ? "Hidden on stream" : "Hide on stream"}
                        onClick={() => toggleId("guardHiddenChannels", c.id, !hidden.has(c.id))}
                    >
                        # {c.name}
                    </Pill>
                ))}
            </Pills>
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
        <div className={classes(cl("sub"), cl("picker"), disabled && cl("off"))}>
            <div className={cl("picker-head")}>
                <span className={cl("label")}>Hide on stream</span>
                <span className={cl("value")}>{hiddenGuilds.size} {hiddenGuilds.size === 1 ? "server" : "servers"} · {hiddenChannels.size} {hiddenChannels.size === 1 ? "channel" : "channels"}</span>
            </div>
            <SearchField value={query} placeholder="Search servers …" onChange={setQuery} disabled={disabled} />
            <div className={cl("picker-bulk")}>
                <Button small variant="gray" icon={ICONS.eyeOff} disabled={disabled || allHidden} onClick={() => setIds("guardHiddenGuilds", ids, true)}>
                    {q ? `Hide ${list.length} found` : "Hide all"}
                </Button>
                <Button small variant="gray" icon={ICONS.eye} disabled={disabled || noneHidden} onClick={() => setIds("guardHiddenGuilds", ids, false)}>
                    {q ? `Unhide ${list.length} found` : "Unhide all"}
                </Button>
            </div>
            <Group className={cl("guild-list")}>
                {list.map(g => {
                    const on = hiddenGuilds.has(g.id);
                    const expanded = open === g.id;
                    const toggle = () => !disabled && toggleId("guardHiddenGuilds", g.id, !on);
                    return (
                        <div key={g.id}>
                            <Row
                                leading={<GuildIcon id={g.id} icon={g.icon} name={g.name} />}
                                title={g.name}
                                dim={disabled}
                                onClick={disabled ? undefined : toggle}
                                trailing={
                                    <span className={cl("guild-trail")}>
                                        {on && <Badge color="orange" icon={ICONS.eyeOff}>Hidden</Badge>}
                                        <span className={classes(cl("guild-expand"), expanded && cl("guild-expand-open"))}>
                                            <IconButton icon={UI_ICONS.chevron} label="Hide individual channels" disabled={disabled} onClick={e => { e.stopPropagation(); setOpen(expanded ? null : g.id); }} />
                                        </span>
                                        <Toggle checked={on} disabled={disabled} onChange={toggle} label={g.name} />
                                    </span>
                                }
                            />
                            {expanded && <GuildChannels guildId={g.id} hidden={hiddenChannels} />}
                        </div>
                    );
                })}
                {!list.length && <Row title="No servers found." dim />}
            </Group>
        </div>
    );
}

function GuardSettings({ enabled }: { enabled: boolean; }) {
    const s = settings.use(["guardNotifications", "guardBlurDms", "guardRevealOnHover", "guardStreamerMode"]);
    const { active, preview } = useGuard();
    const off = !enabled;

    return <>
        <div className={cl("sub")}>
            <Row
                dim={off}
                title={<State tone={active ? "ok" : preview ? "warn" : undefined}>{active ? "Active – you are streaming" : preview ? "Preview running" : "Waiting for your next stream"}</State>}
                subtitle="Test shows blurring & hiding for 12 seconds without streaming."
                trailing={
                    <Button small variant={preview ? "gray" : "tinted"} icon={preview ? ICONS.eyeOff : ICONS.play} disabled={off || active} onClick={() => preview ? stopPreview() : previewGuard(12)}>
                        {preview ? "Stop" : "Test"}
                    </Button>
                }
            />
        </div>
        <SubToggle disabled={off} checked={s.guardBlurDms} onChange={v => settings.store.guardBlurDms = v}
            label="Blur DMs" hint="Direct message list and DM avatars in the server bar." />
        <SubToggle disabled={off || !s.guardBlurDms} checked={s.guardRevealOnHover} onChange={v => settings.store.guardRevealOnHover = v}
            label="Reveal on hover" hint="Briefly uncover with the mouse – viewers will see it too." />
        <SubToggle disabled={off} checked={s.guardNotifications} onChange={v => settings.store.guardNotifications = v}
            label="Mute notifications" hint="No desktop popups & sounds from Discord, no Vencord popups. Uses Discord's Streamer Mode (turned on along with it)." />
        <SubToggle disabled={off} checked={s.guardStreamerMode} onChange={v => settings.store.guardStreamerMode = v}
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
                    <SubToggle disabled={!config.dangerousLinkWarning} checked={store.highlightIpLoggers} onChange={v => settings.store.highlightIpLoggers = v}
                        label="Mark IP loggers red in chat" />
                    <SubToggle disabled={!config.dangerousLinkWarning} checked={store.warnShorteners} onChange={v => settings.store.warnShorteners = v}
                        label="Also warn about short links" hint="bit.ly, tinyurl … the destination isn't visible before clicking." />
                </>;
            case "scamBlocklist":
                return <BlocklistStatus enabled={config.scamBlocklist} />;
            case "stripMetadata":
                return <SubToggle disabled={!config.stripMetadata} checked={store.showUploadToast} onChange={v => settings.store.showUploadToast = v}
                    label="Show what was removed" />;
            case "uploadEditor":
                return (
                    <div className={classes(cl("sub"), cl("pad"), !config.uploadEditor && cl("off"))}>
                        <Segmented small value={store.uploadEditorMode as UploadEditorMode} options={EDITOR_MODES} onChange={v => settings.store.uploadEditorMode = v} />
                        <span className={cl("hint")}>
                            {store.uploadEditorMode === "always" ? "Every image opens the editor before sending." : "Ask briefly before each image: \"Edit image?\""} Closing = send the original (metadata is still stripped).
                        </span>
                    </div>
                );
            case "screenshareGuard":
                return <GuardSettings enabled={config.screenshareGuard} />;
            case "anonymizeFilenames":
                return <SubToggle disabled={!config.anonymizeFilenames} checked={store.anonymizeAllFiles} onChange={v => settings.store.anonymizeAllFiles = v}
                    label="Also rename documents" hint="Otherwise PDFs, ZIPs etc. keep their name – which is usually important there." />;
        }
        return null;
    };

    return (
        <>
            <ProfilePicker compact />

            {GROUPS.map(g => {
                const keys = g.keys.filter(k => !OPTIONS[k].hidden);
                if (!keys.length) return null;
                return (
                    <Section key={g.title} title={g.title}>
                        {keys.map(k => (
                            <React.Fragment key={k}>
                                <ToggleRow leading={<OptGlyph name={OPTIONS[k].icon} color={OPTIONS[k].color} />} checked={config[k]} onChange={v => setOption(k, v)} title={OPTIONS[k].label} subtitle={OPTIONS[k].hint} />
                                {sub(k)}
                            </React.Fragment>
                        ))}
                    </Section>
                );
            })}

            <Section title="General">
                <ToggleRow icon={ICONS.monitor} color="gray" checked={store.showTitleBarButton} onChange={v => settings.store.showTitleBarButton = v}
                    title="Icon in the title bar" subtitle="When hidden, you can reach OpSec via Settings → Vencord → Plugins." />
            </Section>
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
    return <Icon path={CURTAIN_ICONS[name]} size={size} />;
}

const ANIMATIONS: { value: CurtainAnimation; label: string; }[] = [
    { value: "fade", label: "Fade in" },
    { value: "zoom", label: "Zoom" },
    { value: "shutter", label: "Shutter" },
    { value: "glitch", label: "Glitch" }
];

/** Curtain accent choices (stored as hex in the settings, the curtain itself draws with them) */
const ACCENTS = ["#3ddc97", "#4c9bff", "#8b7bff", "#ff5c5c", "#ffb020", "#f4f4f5"];

const MOCK_AVATARS: UiColor[] = ["orange", "indigo", "green", "yellow"];

function MockDiscord() {
    return (
        <div className={cl("mock")} aria-hidden>
            <div className={cl("mock-servers")}>{[0, 1, 2, 3].map(i => <i key={i} />)}</div>
            <div className={cl("mock-channels")}>{[70, 55, 80, 60, 45].map((w, i) => <i key={i} style={{ width: `${w}%` }} />)}</div>
            <div className={cl("mock-chat")}>
                {[[60, 85], [40, 70], [75, 50], [55, 90]].map(([a, b], i) => (
                    <div key={i} className={cl("mock-msg")}>
                        <span className={cl("mock-avatar")} style={{ background: `var(--vc-ui-${MOCK_AVATARS[i]})` }} />
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

function SliderRow({ label, value, min, max, unit, onChange, disabled }: {
    label: string; value: number; min: number; max: number; unit: string; onChange(v: number): void; disabled?: boolean;
}) {
    return (
        <Row title={label} dim={disabled}>
            <div className={classes(cl("slider"), disabled && cl("off"))}>
                <Slider value={value} min={min} max={max} format={v => `${v}${unit}`} onChange={onChange} />
            </div>
        </Row>
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
        <div className={classes(cl("sub"), cl("pad"))}>
            <div className={cl("keybind")}>
                <button
                    type="button"
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
                    <IconButton icon={ICONS.restore} label="Reset to Ctrl + Shift + L" onClick={() => settings.store.panicKey = DEFAULT_KEYBIND} />
                )}
            </div>
            {error && rec && <span className={classes(cl("hint"), cl("text-warn"))}>{error}</span>}
            {!rec && conflict && <span className={classes(cl("hint"), cl("text-warn"))}>Overrides "{conflict}".</span>}
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
    const styleHint = s.curtainStyle === "update"
        ? "Disguises Discord as a running Windows update – nobody suspects a chat behind it."
        : s.curtainStyle === "bsod"
            ? "Disguises Discord as a Windows blue screen with counting-up progress."
            : s.curtainStyle === "terminal"
                ? "A terminal like in a hacker movie: types commands, runs progress bars and hex lines – endlessly. Your text appears as the window title."
                : undefined;

    return (
        <>
            <div className={cl("preview-wrap")}>
                <CurtainPreview options={options} replay={replay} />
                <div className={cl("preview-actions")}>
                    <Button small variant="gray" icon={ICONS.play} onClick={() => setReplay(r => r + 1)}>Replay</Button>
                    <Button small icon={MASK_PATH} onClick={() => { close?.(); setTimeout(() => showCurtain("manual"), close ? 150 : 0); }}>Test for real</Button>
                </div>
            </div>

            <Section title="Style" footer={styleHint} plain>
                <div className={cl("styles")}>
                    {STYLES.map(st => (
                        <button
                            type="button"
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
            </Section>

            <Section title="Animation" plain>
                <Segmented small value={s.curtainAnimation as CurtainAnimation} options={ANIMATIONS} onChange={v => { settings.store.curtainAnimation = v; setReplay(r => r + 1); }} />
            </Section>

            {usesLook && (
                <Section title="Appearance">
                    <SliderRow label="Opacity" value={s.curtainOpacity} min={40} max={100} unit="%" onChange={v => settings.store.curtainOpacity = v} disabled={s.curtainStyle === "black"} />
                    <SliderRow label="Blur" value={s.curtainBlur} min={0} max={40} unit=" px" onChange={v => settings.store.curtainBlur = v} disabled={s.curtainStyle === "black"} />
                    <Row title="Accent color">
                        <div className={cl("swatches")}>
                            {ACCENTS.map(a => (
                                <Tip key={a} text={a.toUpperCase()}>
                                    <button type="button" className={classes(cl("swatch"), s.curtainAccent.toLowerCase() === a && cl("swatch-active"))} style={{ background: a }} onClick={() => settings.store.curtainAccent = a} aria-label={a} />
                                </Tip>
                            ))}
                            <Tip text="Custom color">
                                <label className={classes(cl("swatch"), cl("swatch-custom"), !ACCENTS.includes(s.curtainAccent.toLowerCase()) && cl("swatch-active"))}>
                                    <input type="color" value={s.curtainAccent} onChange={e => settings.store.curtainAccent = e.currentTarget.value} />
                                </label>
                            </Tip>
                        </div>
                    </Row>
                    {usesIcon && <ToggleRow icon={MASK_PATH} color={OPSEC_COLOR} checked={s.curtainShowIcon} onChange={v => settings.store.curtainShowIcon = v} title="Show icon" />}
                    {usesIcon && s.curtainShowIcon && (
                        <div className={classes(cl("sub"), cl("pad"))}>
                            <div className={cl("icon-picks")}>
                                {ICON_CHOICES.map(i => (
                                    <Tip key={i.value} text={i.label}>
                                        <button
                                            type="button"
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
                                <TextField
                                    value={s.curtainIconCustom}
                                    maxLength={300}
                                    placeholder="Emoji (e.g. 🍕) or image link (https://…)"
                                    onChange={v => settings.store.curtainIconCustom = v}
                                />
                            )}
                        </div>
                    )}
                    <ToggleRow icon={ICONS.file} color="blue" checked={s.curtainShowText} onChange={v => settings.store.curtainShowText = v} title="Show text" subtitle="Enter your own text below – leave empty for the default text." />
                    {s.curtainShowText && (
                        <div className={classes(cl("sub"), cl("pad"))}>
                            <TextField
                                value={s.curtainText}
                                maxLength={60}
                                placeholder={DEFAULT_CURTAIN_TEXT}
                                onChange={v => settings.store.curtainText = v}
                            />
                        </div>
                    )}
                </Section>
            )}

            <Section title="Trigger & unlock">
                <ToggleRow icon={ICONS.bolt} color="yellow" checked={config.panicHotkey} onChange={v => setOption("panicHotkey", v)} title="Panic key" subtitle="Instantly covers Discord, press again to unlock." />
                {config.panicHotkey && <KeybindRecorder />}
                <ToggleRow icon={ICONS.eye} color="mint" checked={config.curtainOnBlur} onChange={v => setOption("curtainOnBlur", v)} title="Cover when you click away" subtitle="As soon as another window is active. Clicking back removes it." />
                <ToggleRow
                    icon={ICONS.eyeOff}
                    color="indigo"
                    checked={!s.curtainClickUnlock && config.panicHotkey}
                    disabled={!config.panicHotkey}
                    onChange={v => settings.store.curtainClickUnlock = !v}
                    title="Unlock only with panic key"
                    subtitle={config.panicHotkey ? "A click doesn't remove the curtain – anyone who doesn't know the key can't get in." : "Requires an active panic key."}
                />
            </Section>
        </>
    );
}

// ---------------------------------------------------------------- Full UI

export function OpSecApp({ variant, close }: { variant: "popout" | "modal"; close?(): void; }) {
    const { lastTab } = settings.use(["lastTab"]);
    const { summary } = useAudit();
    const tab = (TABS.some(t => t.id === lastTab) ? lastTab : "overview") as TabId;
    const goTo = (t: TabId) => settings.store.lastTab = t;

    return (
        <Sheet
            className={classes(cl("app"), cl(`app-${variant}`), cl("no-intercept"), "vc-keep-motion")}
            embedded={variant === "modal"}
            height={variant === "popout" ? "min(640px, 76vh)" : undefined}
            onClose={close}
            header={{ title: "OpSec", subtitle: "Beneath the OS", icon: MASK_PATH, iconColor: OPSEC_COLOR }}
            top={
                <Segmented
                    value={tab}
                    options={TABS.map(t => ({ value: t.id, label: t.label, count: t.id === "check" ? summary.warn : undefined }))}
                    onChange={goTo}
                />
            }
        >
            <div key={tab} className={cl("pane")}>
                {tab === "overview" && <OverviewTab goTo={goTo} close={close} />}
                {tab === "protection" && <ProtectionTab />}
                {tab === "curtain" && <CurtainTab close={close} />}
                {tab === "check" && <CheckTab />}
            </div>
        </Sheet>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(() => <OpSecApp variant="modal" />, { noop: true });

// ---------------------------------------------------------------- Link warning

export async function showLinkWarning(url: string, analysis: LinkAnalysis, open: () => void) {
    const danger = analysis.risk === "danger";
    const warn = analysis.risk === "warn";

    const ok = await confirm({
        title: danger ? "Dangerous link" : warn ? "Be careful with this link" : "Open external link?",
        icon: danger || warn ? ICONS.warning : ICONS.link,
        iconColor: danger ? "red" : warn ? "orange" : "blue",
        body: (
            <div className={classes(cl("link-warning"), cl("no-intercept"), "vc-keep-motion")}>
                {analysis.reason
                    ? <div className={classes(cl("link-reason"), danger ? cl("link-danger") : cl("link-warn"))}>{analysis.reason}</div>
                    : <div className={cl("hint")}>The site learns your IP address when you open it.</div>}
                <div className={cl("link-host")}>{analysis.host || url}</div>
                <div className={cl("link-url")}>{url}</div>
            </div>
        ),
        confirmText: danger ? "Open anyway" : "Open",
        cancelText: "Cancel",
        destructive: danger
    });
    if (ok) open();
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
                    <Popover width={440} className={classes(cl("popout"), "vc-keep-motion")}>
                        <OpSecApp variant="popout" close={() => setShow(false)} />
                    </Popover>
                </ErrorBoundary>
            )}
        >
            {(_, { isShown }) => (
                <HeaderBarIcon
                    ref={buttonRef}
                    className={classes(cl("btn-titlebar"), profile === "paranoid" && cl("btn-titlebar-hot"))}
                    onClick={() => setShow(v => !v)}
                    tooltip={isShown ? null : "OpSec"}
                    icon={() => <MaskIcon className="vc-ui-tb-icon" />}
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
