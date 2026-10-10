/*
 * StreamOverlay – Settings: server, design, URL builder & OBS guide (built from the shared _ui kit)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { copyToClipboard } from "@utils/clipboard";
import { classes } from "@utils/misc";
import { showToast, useEffect, useState } from "@webpack/common";

import { Button, ICONS, LinkRow, Row, Section, Segmented, Sheet, Slider, State, TextField, ToggleRow } from "../_ui";
import { buildQuery, DEFAULT_PORT, DEFAULTS, isHexColor, OverlayConfig, RANGES } from "./config";
import { getConfig, onStatusChange, refreshStatus, serverStatus, settings } from "./index";

const BROADCAST_PATH = "M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM7.05 7.05a1 1 0 0 1 0 1.41 5 5 0 0 0 0 7.08 1 1 0 1 1-1.41 1.41 7 7 0 0 1 0-9.9 1 1 0 0 1 1.41 0Zm9.9 0a1 1 0 0 1 1.41 0 7 7 0 0 1 0 9.9 1 1 0 1 1-1.41-1.41 5 5 0 0 0 0-7.08 1 1 0 0 1 0-1.41ZM4.22 4.22a1 1 0 0 1 0 1.42 9 9 0 0 0 0 12.72 1 1 0 1 1-1.42 1.42 11 11 0 0 1 0-15.56 1 1 0 0 1 1.42 0Zm15.56 0a1 1 0 0 1 1.42 0 11 11 0 0 1 0 15.56 1 1 0 1 1-1.42-1.42 9 9 0 0 0 0-12.72 1 1 0 0 1 0-1.42Z";

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

function Choice<T extends string>({ label, value, options, onChange }: {
    label: string;
    value: T;
    options: { value: T; label: string; }[];
    onChange(v: T): void;
}) {
    return (
        <Row title={label}>
            <div className="vc-streamoverlay-control">
                <Segmented value={value} options={options} onChange={onChange} small />
            </div>
        </Row>
    );
}

function SliderRow({ label, value, min, max, step = 1, unit = "", format, onChange }: {
    label: string; value: number; min: number; max: number; step?: number; unit?: string; format?(v: number): string; onChange(v: number): void;
}) {
    return (
        <Row title={label}>
            <div className="vc-streamoverlay-control">
                <Slider value={value} min={min} max={max} step={step} format={format ?? (v => `${v}${unit}`)} onChange={onChange} />
            </div>
        </Row>
    );
}

/** Suggested accent colors for the overlay (data for the OBS page, not UI colors) */
const SWATCHES = ["#43b581", "#5865f2", "#00d4ff", "#eb459e", "#fee75c", "#ff7a45", "#ffffff"];

function ColorRow({ value, onChange }: { value: string; onChange(v: string): void; }) {
    const [text, setText] = useState(value);
    useEffect(() => setText(value), [value]);

    return (
        <Row title="Accent color (speaking)">
            <div className="vc-streamoverlay-colors">
                {SWATCHES.map(c => (
                    <button
                        key={c}
                        className={classes("vc-streamoverlay-swatch", c === value.toLowerCase() && "vc-streamoverlay-swatch-active")}
                        style={{ background: c }}
                        onClick={() => onChange(c)}
                        aria-label={c}
                    />
                ))}
                <input type="color" className="vc-streamoverlay-picker" value={/^#[0-9a-f]{6}$/i.test(value) ? value : DEFAULTS.accent} onChange={e => onChange(e.currentTarget.value)} />
                <TextField
                    className="vc-streamoverlay-small-input"
                    value={text}
                    spellCheck={false}
                    onChange={setText}
                    onBlur={() => isHexColor(text) ? onChange(text.startsWith("#") ? text : "#" + text) : setText(value)}
                    onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                />
            </div>
        </Row>
    );
}

// ---------------------------------------------------------------- Server

function ServerSection() {
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
            showToast("Invalid port – allowed range is 1024 to 65535.", "failure");
        }
    };

    const url = `http://127.0.0.1:${status.port || port}`;

    return (
        <Section title="Server">
            <ToggleRow
                icon={BROADCAST_PATH}
                color="purple"
                title="Overlay server"
                subtitle="Runs locally on this PC only (127.0.0.1) – not reachable from outside."
                checked={serverEnabled}
                onChange={v => set("serverEnabled", v)}
            />
            <Row
                title="Status"
                subtitle={
                    status.error
                        ? status.error
                        : status.running
                            ? <>running on <b>{url}</b> · {status.clients === 1 ? "1 source connected" : `${status.clients} sources connected`}</>
                            : !status.pluginActive
                                ? "Plugin is disabled"
                                : serverEnabled ? "starting …" : "stopped"
                }
                trailing={
                    status.error
                        ? <State tone="bad">Error</State>
                        : status.running
                            ? <State tone="ok" check>Running</State>
                            : <State>Off</State>
                }
            />
            <Row
                title="Port"
                subtitle="Do not use 6463–6472 (Discord's own interface)."
                trailing={
                    <>
                        {port !== DEFAULT_PORT && (
                            <Button variant="plain" small onClick={() => set("port", DEFAULT_PORT)}>Default ({DEFAULT_PORT})</Button>
                        )}
                        <TextField
                            className="vc-streamoverlay-small-input"
                            inputMode="numeric"
                            value={portText}
                            onChange={v => setPortText(v.replace(/\D/g, ""))}
                            onBlur={commitPort}
                            onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()}
                        />
                    </>
                }
            />
        </Section>
    );
}

// ---------------------------------------------------------------- Design

function DesignSection({ cfg }: { cfg: OverlayConfig; }) {
    const [aMin, aMax] = RANGES.avatarSize!;
    const [fMin, fMax] = RANGES.fontSize!;

    return (
        <>
            <Section title="Design" footer="Applies to all OBS sources without their own settings in the URL.">
                <Choice label="Layout" value={cfg.layout} onChange={v => set("layout", v)} options={[
                    { value: "list", label: "List" },
                    { value: "row", label: "Row" },
                    { value: "grid", label: "Grid" }
                ]} />
                <Choice label="Background" value={cfg.background} onChange={v => set("background", v)} options={[
                    { value: "none", label: "Transparent" },
                    { value: "pill", label: "Pill" },
                    { value: "card", label: "Card" }
                ]} />
                <Choice label="Avatar shape" value={cfg.shape} onChange={v => set("shape", v)} options={[
                    { value: "circle", label: "Circle" },
                    { value: "rounded", label: "Rounded" },
                    { value: "square", label: "Square" }
                ]} />
                <Choice label="Speaking effect" value={cfg.effect} onChange={v => set("effect", v)} options={[
                    { value: "glow", label: "Glow" },
                    { value: "bounce", label: "Bounce" },
                    { value: "ring", label: "Color ring" }
                ]} />

                <SliderRow label="Avatar size" value={cfg.avatarSize} min={aMin} max={Math.min(aMax, 128)} step={2} unit=" px" onChange={v => set("avatarSize", v)} />
                <SliderRow label="Font size" value={cfg.fontSize} min={fMin} max={Math.min(fMax, 32)} unit=" px" onChange={v => set("fontSize", v)} />
                <ColorRow value={cfg.accent} onChange={v => set("accent", v)} />
            </Section>

            <Section>
                <ToggleRow title="Show participants" checked={cfg.showUsers} onChange={v => set("showUsers", v)} />
                <ToggleRow title="Show names" checked={cfg.showNames} onChange={v => set("showNames", v)} />
                <ToggleRow title="Only show speaking" subtitle="Whoever is talking appears – shortly after they stop, they disappear again." checked={cfg.onlySpeaking} onChange={v => set("onlySpeaking", v)} />
                <ToggleRow title="Hide muted" subtitle="Hide muted or deafened people as long as they are not speaking." checked={cfg.hideMuted} onChange={v => set("hideMuted", v)} />
                <ToggleRow title="Mute, deafen & live icons" checked={cfg.showIcons} onChange={v => set("showIcons", v)} />
                <ToggleRow title="Show channel name at top" checked={cfg.showHeader} onChange={v => set("showHeader", v)} />
                <ToggleRow title="Animated avatars" checked={cfg.animated} onChange={v => set("animated", v)} />
            </Section>
        </>
    );
}

function ChatSection({ cfg }: { cfg: OverlayConfig; }) {
    return (
        <Section title="Chat" footer="Shows the latest messages from the voice channel's text chat.">
            <ToggleRow title="Show chat" checked={cfg.chat} onChange={v => set("chat", v)} />
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
        </Section>
    );
}

// ---------------------------------------------------------------- URL builder

function UrlSection({ cfg }: { cfg: OverlayConfig; }) {
    const { port } = settings.use(["port"]);
    const [linked, setLinked] = useState(false);

    const base = `http://127.0.0.1:${port}/`;
    const url = base + (linked ? "" : buildQuery(cfg, { fixed: "1" }));
    const demoUrl = url + (url.includes("?") ? "&" : "?") + "demo=1";

    const copy = () => copyToClipboard(url)
        .then(() => showToast("URL copied", "success"))
        .catch(() => showToast("Copy failed", "failure"));

    const isDefault = (Object.keys(DEFAULTS) as (keyof OverlayConfig)[]).every(k => cfg[k] === DEFAULTS[k]);

    return (
        <Section title="URL for OBS" footer="Every browser source can have its own look: set the design below, copy the URL, done.">
            <ToggleRow
                title="Link to Discord settings"
                subtitle={linked
                    ? "Short URL – the source picks up any later change made here live."
                    : "The current design is written into the URL permanently – later changes here do not affect this source."}
                checked={linked}
                onChange={setLinked}
            />
            <Row title={<code className="vc-streamoverlay-url" title="Click to copy" onClick={copy}>{url}</code>}>
                <div className="vc-streamoverlay-buttons">
                    <Button small icon={ICONS.copy} onClick={copy}>Copy URL</Button>
                    <Button small variant="gray" icon={ICONS.external} onClick={() => VencordNative.native.openExternal(url)}>Open in browser</Button>
                    <Button small variant="gray" icon={ICONS.play} onClick={() => VencordNative.native.openExternal(demoUrl)}>Preview with demo data</Button>
                </div>
            </Row>
            {!isDefault && (
                <LinkRow
                    icon={ICONS.refresh}
                    onClick={() => {
                        for (const k of Object.keys(DEFAULTS) as (keyof OverlayConfig)[]) (settings.store as any)[k] = DEFAULTS[k];
                    }}
                >
                    Reset design to default
                </LinkRow>
            )}
        </Section>
    );
}

// ---------------------------------------------------------------- Guide

// A function, not a constant: JSX at module level runs before Vencord is ready and crashes the whole client
const steps = () => [
    <>In OBS, click <b>+</b> under <b>Sources</b> and choose <b>Browser</b> (Browser Source).</>,
    <>Paste the copied URL into <b>URL</b>. Leave "Local file" unchecked.</>,
    <>Set <b>Width/Height</b> accordingly, e.g. 400 × 600 for a list or 1200 × 200 for a row.</>,
    <>The <b>custom CSS</b> can stay empty – the background is already transparent.</>,
    <>Optionally enable "Shutdown source when not visible" so OBS saves resources.</>,
    <>Discord must be running and you must be in a voice channel – the overlay updates live.</>
];

function GuideSection() {
    return (
        <Section
            title="How to set it up in OBS"
            footer={<>Tip: URL parameters can also be edited by hand, e.g. <code>?layout=row&amp;size=64&amp;speaking=1</code>.</>}
        >
            {steps().map((step, i) => (
                <Row key={i} leading={<span className="vc-streamoverlay-step">{i + 1}</span>} title={<span className="vc-streamoverlay-step-text">{step}</span>} />
            ))}
        </Section>
    );
}

// ---------------------------------------------------------------- Settings

export const SettingsPanel = ErrorBoundary.wrap(() => {
    settings.use();
    const cfg = getConfig();

    return (
        <Sheet embedded header={{ title: "StreamOverlay", subtitle: "Voice overlay for OBS", icon: BROADCAST_PATH, iconColor: "purple" }}>
            <ServerSection />
            <UrlSection cfg={cfg} />
            <DesignSection cfg={cfg} />
            <ChatSection cfg={cfg} />
            <GuideSection />
        </Sheet>
    );
}, { noop: true });
