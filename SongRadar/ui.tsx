/*
 * SongRadar – title bar icon, popout / window with the listen button, result card, history and settings.
 * No JSX at module level (it would run before React is ready and crash Vencord) – only inside components.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { plugins } from "@api/PluginManager";
import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { openPluginModal } from "@components/settings";
import { insertTextIntoChatInputBox } from "@utils/discord";
import { classes } from "@utils/misc";
import { findComponentByCodeLazy } from "@webpack";
import { Popout, showToast, Tooltip, useEffect, useRef, useState } from "@webpack/common";
import type { CSSProperties } from "react";

import { Button, Empty, IconButton, ICONS, openWindow, Popover, RoundButton, Section, Sheet, ToggleRow, useListener } from "../_ui";
import { grab, needsRestart as mediaGrabNeedsRestart } from "../MediaGrab/grab";
import { settings } from "./index";
import { PlatformIcon, PLATFORMS } from "./platforms";
import { busy, cancel, findYouTube, forget, listen, listeners, loadCover, showSong, Song, spotifyUrl, state } from "./radar";

const cl = classNameFactory("vc-songradar-");
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');
const POPOUT_STYLE: CSSProperties = { maxHeight: "min(760px, calc(100vh - 72px))" };

const WAVE_PATH = "M12 3a1 1 0 0 1 1 1v16a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1ZM8 7a1 1 0 0 1 1 1v8a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1Zm8 0a1 1 0 0 1 1 1v8a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1ZM4 10a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1Zm16 0a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1Z";

// ---------------------------------------------------------------- Icons

/** Sound bars that dance while listening */
function Bars({ active, size = 20 }: { active?: boolean; size?: number; }) {
    return (
        <span className={classes(cl("bars"), active && cl("bars-active"))} style={{ width: size, height: size }}>
            <i /><i /><i /><i /><i />
        </span>
    );
}

export function RadarMenuIcon() {
    return (
        <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" aria-hidden>
            <path d={WAVE_PATH} />
        </svg>
    );
}

/** App icon: radar sweep with sound bars */
function RadarLogo({ active, size = 42 }: { active?: boolean; size?: number; }) {
    return (
        <span className={classes(cl("logo"), active && cl("logo-active"))} style={{ width: size, height: size }}>
            <span className={cl("logo-sweep")} />
            <Bars active={active} size={Math.round(size * 0.5)} />
        </span>
    );
}

// ---------------------------------------------------------------- Listen button

function ListenButton() {
    const listening = state.phase === "listening";
    const searching = state.phase === "searching";
    const active = listening || searching;
    // Ripples and dancing bars only while sound really comes in (or a file is being searched)
    const alive = (listening && state.hearing) || searching;
    const p = state.progress;

    const label = listening ? state.hearing ? "Listening…" : "Waiting for sound…" : searching ? "Searching…" : "Tap to listen";
    const hint = listening
        ? state.hearing ? "Keep the music playing" : "Nothing is playing yet – start the music"
        : searching
            ? state.source === "media" ? state.sourceName : "Asking Shazam"
            : "Recognizes what your PC plays – voice, streams, videos, Spotify …";

    return (
        <div className={cl("hero")}>
            <button
                type="button"
                className={classes(cl("listen"), active && cl("listen-active"), alive && cl("listen-alive"))}
                aria-label={active ? "Cancel" : "Listen"}
                onClick={() => active ? cancel() : listen()}
            >
                <span className={cl("ring")} />
                <span className={classes(cl("ring"), cl("ring-2"))} />
                <span className={classes(cl("ring"), cl("ring-3"))} />
                <svg className={cl("progress")} viewBox="0 0 100 100" aria-hidden>
                    <circle cx="50" cy="50" r="47" pathLength={100} style={{ strokeDashoffset: 100 - p * 100 } as CSSProperties} />
                </svg>
                <Bars active={alive} size={38} />
            </button>
            <div className={cl("hero-label")}>{label}</div>
            <div className={cl("hero-hint")}>{active ? <>{hint} · <span className={cl("cancel")}>click to cancel</span></> : hint}</div>
        </div>
    );
}

// ---------------------------------------------------------------- Result

/** Row of platform logos – each opens the song there */
function Platforms({ song }: { song: Song; }) {
    return (
        <div className={cl("platforms")}>
            {PLATFORMS.map(p => (
                <Tooltip key={p.id} text={p.name}>
                    {(tip: any) => (
                        <a
                            {...tip}
                            className={cl("platform")}
                            href={p.url(song)}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={p.name}
                            style={{ "--c": p.color } as CSSProperties}
                        >
                            <PlatformIcon platform={p} size={20} />
                        </a>
                    )}
                </Tooltip>
            ))}
        </div>
    );
}

/** Cover image: straight from Apple, or through the main process if the page blocks it */
function CoverImage({ url, className }: { url?: string; className?: string; }) {
    const [src, setSrc] = useState(url);
    useEffect(() => setSrc(url), [url]);
    if (!src) return <span className={className} />;
    return (
        <img
            className={className}
            src={src}
            alt=""
            onError={() => {
                if (!url || src !== url) return setSrc(undefined);
                loadCover(url).then(setSrc, () => setSrc(undefined));
            }}
        />
    );
}

/** MP3 of the song: first YouTube result, downloaded by MediaGrab (yt-dlp) into the Downloads folder */
async function downloadMp3(song: Song) {
    if (mediaGrabNeedsRestart()) {
        showToast("Quit Discord completely once and start it again – the MP3 download needs that", "failure");
        return;
    }
    showToast(`Looking for "${song.title}" …`, "message");
    try {
        const url = await findYouTube(song);
        if (!url) {
            showToast("Couldn't find this song on YouTube", "failure");
            return;
        }
        await grab({ url, kind: "audio", maxHeight: 0, toChat: false, toDisk: true });
    } catch (e: any) {
        showToast(String(e?.message ?? e), "failure");
    }
}

/** Cover with a play button for Apple's 30 s preview */
function Cover({ song, size = 96 }: { song: Song; size?: number; }) {
    const audio = useRef<HTMLAudioElement | null>(null);
    const [playing, setPlaying] = useState(false);
    const { previewVolume } = settings.use(["previewVolume"]);
    useEffect(() => { if (audio.current) audio.current.volume = previewVolume; }, [previewVolume]);
    useEffect(() => () => { audio.current?.pause(); }, [song.key]);

    const toggle = () => {
        if (!song.previewUrl) return;
        if (!audio.current) {
            audio.current = new Audio(song.previewUrl);
            audio.current.volume = settings.store.previewVolume;
            audio.current.onended = () => setPlaying(false);
        }
        if (audio.current.paused) {
            audio.current.play().then(() => setPlaying(true)).catch(() => showToast("The preview couldn't be played", "failure"));
        } else {
            audio.current.pause();
            setPlaying(false);
        }
    };

    return (
        <div className={cl("cover")} style={{ width: size, height: size }}>
            {song.cover ? <CoverImage url={song.cover} /> : <RadarLogo size={size} />}
            {song.previewUrl && (
                <Tooltip text={playing ? "Stop preview" : "Play a 30 s preview"}>
                    {(tip: any) => (
                        <button {...tip} type="button" className={classes(cl("cover-play"), playing && cl("cover-playing"))} onClick={toggle} aria-label="Preview">
                            {playing ? <Bars active size={18} /> : <svg viewBox="0 0 24 24" width={20} height={20} fill="currentColor"><path d={ICONS.play} /></svg>}
                        </button>
                    )}
                </Tooltip>
            )}
        </div>
    );
}

function share(song: Song) {
    insertTextIntoChatInputBox(`🎵 **${song.title}** – ${song.artist}\n${song.appleUrl ?? song.shazamUrl ?? spotifyUrl(song)}`);
    showToast("Added to your message – press Enter to send", "success");
}

function ResultCard({ song }: { song: Song; }) {
    return (
        <div className={cl("result")} key={song.key}>
            <div className={cl("result-top")}>
                <Cover song={song} />
                <div className={cl("result-text")}>
                    <div className={cl("result-title")} title={song.title}>{song.title}</div>
                    <div className={cl("result-artist")} title={song.artist}>{song.artist}</div>
                    {(song.album || song.year) && <div className={cl("result-meta")}>{[song.album, song.year].filter(Boolean).join(" · ")}</div>}
                </div>
            </div>
            <Platforms song={song} />
            <div className={cl("actions")}>
                <Button small variant="tinted" icon={ICONS.download} onClick={() => downloadMp3(song)}>Download MP3</Button>
                <Button small variant="gray" onClick={() => share(song)}>Share in chat</Button>
            </div>
        </div>
    );
}

function Status() {
    if (state.phase === "found" && state.result) return <ResultCard song={state.result} />;
    if (state.phase === "notfound") {
        return (
            <div className={cl("message")}>
                <b>No match</b>
                <span>{state.source === "media" ? "Shazam doesn't know the music in this file." : "Try again while the song is louder or without people talking over it."}</span>
            </div>
        );
    }
    if (state.phase === "error") {
        return (
            <div className={classes(cl("message"), cl("message-error"))}>
                <b>Couldn't listen</b>
                <span>{state.error}</span>
            </div>
        );
    }
    return null;
}

// ---------------------------------------------------------------- History

const ago = (t: number) => {
    const m = Math.round((Date.now() - t) / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    return new Date(t).toLocaleDateString();
};

function History() {
    const { history } = settings.use(["history"]);
    // The song shown above isn't repeated in the list
    const shown = history.filter(s => !(state.phase === "found" && state.result?.key === s.key));
    if (!shown.length) return null;

    return (
        <Section title="Recently recognized">
            {shown.slice(0, 12).map(song => (
                <div key={song.key} className={cl("history-row")} onClick={() => showSong(song)}>
                    <CoverImage url={song.cover} className={cl("history-cover")} />
                    <div className={cl("history-text")}>
                        <b>{song.title}</b>
                        <span>{song.artist} · {ago(song.at)}</span>
                    </div>
                    <IconButton icon={ICONS.close} label="Remove" onClick={() => forget(song.key)} />
                </div>
            ))}
        </Section>
    );
}

// ---------------------------------------------------------------- Panel

/** Volume of the 30 s preview – small slider in the header, the speaker mutes / unmutes */
function VolumeControl() {
    const { previewVolume } = settings.use(["previewVolume"]);
    const last = useRef(previewVolume || 0.4);
    const v = Number(previewVolume) || 0;
    const icon = v === 0
        ? "M11 5 6 9H3v6h3l5 4V5Zm11 4-6 6m0-6 6 6"
        : v < 0.5 ? "M11 5 6 9H3v6h3l5 4V5Zm4.5 3.5a5 5 0 0 1 0 7" : "M11 5 6 9H3v6h3l5 4V5Zm4.5 3.5a5 5 0 0 1 0 7m3-10a9 9 0 0 1 0 13";
    return (
        <div className={cl("volume")}>
            <Tooltip text={v === 0 ? "Unmute preview" : "Mute preview"}>
                {(tip: any) => (
                    <button
                        {...tip}
                        type="button"
                        className={cl("volume-btn")}
                        aria-label="Preview volume"
                        onClick={() => {
                            if (v > 0) { last.current = v; settings.store.previewVolume = 0; }
                            else settings.store.previewVolume = last.current || 0.4;
                        }}
                    >
                        <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d={icon} /></svg>
                    </button>
                )}
            </Tooltip>
            <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={v}
                aria-label="Preview volume"
                style={{ "--p": v } as CSSProperties}
                onChange={e => { settings.store.previewVolume = Number(e.currentTarget.value); }}
            />
        </div>
    );
}

function RadarPanel() {
    useListener(listeners);
    return (
        <div className={cl("panel")}>
            <ListenButton />
            <Status />
            <History />
        </div>
    );
}

function subtitle() {
    if (state.phase === "listening") return "Listening…";
    if (state.phase === "searching") return "Searching…";
    return "Find out what's playing";
}

function RadarSheet({ onClose, embedded }: { onClose?(): void; embedded?: boolean; }) {
    useListener(listeners);
    const openSettings = () => { onClose?.(); openPluginModal(plugins.SongRadar); };
    return (
        <Sheet
            onClose={embedded ? undefined : onClose}
            header={{
                title: "SongRadar",
                subtitle: subtitle(),
                live: busy(),
                iconNode: <RadarLogo active={state.hearing || state.phase === "searching"} />,
                actions: <><VolumeControl /><RoundButton icon={ICONS.gear} label="Settings" onClick={openSettings} className={cl("bare")} /></>
            }}
        >
            <RadarPanel />
        </Sheet>
    );
}

/** Own window – used when recognizing a chat attachment (the title bar popout isn't open then) */
export function openRadarWindow() {
    openWindow(close => <RadarSheet onClose={close} />, { size: "small" });
}

// ---------------------------------------------------------------- Title bar

function TitleBarButton() {
    const { showTitleBarButton } = settings.use(["showTitleBarButton"]);
    useListener(listeners);
    const buttonRef = useRef(null);
    const [show, setShow] = useState(false);
    if (!showTitleBarButton) return null;

    const active = busy();
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
                    <Popover width={410} style={POPOUT_STYLE}>
                        <RadarSheet embedded onClose={() => setShow(false)} />
                    </Popover>
                </ErrorBoundary>
            )}
        >
            {(_, { isShown }) => (
                <HeaderBarIcon
                    ref={buttonRef}
                    className={classes(cl("titlebtn"), active && cl("titlebtn-active"))}
                    onClick={() => setShow(v => !v)}
                    tooltip={isShown ? null : active ? "SongRadar – listening…" : "SongRadar – what song is this?"}
                    icon={() => <Bars active={state.hearing || state.phase === "searching"} size={20} />}
                    selected={isShown}
                />
            )}
        </Popout>
    );
}

export function renderTitleBarButton() {
    return (
        <ErrorBoundary key="vc-songradar-titlebar" noop>
            <TitleBarButton />
        </ErrorBoundary>
    );
}

// ---------------------------------------------------------------- Settings

export const SettingsPanel = ErrorBoundary.wrap(() => {
    const s = settings.use(["showTitleBarButton", "history"]);
    return (
        <Sheet embedded header={{ title: "SongRadar", subtitle: "Recognize music like Shazam – no account needed", iconNode: <RadarLogo /> }}>
            <Section title="Options" footer="Only a fingerprint of the sound is sent to Shazam, never the audio itself.">
                <ToggleRow icon={WAVE_PATH} color="blue" title="Show icon in the title bar" checked={s.showTitleBarButton} onChange={v => settings.store.showTitleBarButton = v} />
            </Section>
            <Section title="History">
                {s.history.length
                    ? (
                        <div className={cl("setting-row")}>
                            <span>{s.history.length === 1 ? "1 recognized song" : `${s.history.length} recognized songs`}</span>
                            <Button small variant="destructive" icon={ICONS.trash} onClick={() => { settings.store.history = []; }}>Clear</Button>
                        </div>
                    )
                    : <Empty icon={WAVE_PATH} title="Nothing recognized yet" />}
            </Section>
        </Sheet>
    );
}, { noop: true });
