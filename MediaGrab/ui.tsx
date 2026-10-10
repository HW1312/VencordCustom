/*
 * MediaGrab – Window: paste a link, choose video / MP3, quality and where it goes (built from the shared _ui kit)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classes } from "@utils/misc";
import { IconComponent } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { useEffect, useReducer, useRef, useState } from "@webpack/common";

import { Field, Glyph, ICONS, Note, openWindow, Pill, Pills, Row, Section, Segmented, Sheet, TextField, ToggleRow } from "../_ui";
import { getRunning, grab, isInstalled, isSoundLink, isUrl, needsRestart, shortUrl, subscribeRunning } from "./grab";
import { settings } from "./settings";

const GRAB_PATH = "M5 3a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h5.1a6.97 6.97 0 0 1 .9-2H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v4.1c.71.26 1.39.62 2 1.06V6a3 3 0 0 0-3-3H5Zm4.5 4.13v5.74a.5.5 0 0 0 .75.43l4.92-2.87a.5.5 0 0 0 0-.86L10.25 6.7a.5.5 0 0 0-.75.43ZM17 12a1 1 0 0 1 1 1v4.59l1.3-1.3a1 1 0 0 1 1.4 1.42l-3 3a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.42l1.3 1.3V13a1 1 0 0 1 1-1Z";
const MUSIC_PATH = "M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6Z";
const LINK_PATH = "M10.6 13.4a1 1 0 0 1 0-1.4l3.5-3.5a1 1 0 1 1 1.4 1.4l-3.5 3.5a1 1 0 0 1-1.4 0Zm-3.3 6.2a4.5 4.5 0 0 1-3.2-7.7l2.5-2.5a1 1 0 0 1 1.4 1.4l-2.5 2.5a2.5 2.5 0 0 0 3.5 3.5l2.5-2.5a1 1 0 0 1 1.4 1.4l-2.5 2.5a4.5 4.5 0 0 1-3.1 1.4Zm9.3-5.6a1 1 0 0 1-.7-1.7l2.5-2.5a2.5 2.5 0 0 0-3.5-3.5l-2.5 2.5a1 1 0 0 1-1.4-1.4l2.5-2.5a4.5 4.5 0 0 1 6.4 6.4l-2.5 2.5a1 1 0 0 1-.8.2Z";

export const GrabIcon: IconComponent = ({ width = 24, height = 24, className }) => {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" className={className} fill="currentColor">
            <path d={GRAB_PATH} />
        </svg>
    );
};

export function useRunning() {
    const [, rerender] = useReducer((x: number) => x + 1, 0);
    useEffect(() => subscribeRunning(rerender), []);
    return getRunning();
}

const RING = 2 * Math.PI * 10;

/** Chat bar icon with a progress ring while downloads are running */
export function ChatBarIcon() {
    const { count, progress } = useRunning();
    return (
        <span className="vc-mediagrab-bar-icon">
            <GrabIcon width={20} height={20} />
            {count > 0 && (
                <svg className={classes("vc-mediagrab-ring", progress < 0 && "vc-mediagrab-ring-spin")} viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" className="vc-mediagrab-ring-track" />
                    <circle
                        cx="12" cy="12" r="10"
                        className="vc-mediagrab-ring-fill"
                        strokeDasharray={RING}
                        strokeDashoffset={progress < 0 ? RING * 0.7 : RING * (1 - progress)}
                    />
                </svg>
            )}
            {count > 1 && <span className="vc-mediagrab-badge">{count}</span>}
        </span>
    );
}

export function chatBarTooltip(count: number, progress: number) {
    if (!count) return "MediaGrab: video / MP3 from a link";
    const what = count > 1 ? `${count} downloads` : "Downloading";
    return progress >= 0 ? `${what} · ${Math.round(progress * 100)}%` : `${what} …`;
}

/** Quality picker; the kit's Segmented works with strings */
const QUALITIES = [{ value: "0", label: "Best" }, { value: "1080", label: "1080p" }, { value: "720", label: "720p" }, { value: "480", label: "480p" }];

function QualityPicker({ value, onChange, small }: { value: number; onChange(v: number): void; small?: boolean; }) {
    return <Segmented value={String(value)} options={QUALITIES} onChange={v => onChange(Number(v))} small={small} />;
}

const RESTART_TEXT = "Quit Discord completely once (tray icon → Quit) and start it again. Ctrl+R is not enough to install MediaGrab.";

async function readClipboardUrl() {
    try {
        const text = (await navigator.clipboard.readText()).trim();
        return isUrl(text) ? text : "";
    } catch {
        return "";
    }
}

function GrabWindow({ close, channel, links }: { close(): void; channel?: Channel | null; links: string[]; }) {
    const s = settings.store;
    const [url, setUrl] = useState(links[0] ?? "");
    const [kind, setKind] = useState<"video" | "audio">(s.lastKind === "audio" ? "audio" : "video");
    const [quality, setQuality] = useState<number>(s.lastQuality);
    const [toChat, setToChat] = useState(!!channel && s.lastToChat);
    const [toDisk, setToDisk] = useState(s.lastToDisk || !channel);
    const [installed, setInstalled] = useState(true);

    useEffect(() => {
        isInstalled().then(setInstalled, () => { });
        if (!links.length) readClipboardUrl().then(u => u && setUrl(prev => prev || u));
    }, []);

    const valid = isUrl(url) && (toChat || toDisk);

    const start = () => {
        if (!valid) return;
        s.lastKind = kind;
        s.lastQuality = quality;
        if (channel) s.lastToChat = toChat;
        s.lastToDisk = toDisk;
        close();
        grab({ url: url.trim(), kind, maxHeight: quality, toChat: toChat && !!channel, toDisk, channel });
    };

    return (
        <Sheet
            header={{ title: "MediaGrab", subtitle: "Video or MP3 from TikTok, YouTube, Instagram, X, Reddit and many more", icon: GRAB_PATH, iconColor: "pink" }}
            onClose={close}
            actions={[
                { label: "Cancel", onClick: close },
                { label: "Download", onClick: start, disabled: !valid }
            ]}
        >
            <div className="vc-mediagrab-form">
                <Field label="Link">
                    <TextField
                        value={url}
                        autoFocus
                        placeholder="https://www.tiktok.com/@…/video/…"
                        onChange={setUrl}
                        onKeyDown={e => { if (e.key === "Enter") start(); }}
                    />
                    {links.length > 1 && (
                        <Pills>
                            {links.map(l => (
                                <Pill key={l} selected={l === url} title={l} onClick={() => setUrl(l)}>{shortUrl(l)}</Pill>
                            ))}
                        </Pills>
                    )}
                </Field>

                <Field label="Format">
                    <Segmented<"video" | "audio"> value={kind} onChange={setKind} options={[{ value: "video", label: "Video (MP4)" }, { value: "audio", label: "Audio (MP3)" }]} />
                </Field>

                {kind === "video" && (
                    <Field label="Quality">
                        <QualityPicker value={quality} onChange={setQuality} />
                    </Field>
                )}

                <Section title="Send to">
                    <ToggleRow
                        icon={ICONS.play}
                        color="pink"
                        title="Into the chat"
                        subtitle={channel ? "Attached to your message box. Too large → Gofile link." : "Open a chat first"}
                        checked={toChat && !!channel}
                        disabled={!channel}
                        onChange={setToChat}
                    />
                    <ToggleRow icon={ICONS.download} color="blue" title="Downloads folder" subtitle="Saved on this PC" checked={toDisk} onChange={setToDisk} />
                </Section>

                {needsRestart() && <Note tone="bad">{RESTART_TEXT}</Note>}

                {!installed && !needsRestart() && (
                    <Note>The first download installs yt-dlp and ffmpeg (about 100 MB, only once).</Note>
                )}
            </div>
        </Sheet>
    );
}

export function openGrabModal(channel?: Channel | null, links: string[] = []) {
    openWindow(close => <GrabWindow close={close} channel={channel} links={links} />);
}

// ---------------------------------------------------------------- Asked when a message is only a video link

export type LinkChoice = { kind: "link"; } | { kind: "video"; quality: number; } | { kind: "audio"; };

function LinkChoiceWindow({ close, url, onChoice, onDone }: { close(): void; url: string; onChoice(c: LinkChoice): void; onDone(): void; }) {
    const s = settings.store;
    const [quality, setQuality] = useState<number>(s.lastQuality);
    const list = useRef<HTMLDivElement>(null);

    // "Send link" has the focus, so Enter sends the link as usual; closing the window in any way reports the result
    useEffect(() => {
        list.current?.querySelector<HTMLElement>(".vc-ui-row-click")?.focus();
        return onDone;
    }, []);

    const choose = (c: LinkChoice) => {
        onChoice(c);
        close();
    };

    return (
        <Sheet
            header={{ title: "Send as link or as file?", subtitle: shortUrl(url), icon: GRAB_PATH, iconColor: "pink" }}
            onClose={close}
            footer={<span className="vc-mediagrab-hint">Esc keeps the link in the message box. You can turn this question off in the MediaGrab settings.</span>}
        >
            <div ref={list} className="vc-mediagrab-form">
                <Section>
                    <Row leading={<Glyph path={LINK_PATH} color="blue" />} title="Send link" subtitle="As usual" chevron onClick={() => choose({ kind: "link" })} />
                    {!isSoundLink(url) && (
                        <Row
                            leading={<Glyph path={ICONS.play} color="pink" />}
                            title="Video (MP4)"
                            subtitle="Download and send the video"
                            chevron
                            onClick={() => {
                                s.lastQuality = quality;
                                choose({ kind: "video", quality });
                            }}
                        >
                            <div className="vc-mediagrab-quality" onClick={e => e.stopPropagation()}>
                                <span>Quality</span>
                                <QualityPicker value={quality} onChange={setQuality} small />
                            </div>
                        </Row>
                    )}
                    <Row leading={<Glyph path={MUSIC_PATH} color="orange" />} title="Audio (MP3)" subtitle="Download and send the sound" chevron onClick={() => choose({ kind: "audio" })} />
                </Section>
                {needsRestart() && (
                    <Note tone="bad">Quit Discord completely once (tray icon → Quit) and start it again – until then only “Send link” works.</Note>
                )}
            </div>
        </Sheet>
    );
}

/** Resolves with the choice, or null if the window was closed (then nothing is sent and the link stays in the box) */
export function askLinkChoice(url: string) {
    return new Promise<LinkChoice | null>(resolve => {
        let result: LinkChoice | null = null;
        openWindow(close => <LinkChoiceWindow close={close} url={url} onChoice={c => result = c} onDone={() => resolve(result)} />, { size: "small" });
    });
}
