/*
 * RamSaver – title bar button, popout panel, settings & statistics display
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { openPluginModal } from "@components/settings";
import { Switch } from "@components/Switch";
import { classes } from "@utils/misc";
import { relaunch } from "@utils/native";
import { PluginNative } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { Popout, useEffect, useRef, useState } from "@webpack/common";

import plugin, { codeTweaksActive, getConfig, setOption, setProfile, settings, trim } from "./index";
import { BoolKey, Config, Profile, RESTART_KEYS, StartupState } from "./profiles";
import { useRamSaverState } from "./store";

const Native = VencordNative.pluginHelpers.RamSaver as PluginNative<typeof import("./native")>;

const cl = classNameFactory("vc-ramsaver-");
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

const IS_WINDOWS = navigator.platform.toLowerCase().startsWith("win");

const PROCESS_NAMES: Record<string, string> = {
    Browser: "Main process",
    Tab: "Discord window",
    GPU: "GPU",
    Utility: "Services"
};

// ---------------------------------------------------------------- Texts

const PROFILES: { value: Profile; label: string; description: string; }[] = [
    {
        value: "balanced",
        label: "Balanced",
        description: "Recommended. Noticeably saves RAM & CPU, Discord works completely normally - just without animations, blur and profile effects."
    },
    {
        value: "max",
        label: "Maximum",
        description: "As little RAM as possible: additionally no GIFs/animated emojis, no link previews, more economical JS memory, and when minimized Discord returns its RAM to Windows."
    },
    {
        value: "custom",
        label: "Manual",
        description: "Configure everything individually. Starts with the values of the previous profile."
    }
];

interface OptionInfo {
    key: BoolKey;
    label: string;
    hint?: string;
    windowsOnly?: boolean;
}

const GROUPS: { title: string; hint?: string; options: OptionInfo[]; }[] = [
    {
        title: "Clean up RAM",
        options: [
            { key: "autoTrim", label: "Clean up automatically", hint: "Regularly frees image/resource caches and runs garbage collection." },
            { key: "trimWhenHidden", label: "Clean up when minimized", hint: "1 minute after Discord is minimized or in the background." },
            { key: "trimMessageCache", label: "Clear message cache", hint: "Discards loaded messages of channels that are not open (reloaded when opened)." },
            { key: "trimWorkingSet", label: "Return RAM to Windows when minimized", hint: "Like RAM-Limiter: Discord releases its physical RAM (not during calls). Slightly slower for a moment after reopening.", windowsOnly: true },
            { key: "clearHttpCache", label: "Clear HTTP cache", hint: "Images/avatars are downloaded again afterwards. Saves hardly any RAM, usually unnecessary." }
        ]
    },
    {
        title: "Discord settings",
        hint: "Your original settings are remembered and restored when turned off.",
        options: [
            { key: "reducedMotion", label: "Reduce motion", hint: "Discord's own mode - also turns off animations that can't be reached via CSS." },
            { key: "disableAnimatedMedia", label: "Animated emojis, stickers & GIFs off", hint: "They only play on hover." },
            { key: "disableEmbeds", label: "Link previews off", hint: "No embeds (preview images, videos) under links. Uploaded images stay visible." }
        ]
    },
    {
        title: "Visuals",
        options: [
            { key: "disableAnimations", label: "CSS animations & transitions off" },
            { key: "disableBlur", label: "Blur effects off", hint: "Reduces GPU load." },
            { key: "hideProfileEffects", label: "Profile effects, decorations & nameplates off", hint: "Animated profile effects cost a lot of GPU and RAM." }
        ]
    },
    {
        title: "Advanced",
        hint: "Only take effect after a Discord restart.",
        options: [
            { key: "codeTweaks", label: "Optimize Discord code", hint: "Status updates without constantly copying large objects, tooltips without synchronous rendering." },
            { key: "backgroundThrottling", label: "Throttle in the background", hint: "Discord turns off Chromium's timer throttling - RamSaver turns it back on (except during voice calls)." },
            { key: "aggressiveBackground", label: "Throttle harder after 5 min in the background", hint: "Chromium default, like Discord in the browser." },
            { key: "noSpareRenderer", label: "Don't keep a spare process", hint: "Chromium otherwise keeps an empty process ready in RAM." },
            { key: "v8OptimizeForSize", label: "Memory-efficient JavaScript", hint: "V8 optimizes for memory instead of speed - less RAM, slightly more CPU." },
            { key: "lowEndDevice", label: "Low-end mode (experimental)", hint: "Chromium's mode for weak devices. Can degrade image quality/gradients." }
        ]
    }
];

const INTERVALS = [5, 10, 15, 30, 60];

// ---------------------------------------------------------------- Small building blocks

function formatAgo(time: number) {
    const s = Math.round((Date.now() - time) / 1000);
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    return `${Math.round(m / 60)} h ago`;
}

function ChipIcon({ size = 18 }: { size?: number; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={cl("icon")}>
            <path
                fill="currentColor"
                d="M9 2a1 1 0 0 1 1 1v1h4V3a1 1 0 1 1 2 0v1h1a3 3 0 0 1 3 3v1h1a1 1 0 1 1 0 2h-1v4h1a1 1 0 1 1 0 2h-1v1a3 3 0 0 1-3 3h-1v1a1 1 0 1 1-2 0v-1h-4v1a1 1 0 1 1-2 0v-1H7a3 3 0 0 1-3-3v-1H3a1 1 0 1 1 0-2h1v-4H3a1 1 0 1 1 0-2h1V7a3 3 0 0 1 3-3h1V3a1 1 0 0 1 1-1Zm-2 4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1H7Zm2 3h6v6H9V9Z"
            />
        </svg>
    );
}

function Sparkline({ data }: { data: number[]; }) {
    if (data.length < 2) return <div className={cl("spark-empty")}>Collecting data…</div>;

    const w = 268, h = 44;
    const min = Math.min(...data), max = Math.max(...data);
    const range = Math.max(max - min, 1);
    const points = data.map((v, i) => [
        (i / (data.length - 1)) * w,
        h - 2 - ((v - min) / range) * (h - 4)
    ]);
    const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");

    return (
        <svg className={cl("spark")} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
            <path d={`${line}L${w},${h}L0,${h}Z`} className={cl("spark-fill")} />
            <path d={line} className={cl("spark-line")} />
        </svg>
    );
}

function Segmented<T extends string | number>({ value, options, onChange, disabled }: {
    value: T;
    options: { value: T; label: string; }[];
    onChange(v: T): void;
    disabled?: boolean;
}) {
    return (
        <div className={classes(cl("segmented"), disabled && cl("disabled"))}>
            {options.map(o => (
                <button
                    key={o.value}
                    className={classes(cl("segment"), o.value === value && cl("segment-active"))}
                    disabled={disabled}
                    onClick={() => onChange(o.value)}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

// ---------------------------------------------------------------- Restart detection

let startupStateCache: StartupState | null | undefined;

function useStartupState() {
    const [value, setValue] = useState(startupStateCache);
    useEffect(() => {
        if (startupStateCache !== undefined) return;
        Native.getStartupState().then(s => {
            startupStateCache = s;
            setValue(s);
        }).catch(() => { });
    }, []);
    return value;
}

/** Restart options whose desired value is not active yet */
function usePendingRestart(config: Config) {
    const startup = useStartupState();
    if (startup === undefined) return [];

    return RESTART_KEYS.filter(key => {
        if (key === "codeTweaks") return config.codeTweaks !== codeTweaksActive;
        const active = startup?.[key] ?? false;
        return config[key] !== active;
    });
}

function RestartBanner({ config }: { config: Config; }) {
    const pending = usePendingRestart(config);
    if (!pending.length) return null;

    return (
        <div className={cl("restart")}>
            <span>{pending.length === 1 ? "1 change takes" : `${pending.length} changes take`} effect only after a restart.</span>
            <Button size="small" onClick={relaunch}>Restart</Button>
        </div>
    );
}

// ---------------------------------------------------------------- Statistics

/** RAM/CPU display + cleanup button. Used in the popout and in the plugin settings. */
export const StatsPanel = ErrorBoundary.wrap(() => {
    const { usage, history, lastTrim, trimming } = useRamSaverState(true);

    const types = usage
        ? Object.entries(usage.byType).sort((a, b) => b[1].memoryMB - a[1].memoryMB)
        : [];

    return (
        <div className={cl("stats")}>
            <div className={cl("big-row")}>
                <div>
                    <div className={cl("label")}>RAM</div>
                    <div className={cl("big")}>{usage ? `${usage.memoryMB.toFixed(0)} MB` : "…"}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                    <div className={cl("label")}>CPU</div>
                    <div className={cl("big")}>{usage ? `${usage.cpu.toFixed(1)} %` : "…"}</div>
                </div>
            </div>

            <Sparkline data={history} />

            <div className={cl("procs")}>
                {types.map(([type, t]) => (
                    <div key={type} className={cl("proc")}>
                        <span>{PROCESS_NAMES[type] ?? type}{t.count > 1 ? ` ×${t.count}` : ""}</span>
                        <span>{t.memoryMB.toFixed(0)} MB · {t.cpu.toFixed(1)} %</span>
                    </div>
                ))}
            </div>

            <Button size="small" disabled={trimming} onClick={() => trim("manual")} style={{ width: "100%" }}>
                {trimming ? "Cleaning up…" : "Clean up RAM now"}
            </Button>

            <div className={cl("muted")}>
                {lastTrim
                    ? `Last cleaned up ${formatAgo(lastTrim.time)}: −${Math.max(0, lastTrim.before - lastTrim.after).toFixed(0)} MB`
                    : "Not cleaned up yet"}
            </div>
        </div>
    );
}, { noop: true });

// ---------------------------------------------------------------- Profile & options

function ProfilePicker({ compact }: { compact?: boolean; }) {
    const { profile } = settings.use(["profile"]);
    const current = PROFILES.find(p => p.value === profile) ?? PROFILES[0];

    return (
        <div className={cl("profile")}>
            <Segmented value={current.value} options={PROFILES} onChange={setProfile} />
            {!compact && <div className={cl("muted")}>{current.description}</div>}
        </div>
    );
}

function OptionRow({ info, config }: { info: OptionInfo; config: Config; }) {
    const restart = (RESTART_KEYS as readonly string[]).includes(info.key);
    return (
        <label className={cl("option")}>
            <div className={cl("option-text")}>
                <div className={cl("option-label")}>
                    {info.label}
                    {restart && <span className={cl("badge")}>Restart</span>}
                </div>
                {info.hint && <div className={cl("muted")}>{info.hint}</div>}
            </div>
            <Switch checked={config[info.key]} onChange={v => setOption(info.key, v)} />
        </label>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(() => {
    const store = settings.use();
    const config = getConfig();

    return (
        <div className={cl("settings")}>
            <StatsPanel />

            <div className={cl("section")}>
                <div className={cl("section-title")}>Profile</div>
                <ProfilePicker />
                <RestartBanner config={config} />
            </div>

            {GROUPS.map(group => (
                <div key={group.title} className={cl("section")}>
                    <div className={cl("section-title")}>{group.title}</div>
                    {group.hint && <div className={cl("muted")}>{group.hint}</div>}

                    {group.options
                        .filter(o => !o.windowsOnly || IS_WINDOWS)
                        .map(o => <OptionRow key={o.key} info={o} config={config} />)}

                    {group.title === "Clean up RAM" && (
                        <div className={cl("option")}>
                            <div className={cl("option-text")}>
                                <div className={cl("option-label")}>Interval (minutes)</div>
                            </div>
                            <Segmented
                                value={config.trimInterval}
                                disabled={!config.autoTrim}
                                options={INTERVALS.map(i => ({ value: i, label: String(i) }))}
                                onChange={v => setOption("trimInterval", v)}
                            />
                        </div>
                    )}
                </div>
            ))}

            <div className={cl("section")}>
                <div className={cl("section-title")}>General</div>
                <label className={cl("option")}>
                    <div className={cl("option-label")}>Show icon in the title bar</div>
                    <Switch checked={store.showTitleBarButton} onChange={v => settings.store.showTitleBarButton = v} />
                </label>
                <label className={cl("option")}>
                    <div className={cl("option-label")}>Show freed RAM after cleaning up</div>
                    <Switch checked={store.showTrimToast} onChange={v => settings.store.showTrimToast = v} />
                </label>
            </div>
        </div>
    );
}, { noop: true });

// ---------------------------------------------------------------- Popout

const QUICK_TOGGLES: [BoolKey, string][] = [
    ["autoTrim", "Clean up automatically"],
    ["trimWhenHidden", "Clean up when minimized"],
    ["reducedMotion", "Reduce motion"],
    ["disableAnimatedMedia", "Animated emojis/GIFs off"],
    ["disableEmbeds", "Link previews off"],
    ["hideProfileEffects", "Profile effects off"]
];

function QuickToggles() {
    settings.use();
    const config = getConfig();

    return (
        <div className={cl("toggles")}>
            {QUICK_TOGGLES.map(([key, label]) => (
                <label key={key} className={cl("toggle")}>
                    <span>{label}</span>
                    <Switch checked={config[key]} onChange={v => setOption(key, v)} />
                </label>
            ))}
        </div>
    );
}

function PopoutPanel({ close }: { close(): void; }) {
    settings.use();

    return (
        <div className={cl("popout")}>
            <div className={cl("header")}>
                <ChipIcon size={20} />
                <span className={cl("title")}>RamSaver</span>
            </div>

            <StatsPanel />

            <div className={cl("divider")} />
            <div className={cl("label")}>Profile</div>
            <ProfilePicker compact />
            <RestartBanner config={getConfig()} />

            <div className={cl("label")}>Quick settings</div>
            <QuickToggles />

            <Button
                size="small"
                variant="secondary"
                style={{ width: "100%" }}
                onClick={() => {
                    close();
                    openPluginModal(plugin);
                }}
            >
                All settings
            </Button>
        </div>
    );
}

function TitleBarButton() {
    const { showTitleBarButton } = settings.use(["showTitleBarButton"]);
    const { usage } = useRamSaverState();
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
                    <PopoutPanel close={() => setShow(false)} />
                </ErrorBoundary>
            )}
        >
            {(_, { isShown }) => (
                <HeaderBarIcon
                    ref={buttonRef}
                    className={cl("btn")}
                    onClick={() => setShow(v => !v)}
                    tooltip={isShown ? null : `RamSaver${usage ? ` · ${usage.memoryMB.toFixed(0)} MB` : ""}`}
                    icon={() => <ChipIcon />}
                    selected={isShown}
                />
            )}
        </Popout>
    );
}

export function renderTitleBarButton() {
    return (
        <ErrorBoundary key="vc-ramsaver-titlebar" noop>
            <TitleBarButton />
        </ErrorBoundary>
    );
}
