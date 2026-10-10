/*
 * SecretChat – video player for decrypted videos.
 * Discord's own player can't be used: the video only exists here as a blob: URL. This one has play/pause, a seek
 * bar, volume (remembered), loop, picture-in-picture (popout window over everything), a big view and fullscreen.
 * Keyboard while focused: Space/K play, ←/→ 5 s, ↑/↓ volume, M mute, L loop, F fullscreen.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { classes } from "@utils/misc";
import { openModal } from "@utils/modal";
import { Tooltip, useEffect, useRef, useState } from "@webpack/common";
import type { CSSProperties, ReactNode } from "react";

const cl = classNameFactory("vc-secretchat-player-");

// ---------------------------------------------------------------- Remembered volume

const VOLUME_KEY = "SecretChat_playerVolume";

function loadVolume(): { volume: number; muted: boolean; } {
    try {
        const v = JSON.parse(localStorage.getItem(VOLUME_KEY) ?? "");
        if (typeof v?.volume === "number") return { volume: Math.min(1, Math.max(0, v.volume)), muted: !!v.muted };
    } catch { /* first start or storage blocked */ }
    return { volume: 0.8, muted: false };
}

function saveVolume(volume: number, muted: boolean) {
    try {
        localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume, muted }));
    } catch { /* not important */ }
}

// ---------------------------------------------------------------- Icons (Lucide style, line)

const I = {
    play: <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5Z" fill="currentColor" stroke="none" />,
    pause: <><rect x="6" y="4" width="4" height="16" rx="1.2" fill="currentColor" stroke="none" /><rect x="14" y="4" width="4" height="16" rx="1.2" fill="currentColor" stroke="none" /></>,
    volume: <><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></>,
    volumeLow: <><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /></>,
    mute: <><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="m22 9-6 6" /><path d="m16 9 6 6" /></>,
    loop: <><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></>,
    pip: <><rect x="2" y="4" width="20" height="16" rx="2" /><rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor" /></>,
    expand: <><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="m21 3-7 7" /><path d="m3 21 7-7" /></>,
    fullscreen: <><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></>,
    exitFullscreen: <><path d="M8 3v3a2 2 0 0 1-2 2H3" /><path d="M21 8h-3a2 2 0 0 1-2-2V3" /><path d="M3 16h3a2 2 0 0 1 2 2v3" /><path d="M16 21v-3a2 2 0 0 1 2-2h3" /></>
};

const Svg = ({ children, size = 18 }: { children: ReactNode; size?: number; }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
    </svg>
);

function Ctrl({ label, onClick, active, children }: { label: string; onClick(): void; active?: boolean; children: ReactNode; }) {
    return (
        <Tooltip text={label}>
            {(tip: any) => (
                <button
                    {...tip}
                    type="button"
                    aria-label={label}
                    className={classes(cl("btn"), active && cl("btn-on"))}
                    onClick={e => { e.stopPropagation(); onClick(); }}
                >
                    {children}
                </button>
            )}
        </Tooltip>
    );
}

const time = (s: number) => {
    if (!isFinite(s)) return "0:00";
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

// ---------------------------------------------------------------- Player

export function VideoPlayer({ src, name, style, big, autoPlay, startAt }: {
    src: string; name: string; style?: CSSProperties;
    /** In the big view: no expand button, fills the space */
    big?: boolean;
    autoPlay?: boolean;
    startAt?: number;
}) {
    const root = useRef<HTMLDivElement>(null);
    const video = useRef<HTMLVideoElement>(null);
    const [playing, setPlaying] = useState(false);
    const [current, setCurrent] = useState(0);
    const [duration, setDuration] = useState(0);
    const [buffered, setBuffered] = useState(0);
    const [{ volume, muted }, setVol] = useState(loadVolume);
    const [loop, setLoop] = useState(false);
    const [fullscreen, setFullscreen] = useState(false);
    const [idle, setIdle] = useState(false);
    const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const v = () => video.current;

    useEffect(() => {
        const el = v();
        if (!el) return;
        el.volume = volume;
        el.muted = muted;
    }, [volume, muted]);

    useEffect(() => {
        const onFs = () => setFullscreen(document.fullscreenElement === root.current);
        document.addEventListener("fullscreenchange", onFs);
        return () => {
            document.removeEventListener("fullscreenchange", onFs);
            clearTimeout(idleTimer.current);
        };
    }, []);

    const setVolume = (next: number, nextMuted = next === 0) => {
        setVol({ volume: next, muted: nextMuted });
        saveVolume(next, nextMuted);
    };

    const toggle = () => {
        const el = v();
        if (!el) return;
        if (el.paused) el.play().catch(() => { });
        else el.pause();
    };
    const seek = (t: number) => {
        const el = v();
        if (el) el.currentTime = Math.min(Math.max(0, t), el.duration || 0);
    };
    const toggleFullscreen = () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => { });
        else root.current?.requestFullscreen().catch(() => { });
    };
    const pip = () => {
        const el = v();
        if (!el) return;
        if (document.pictureInPictureElement === el) document.exitPictureInPicture().catch(() => { });
        else el.requestPictureInPicture().catch(() => { });
    };
    const expand = () => {
        const el = v();
        const at = el?.currentTime ?? 0;
        el?.pause();
        openVideoViewer(src, name, at);
    };

    // Controls fade out while playing and the mouse rests
    const wake = () => {
        setIdle(false);
        clearTimeout(idleTimer.current);
        idleTimer.current = setTimeout(() => setIdle(true), 2200);
    };

    const onKey = (e: React.KeyboardEvent) => {
        const el = v();
        if (!el) return;
        const keys: Record<string, () => void> = {
            " ": toggle, k: toggle,
            ArrowLeft: () => seek(el.currentTime - 5),
            ArrowRight: () => seek(el.currentTime + 5),
            ArrowUp: () => setVolume(Math.min(1, volume + 0.1), false),
            ArrowDown: () => setVolume(Math.max(0, volume - 0.1)),
            m: () => setVolume(volume || 0.5, !muted),
            l: () => setLoop(x => !x),
            f: toggleFullscreen
        };
        const fn = keys[e.key.length === 1 ? e.key.toLowerCase() : e.key];
        if (!fn) return;
        e.preventDefault();
        e.stopPropagation();
        fn();
        wake();
    };

    const progress = duration ? current / duration : 0;
    const shownVolume = muted ? 0 : volume;
    const volumeIcon = shownVolume === 0 ? I.mute : shownVolume < 0.5 ? I.volumeLow : I.volume;
    const pipSupported = typeof document !== "undefined" && document.pictureInPictureEnabled;

    return (
        <div
            ref={root}
            tabIndex={0}
            className={classes(cl("root"), big && cl("big"), fullscreen && cl("fullscreen"), playing && idle && cl("idle"), !playing && cl("paused"))}
            style={style}
            onKeyDown={onKey}
            onMouseMove={wake}
            onMouseLeave={() => playing && setIdle(true)}
            onClick={e => e.stopPropagation()}
        >
            <video
                ref={video}
                src={src}
                loop={loop}
                autoPlay={autoPlay}
                playsInline
                onClick={toggle}
                onDoubleClick={toggleFullscreen}
                onPlay={() => { setPlaying(true); wake(); }}
                onPause={() => { setPlaying(false); setIdle(false); }}
                onTimeUpdate={e => setCurrent(e.currentTarget.currentTime)}
                onDurationChange={e => setDuration(e.currentTarget.duration)}
                onLoadedMetadata={e => { if (startAt) e.currentTarget.currentTime = startAt; }}
                onProgress={e => {
                    const b = e.currentTarget.buffered;
                    if (b.length && e.currentTarget.duration) setBuffered(b.end(b.length - 1) / e.currentTarget.duration);
                }}
                onVolumeChange={e => {
                    // Picture-in-picture window or keyboard media keys can change it too
                    const el = e.currentTarget;
                    if (el.volume !== volume || el.muted !== muted) setVol({ volume: el.volume, muted: el.muted });
                }}
            />

            {!playing && (
                <button type="button" className={cl("bigplay")} aria-label="Play" onClick={toggle}>
                    <Svg size={26}>{I.play}</Svg>
                </button>
            )}

            <div className={cl("bar")} onDoubleClick={e => e.stopPropagation()}>
                <div className={cl("seek")} style={{ "--p": progress, "--b": buffered } as CSSProperties}>
                    <input
                        type="range"
                        min={0}
                        max={duration || 0}
                        step={0.01}
                        value={current}
                        aria-label="Seek"
                        onChange={e => { seek(Number(e.currentTarget.value)); setCurrent(Number(e.currentTarget.value)); }}
                    />
                </div>
                <div className={cl("row")}>
                    <Ctrl label={playing ? "Pause (K)" : "Play (K)"} onClick={toggle}>
                        <Svg>{playing ? I.pause : I.play}</Svg>
                    </Ctrl>
                    <div className={cl("volume")}>
                        <Ctrl label={muted || !volume ? "Unmute (M)" : "Mute (M)"} onClick={() => setVolume(volume || 0.5, !(muted || !volume))}>
                            <Svg>{volumeIcon}</Svg>
                        </Ctrl>
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={shownVolume}
                            aria-label="Volume"
                            style={{ "--p": shownVolume } as CSSProperties}
                            onChange={e => setVolume(Number(e.currentTarget.value))}
                        />
                    </div>
                    <span className={cl("time")}>{time(current)} / {time(duration)}</span>
                    <span className={cl("spacer")} />
                    <Ctrl label={loop ? "Loop on (L)" : "Loop (L)"} active={loop} onClick={() => setLoop(x => !x)}>
                        <Svg>{I.loop}</Svg>
                    </Ctrl>
                    {pipSupported && (
                        <Ctrl label="Pop out (picture in picture)" onClick={pip}>
                            <Svg>{I.pip}</Svg>
                        </Ctrl>
                    )}
                    {!big && !fullscreen && (
                        <Ctrl label="Bigger view" onClick={expand}>
                            <Svg>{I.expand}</Svg>
                        </Ctrl>
                    )}
                    <Ctrl label={fullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"} onClick={toggleFullscreen}>
                        <Svg>{fullscreen ? I.exitFullscreen : I.fullscreen}</Svg>
                    </Ctrl>
                </div>
            </div>
        </div>
    );
}

/** Big view of a decrypted video, continuing where the small player was */
export function openVideoViewer(src: string, name: string, startAt = 0, autoPlay = true) {
    openModal(props => (
        <div className="vc-secretchat-viewer" onClick={props.onClose}>
            <VideoPlayer src={src} name={name} big autoPlay={autoPlay} startAt={startAt} />
            <div className="vc-secretchat-viewer-bar" onClick={e => e.stopPropagation()}>
                <span className="vc-secretchat-viewer-name">{name}</span>
                <a className="vc-secretchat-viewer-btn" href={src} download={name} title="Save the decrypted video">Save</a>
                <button type="button" className="vc-secretchat-viewer-btn" onClick={props.onClose}>Close</button>
            </div>
        </div>
    ));
}
