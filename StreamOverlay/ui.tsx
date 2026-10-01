/*
 * StreamOverlay – Settings: server, design, URL builder & OBS guide
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { Switch } from "@components/Switch";
import { copyToClipboard } from "@utils/clipboard";
import { classes } from "@utils/misc";
import { showToast, Toasts, useEffect, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { buildQuery, DEFAULT_PORT, DEFAULTS, isHexColor, OverlayConfig, RANGES } from "./config";
import { getConfig, onStatusChange, refreshStatus, serverStatus, settings } from "./index";

const cl = classNameFactory("vc-streamoverlay-");

// ---------------------------------------------------------------- State

function useServerStatus() {
    const [status, setStatus] = useState(serverStatus);

    useEffect(() => {
        const unsubscribe = onStatusChange(() => setStatus(serverStatus));
        refreshStatus();
        // Keep the number of connected OBS sources up to date
        const timer = setInterval(refreshStatus, 2000);
        return () => {
            unsubscribe();
            clearInterval(timer);
        };
    }, []);

    return status;
}

type Store = typeof settings.store;

function set<K extends keyof Store>(key: K, value: Store[K]) {
    settings.store[key] = value;
}

// ---------------------------------------------------------------- Building blocks

function Card({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode; }) {
    return (
        <section className={cl("card")}>
            <div className={cl("card-title")}>{title}</div>
            {hint && <div className={cl("hint")}>{hint}</div>}
            {children}
        </section>
    );
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange(v: boolean): void; }) {
    return (
        <div className={cl("row")}>
            <div className={cl("row-text")}>
                <span className={cl("row-label")}>{label}</span>
                {hint && <span className={cl("hint")}>{hint}</span>}
            </div>
            <Switch checked={checked} onChange={onChange} />
        </div>
    );
}

function Segmented<T extends string>({ label, value, options, onChange }: {
    label: string;
    value: T;
    options: { value: T; label: string; }[];
    onChange(v: T): void;
}) {
    return (
        <div className={cl("field")}>
            <span className={cl("row-label")}>{label}</span>
            <div className={cl("seg")}>
                {options.map(o => (
                    <button
                        key={o.value}
                        className={classes(cl("seg-item"), o.value === value && cl("seg-item-active"))}
                        onClick={() => onChange(o.value)}
                    >
                        {o.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

function SliderRow({ label, value, min, max, step = 1, unit = "", format, onChange }: {
    label: string; value: number; min: number; max: number; step?: number; unit?: string; format?(v: number): string; onChange(v: number): void;
}) {
    return (
        <div className={cl("field")}>
            <div className={cl("slider-head")}>
                <span className={cl("row-label")}>{label}</span>
                <span className={cl("slider-value")}>{format ? format(value) : `${value}${unit}`}</span>
            </div>
            <input
                type="range"
                className={cl("slider")}
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={e => onChange(Number(e.currentTarget.value))}
            />
        </div>
    );
}

const SWATCHES = ["#43b581", "#5865f2", "#00d4ff", "#eb459e", "#fee75c", "#ff7a45", "#ffffff"];

function ColorRow({ value, onChange }: { value: string; onChange(v: string): void; }) {
    const [text, setText] = useState(value);
    useEffect(() => setText(value), [value]);

    return (
        <div className={cl("field")}>
            <span className={cl("row-label")}>Accent color (speaking)</span>
            <div className={cl("colors")}>
                {SWATCHES.map(c => (
                    <button
                        key={c}
                        className={classes(cl("swatch"), c === value.toLowerCase() && cl("swatch-active"))}
                        style={{ background: c }}
                        onClick={() => onChange(c)}
                        aria-label={c}
                    />
                ))}
                <input type="color" className={cl("color-picker")} value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#43b581"} onChange={e => onChange(e.currentTarget.value)} />
                <input
                    className={classes(cl("input"), cl("input-small"))}
                    value={text}
                    spellCheck={false}
                    onChange={e => setText(e.currentTarget.value)}
                    onBlur={() => isHexColor(text) ? onChange(text.startsWith("#") ? text : "#" + text) : setText(value)}
                    onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                />
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- Server

function ServerCard() {
    const status = useServerStatus();
    const { serverEnabled, port } = settings.use(["serverEnabled", "port"]);
    const [portText, setPortText] = useState(String(port));
    useEffect(() => setPortText(String(port)), [port]);

    const commitPort = () => {
        const n = Number(portText);
        if (Number.isInteger(n) && n >= 1024 && n <= 65535) {
            if (n !== port) set("port", n);
        } else {
            setPortText(String(port));
            showToast("Invalid port – allowed range is 1024 to 65535.", Toasts.Type.FAILURE);
        }
    };

    const url = `http://127.0.0.1:${status.port || port}`;
    const state = status.error ? "error" : status.running ? "on" : "off";

    return (
        <Card title="Server">
            <ToggleRow
                label="Overlay server"
                hint="Runs locally on this PC only (127.0.0.1) – not reachable from outside."
                checked={serverEnabled}
                onChange={v => set("serverEnabled", v)}
            />

            <div className={classes(cl("status"), cl(`status-${state}`))}>
                <span className={cl("dot")} />
                <span>
                    {status.error
                        ? status.error
                        : status.running
                            ? <>running on <b>{url}</b> · {status.clients === 1 ? "1 source connected" : `${status.clients} sources connected`}</>
                            : !status.pluginActive
                                ? "Plugin is disabled"
                                : serverEnabled ? "starting …" : "stopped"}
                </span>
            </div>

            <div className={cl("field")}>
                <span className={cl("row-label")}>Port</span>
                <div className={cl("inline")}>
                    <input
                        className={classes(cl("input"), cl("input-small"))}
                        inputMode="numeric"
                        value={portText}
                        onChange={e => setPortText(e.currentTarget.value.replace(/\D/g, ""))}
                        onBlur={commitPort}
                        onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                    />
                    {port !== DEFAULT_PORT && (
                        <button className={cl("btn-link")} onClick={() => set("port", DEFAULT_PORT)}>Default ({DEFAULT_PORT})</button>
                    )}
                </div>
                <span className={cl("hint")}>Do not use 6463–6472 (Discord's own interface).</span>
            </div>
        </Card>
    );
}

// ---------------------------------------------------------------- Design

function DesignCard({ cfg }: { cfg: OverlayConfig; }) {
    const [aMin, aMax] = RANGES.avatarSize!;
    const [fMin, fMax] = RANGES.fontSize!;

    return (
        <Card title="Design" hint="Applies to all OBS sources without their own settings in the URL.">
            <Segmented label="Layout" value={cfg.layout} onChange={v => set("layout", v)} options={[
                { value: "list", label: "List" },
                { value: "row", label: "Row" },
                { value: "grid", label: "Grid" }
            ]} />
            <Segmented label="Background" value={cfg.background} onChange={v => set("background", v)} options={[
                { value: "none", label: "Transparent" },
                { value: "pill", label: "Pill" },
                { value: "card", label: "Card" }
            ]} />
            <Segmented label="Avatar shape" value={cfg.shape} onChange={v => set("shape", v)} options={[
                { value: "circle", label: "Circle" },
                { value: "rounded", label: "Rounded" },
                { value: "square", label: "Square" }
            ]} />
            <Segmented label="Speaking effect" value={cfg.effect} onChange={v => set("effect", v)} options={[
                { value: "glow", label: "Glow" },
                { value: "bounce", label: "Bounce" },
                { value: "ring", label: "Color ring" }
            ]} />

            <SliderRow label="Avatar size" value={cfg.avatarSize} min={aMin} max={Math.min(aMax, 128)} step={2} unit=" px" onChange={v => set("avatarSize", v)} />
            <SliderRow label="Font size" value={cfg.fontSize} min={fMin} max={Math.min(fMax, 32)} unit=" px" onChange={v => set("fontSize", v)} />
            <ColorRow value={cfg.accent} onChange={v => set("accent", v)} />

            <div className={cl("divider")} />

            <ToggleRow label="Show participants" checked={cfg.showUsers} onChange={v => set("showUsers", v)} />
            <ToggleRow label="Show names" checked={cfg.showNames} onChange={v => set("showNames", v)} />
            <ToggleRow label="Only show speaking" hint="Whoever is talking appears – shortly after they stop, they disappear again." checked={cfg.onlySpeaking} onChange={v => set("onlySpeaking", v)} />
            <ToggleRow label="Hide muted" hint="Hide muted or deafened people as long as they are not speaking." checked={cfg.hideMuted} onChange={v => set("hideMuted", v)} />
            <ToggleRow label="Mute, deafen & live icons" checked={cfg.showIcons} onChange={v => set("showIcons", v)} />
            <ToggleRow label="Show channel name at top" checked={cfg.showHeader} onChange={v => set("showHeader", v)} />
            <ToggleRow label="Animated avatars" checked={cfg.animated} onChange={v => set("animated", v)} />
        </Card>
    );
}

function ChatCard({ cfg }: { cfg: OverlayConfig; }) {
    return (
        <Card title="Chat" hint="Shows the latest messages from the voice channel's text chat.">
            <ToggleRow label="Show chat" checked={cfg.chat} onChange={v => set("chat", v)} />
            {cfg.chat && (
                <>
                    <SliderRow label="Maximum visible messages" value={cfg.chatMax} min={1} max={20} onChange={v => set("chatMax", v)} />
                    <SliderRow
                        label="Fade out after"
                        value={cfg.chatFade}
                        min={0}
                        max={120}
                        step={5}
                        format={v => v === 0 ? "never" : `${v} s`}
                        onChange={v => set("chatFade", v)}
                    />
                </>
            )}
        </Card>
    );
}

// ---------------------------------------------------------------- URL builder

function UrlCard({ cfg }: { cfg: OverlayConfig; }) {
    const { port } = settings.use(["port"]);
    const [linked, setLinked] = useState(false);

    const base = `http://127.0.0.1:${port}/`;
    const url = base + (linked ? "" : buildQuery(cfg, { fixed: "1" }));
    const demoUrl = url + (url.includes("?") ? "&" : "?") + "demo=1";

    const copy = () => copyToClipboard(url)
        .then(() => showToast("URL copied", Toasts.Type.SUCCESS))
        .catch(() => showToast("Copy failed", Toasts.Type.FAILURE));

    const isDefault = (Object.keys(DEFAULTS) as (keyof OverlayConfig)[]).every(k => cfg[k] === DEFAULTS[k]);

    return (
        <Card title="URL for OBS" hint="Every browser source can have its own look: set the design above, copy the URL, done.">
            <ToggleRow
                label="Link to Discord settings"
                hint={linked
                    ? "Short URL – the source picks up any later change made here live."
                    : "The current design is written into the URL permanently – later changes here do not affect this source."}
                checked={linked}
                onChange={setLinked}
            />
            <div className={cl("url")} onClick={copy} title="Click to copy">
                <code>{url}</code>
            </div>
            <div className={cl("buttons")}>
                <button className={classes(cl("btn"), cl("btn-primary"))} onClick={copy}>Copy URL</button>
                <button className={cl("btn")} onClick={() => VencordNative.native.openExternal(url)}>Open in browser</button>
                <button className={cl("btn")} onClick={() => VencordNative.native.openExternal(demoUrl)}>Preview with demo data</button>
            </div>
            {!isDefault && (
                <button
                    className={cl("btn-link")}
                    onClick={() => {
                        for (const k of Object.keys(DEFAULTS) as (keyof OverlayConfig)[]) (settings.store as any)[k] = DEFAULTS[k];
                    }}
                >
                    Reset design to default
                </button>
            )}
        </Card>
    );
}

// ---------------------------------------------------------------- Guide

function GuideCard() {
    return (
        <Card title="How to set it up in OBS">
            <ol className={cl("guide")}>
                <li>In OBS, click <b>+</b> under <b>Sources</b> and choose <b>Browser</b> (Browser Source).</li>
                <li>Paste the copied URL into <b>URL</b>. Leave "Local file" unchecked.</li>
                <li>Set <b>Width/Height</b> accordingly, e.g. 400 × 600 for a list or 1200 × 200 for a row.</li>
                <li>The <b>custom CSS</b> can stay empty – the background is already transparent.</li>
                <li>Optionally enable "Shutdown source when not visible" so OBS saves resources.</li>
                <li>Discord must be running and you must be in a voice channel – the overlay updates live.</li>
            </ol>
            <div className={cl("hint")}>
                Tip: URL parameters can also be edited by hand, e.g. <code>?layout=row&amp;size=64&amp;speaking=1</code>.
            </div>
        </Card>
    );
}

// ---------------------------------------------------------------- Settings

export const SettingsPanel = ErrorBoundary.wrap(() => {
    settings.use();
    const cfg = getConfig();

    return (
        <div className={cl("settings")}>
            <ServerCard />
            <UrlCard cfg={cfg} />
            <DesignCard cfg={cfg} />
            <ChatCard cfg={cfg} />
            <GuideCard />
        </div>
    );
}, { noop: true });
