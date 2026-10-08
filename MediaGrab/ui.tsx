/*
 * MediaGrab – Window: paste a link, choose video / MP3, quality and where it goes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { IconComponent } from "@utils/types";
import { Channel, RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, useEffect, useReducer, useState } from "@webpack/common";
import type { ReactNode } from "react";

import { getRunning, grab, isInstalled, isUrl, needsRestart, shortUrl, subscribeRunning } from "./grab";
import { settings } from "./settings";

const cl = classNameFactory("vc-mediagrab-");

export const GrabIcon: IconComponent = ({ width = 24, height = 24, className }) => {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" className={className} fill="currentColor">
            <path d="M5 3a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h5.1a6.97 6.97 0 0 1 .9-2H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v4.1c.71.26 1.39.62 2 1.06V6a3 3 0 0 0-3-3H5Zm4.5 4.13v5.74a.5.5 0 0 0 .75.43l4.92-2.87a.5.5 0 0 0 0-.86L10.25 6.7a.5.5 0 0 0-.75.43ZM17 12a1 1 0 0 1 1 1v4.59l1.3-1.3a1 1 0 0 1 1.4 1.42l-3 3a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.42l1.3 1.3V13a1 1 0 0 1 1-1Z" />
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
        <span className={cl("bar-icon")}>
            <GrabIcon width={20} height={20} />
            {count > 0 && (
                <svg className={classes(cl("ring"), progress < 0 && cl("ring-spin"))} viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" className={cl("ring-track")} />
                    <circle
                        cx="12" cy="12" r="10"
                        className={cl("ring-fill")}
                        strokeDasharray={RING}
                        strokeDashoffset={progress < 0 ? RING * 0.7 : RING * (1 - progress)}
                    />
                </svg>
            )}
            {count > 1 && <span className={cl("badge")}>{count}</span>}
        </span>
    );
}

export function chatBarTooltip(count: number, progress: number) {
    if (!count) return "MediaGrab: video / MP3 from a link";
    const what = count > 1 ? `${count} downloads` : "Downloading";
    return progress >= 0 ? `${what} · ${Math.round(progress * 100)}%` : `${what} …`;
}

function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string; }[]; onChange(v: T): void; }) {
    return (
        <div className={cl("segmented")}>
            {options.map(o => (
                <button key={o.value} className={classes(cl("segment"), o.value === value && cl("segment-on"))} onClick={() => onChange(o.value)}>
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function Toggle({ on, disabled, label, hint, onChange }: { on: boolean; disabled?: boolean; label: string; hint?: string; onChange(v: boolean): void; }) {
    return (
        <button className={classes(cl("toggle"), on && !disabled && cl("toggle-on"))} disabled={disabled} onClick={() => onChange(!on)}>
            <span className={cl("check")}>{on && !disabled ? "✓" : ""}</span>
            <span>
                <div>{label}</div>
                {hint && <div className={cl("muted")}>{hint}</div>}
            </span>
        </button>
    );
}

function Field({ label, children }: { label: string; children: ReactNode; }) {
    return (
        <div className={cl("field")}>
            <div className={cl("label")}>{label}</div>
            {children}
        </div>
    );
}

async function readClipboardUrl() {
    try {
        const text = (await navigator.clipboard.readText()).trim();
        return isUrl(text) ? text : "";
    } catch {
        return "";
    }
}

function GrabModal({ modalProps, channel, links }: { modalProps: RenderModalProps; channel?: Channel | null; links: string[]; }) {
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
        modalProps.onClose();
        grab({ url: url.trim(), kind, maxHeight: quality, toChat: toChat && !!channel, toDisk, channel });
    };

    return (
        <Modal
            {...modalProps}
            size="md"
            title="MediaGrab"
            subtitle="Video or MP3 from TikTok, YouTube, Instagram, X, Reddit and many more"
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                { text: "Download", variant: "primary", onClick: start, disabled: !valid }
            ]}
        >
            <div className={cl("form")}>
                <Field label="Link">
                    <input
                        className={cl("input")}
                        value={url}
                        autoFocus
                        placeholder="https://www.tiktok.com/@…/video/…"
                        onChange={e => setUrl(e.currentTarget.value)}
                        onKeyDown={e => { if (e.key === "Enter") start(); }}
                    />
                    {links.length > 1 && (
                        <div className={cl("links")}>
                            {links.map(l => (
                                <button key={l} className={classes(cl("chip"), l === url && cl("chip-on"))} title={l} onClick={() => setUrl(l)}>
                                    {shortUrl(l)}
                                </button>
                            ))}
                        </div>
                    )}
                </Field>

                <Field label="Format">
                    <Segmented<"video" | "audio"> value={kind} onChange={setKind} options={[{ value: "video", label: "Video (MP4)" }, { value: "audio", label: "Audio (MP3)" }]} />
                </Field>

                {kind === "video" && (
                    <Field label="Quality">
                        <Segmented<number>
                            value={quality}
                            onChange={setQuality}
                            options={[{ value: 0, label: "Best" }, { value: 1080, label: "1080p" }, { value: 720, label: "720p" }, { value: 480, label: "480p" }]}
                        />
                    </Field>
                )}

                <Field label="Send to">
                    <div className={cl("toggles")}>
                        <Toggle
                            on={toChat}
                            disabled={!channel}
                            label="Into the chat"
                            hint={channel ? "Attached to your message box. Too large → Gofile link." : "Open a chat first"}
                            onChange={setToChat}
                        />
                        <Toggle on={toDisk} label="Downloads folder" hint="Saved on this PC" onChange={setToDisk} />
                    </div>
                </Field>

                {needsRestart() && (
                    <div className={classes(cl("notice"), cl("notice-error"))}>
                        Quit Discord completely once (tray icon → Quit) and start it again. Ctrl+R is not enough to install MediaGrab.
                    </div>
                )}

                {!installed && !needsRestart() && (
                    <div className={cl("notice")}>
                        The first download installs yt-dlp and ffmpeg (about 100 MB, only once).
                    </div>
                )}
            </div>
        </Modal>
    );
}

export function openGrabModal(channel?: Channel | null, links: string[] = []) {
    openModal(props => (
        <ErrorBoundary>
            <GrabModal modalProps={props} channel={channel} links={links} />
        </ErrorBoundary>
    ));
}

// ---------------------------------------------------------------- Asked when a message is only a video link

export type LinkChoice = "link" | "video" | "audio";

const CHOICES: { value: LinkChoice; label: string; hint: string; }[] = [
    { value: "link", label: "Send link", hint: "As usual" },
    { value: "video", label: "Video (MP4)", hint: "Download and send the video" },
    { value: "audio", label: "Audio (MP3)", hint: "Download and send the sound" }
];

/** Resolves with the choice, or null if the window was closed (then nothing is sent and the link stays in the box) */
export function askLinkChoice(url: string) {
    return new Promise<LinkChoice | null>(resolve => {
        let result: LinkChoice | null = null;
        openModal(props => (
            <ErrorBoundary>
                <Modal {...props} size="sm" title="Send as link or as file?" subtitle={shortUrl(url)}>
                    <div className={cl("choices")}>
                        {CHOICES.map((c, i) => (
                            <button
                                key={c.value}
                                className={cl("choice")}
                                autoFocus={i === 0}
                                onClick={() => {
                                    result = c.value;
                                    props.onClose();
                                }}
                            >
                                <span className={cl("choice-label")}>{c.label}</span>
                                <span className={cl("muted")}>{c.hint}</span>
                            </button>
                        ))}
                    </div>
                    {needsRestart() && (
                        <div className={classes(cl("notice"), cl("notice-error"))} style={{ marginTop: 12 }}>
                            Quit Discord completely once (tray icon → Quit) and start it again – until then only “Send link” works.
                        </div>
                    )}
                    <div className={cl("muted")} style={{ margin: "12px 0 8px" }}>
                        Esc keeps the link in the message box. You can turn this question off in the MediaGrab settings.
                    </div>
                </Modal>
            </ErrorBoundary>
        ), { onCloseCallback: () => resolve(result) });
    });
}
