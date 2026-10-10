/*
 * StreamUnlock – own stream debugger. Discord's "Stream Info" stays empty with unusual frame rates, so this reads
 * the raw stats Discord's voice engine sends every few seconds (MEDIA_ENGINE_CONNECTION_STATS) and shows what is
 * really captured, encoded, sent and received.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { createRoot, FluxDispatcher, SettingsRouter, useEffect, UserStore, useState } from "@webpack/common";

import { Button, ICONS, RoundButton } from "../_ui";

const cl = classNameFactory("vc-streamunlock-");

/** Older stats than this mean the stream ended */
const STALE_MS = 6000;

interface VideoStat {
    type?: string;
    codec?: { name?: string; } | string;
    codecName?: string;
    resolution?: { width?: number; height?: number; };
    frameRateInput?: number;
    frameRateEncode?: number;
    frameRateDecode?: number;
    frameRateNetwork?: number;
    frameRateRender?: number;
    bitrate?: number;
    bytesSent?: number;
    bytesReceived?: number;
    encoderImplementationName?: string;
    decoderImplementationName?: string;
}

interface Snapshot {
    at: number;
    outbound: VideoStat | null;
    inbound: { userId: string; stat: VideoStat; }[];
}

let latest: Snapshot | null = null;
let hidden = false;
const listeners = new Set<() => void>();

/** stat key → last byte count, to work out the bitrate */
const lastBytes = new Map<string, { bytes: number; at: number; }>();

function withBitrate(key: string, stat: VideoStat, now: number): VideoStat {
    const bytes = stat.bytesSent ?? stat.bytesReceived;
    if (typeof bytes !== "number") return stat;
    const prev = lastBytes.get(key);
    lastBytes.set(key, { bytes, at: now });
    if (stat.bitrate != null || !prev || now <= prev.at || bytes < prev.bytes) return stat;
    return { ...stat, bitrate: (bytes - prev.bytes) * 8 / ((now - prev.at) / 1000) };
}

const videoOf = (list: unknown) => (Array.isArray(list) ? list as VideoStat[] : []).find(s => s?.type === "video") ?? null;

function onStats(e: { connectionStats: { context?: string; stats?: any; }[]; }) {
    const stream = e.connectionStats.filter(c => c.context === "stream" && c.stats);
    if (!stream.length) return;
    const now = Date.now();
    const snap: Snapshot = { at: now, outbound: null, inbound: [] };
    for (const { stats } of stream) {
        const out = videoOf(stats.rtp?.outbound);
        if (out && !snap.outbound) snap.outbound = withBitrate("out", out, now);
        for (const [userId, list] of Object.entries(stats.rtp?.inbound ?? {})) {
            const stat = videoOf(list);
            if (stat) snap.inbound.push({ userId, stat: withBitrate(`in:${userId}`, stat, now) });
        }
    }
    if (!snap.outbound && !snap.inbound.length) return;
    // Stats again after a break = a new stream: show the panel again if it was closed
    if (!latest || now - latest.at > STALE_MS) hidden = false;
    latest = snap;
    listeners.forEach(l => l());
}

// ---------------------------------------------------------------- Panel

const num = (n?: number, digits = 0) => typeof n === "number" && isFinite(n) ? n.toFixed(digits) : "–";
const codecOf = (s: VideoStat) => (typeof s.codec === "string" ? s.codec : s.codec?.name) ?? s.codecName ?? "–";
const resOf = (s: VideoStat) => s.resolution?.width ? `${s.resolution.width} × ${s.resolution.height}` : "–";
const mbit = (b?: number) => typeof b === "number" ? `${(b / 1_000_000).toFixed(1)} Mbit/s` : "–";
const nameOf = (id: string) => {
    const u = UserStore.getUser(id) as any;
    return u?.globalName || u?.username || id;
};

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean; }) {
    return (
        <div className={cl("line")}>
            <span>{label}</span>
            <b className={strong ? cl("strong") : undefined}>{value}</b>
        </div>
    );
}

function Panel() {
    const [, setTick] = useState(0);
    useEffect(() => {
        const l = () => setTick(t => t + 1);
        listeners.add(l);
        // Re-render once in a while so a stopped stream disappears
        const timer = setInterval(l, 2000);
        return () => { listeners.delete(l); clearInterval(timer); };
    }, []);

    if (hidden || !latest || Date.now() - latest.at > STALE_MS) return null;
    const { outbound, inbound } = latest;

    return (
        <div className={cl("panel")}>
            <div className={cl("head")}>
                <b>Stream debug</b>
                <RoundButton icon={ICONS.close} label="Hide until the next stream" size={22} onClick={() => { hidden = true; setTick(t => t + 1); }} />
            </div>
            {outbound && (
                <section>
                    <div className={cl("title")}>Your stream (sent)</div>
                    <Line label="Encoded FPS" value={num(outbound.frameRateEncode)} strong />
                    <Line label="Captured FPS" value={num(outbound.frameRateInput)} />
                    <Line label="Resolution" value={resOf(outbound)} />
                    <Line label="Codec" value={codecOf(outbound)} />
                    <Line label="Bitrate" value={mbit(outbound.bitrate)} />
                    {outbound.encoderImplementationName && <Line label="Encoder" value={outbound.encoderImplementationName} />}
                </section>
            )}
            {inbound.map(({ userId, stat }) => (
                <section key={userId}>
                    <div className={cl("title")}>{nameOf(userId)} (received)</div>
                    <Line label="Decoded FPS" value={num(stat.frameRateDecode)} strong />
                    <Line label="Network FPS" value={num(stat.frameRateNetwork)} />
                    <Line label="Shown FPS" value={num(stat.frameRateRender)} />
                    <Line label="Resolution" value={resOf(stat)} />
                    <Line label="Codec" value={codecOf(stat)} />
                    <Line label="Bitrate" value={mbit(stat.bitrate)} />
                    {(stat.frameRateNetwork ?? 0) > 0 && !stat.frameRateDecode && <DecodeHint />}
                </section>
            ))}
        </div>
    );
}

/** The stream arrives but nothing gets decoded – usually the graphics card's decoder can't do that frame rate */
function DecodeHint() {
    return (
        <div className={cl("hint")}>
            <span>The stream arrives, but your graphics card can't decode it. Turn off System → Enable Hardware Acceleration (Discord restarts).</span>
            <Button small variant="tinted" color="orange" onClick={openSystemSettings}>Open System settings</Button>
        </div>
    );
}

export const openSystemSettings = () => SettingsRouter.openUserSettings("system_panel");

// ---------------------------------------------------------------- Start / stop

let root: ReturnType<typeof createRoot> | null = null;

export function startDebug() {
    FluxDispatcher.subscribe("MEDIA_ENGINE_CONNECTION_STATS", onStats);
    const host = document.createElement("div");
    host.id = "vc-streamunlock-debug";
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(<Panel />);
}

export function stopDebug() {
    FluxDispatcher.unsubscribe("MEDIA_ENGINE_CONNECTION_STATS", onStats);
    root?.unmount();
    root = null;
    document.getElementById("vc-streamunlock-debug")?.remove();
    latest = null;
    hidden = false;
    lastBytes.clear();
}
