/*
 * ChatPopout – watch Go Live streams: docked on the right of a chat popout or in their own window
 * Uses Discord's own video component (MediaEngineStore.getVideoComponent) and its STREAM_WATCH/STREAM_CLOSE actions.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import {
    ApplicationStreamingStore, ApplicationStreamPreviewStore, ChannelRTCStore, ChannelStore, FluxDispatcher, MediaEngineStore, PopoutActions, PopoutWindowStore,
    SelectedChannelStore, showToast, useEffect, useRef, UserStore, useState, useStateFromStores
} from "@webpack/common";

import { ContextMenu, MenuItem, MenuState } from "./menu";
import { cl, CLOSE_PATH, displayName, Icon, log, MAIN_PATH, MAX_PATH, MIN_PATH, MUTE_PATH, PIN_PATH, POPOUT_PATH, SPEAKER_PATH, tip, usePopoutDocument, userAvatar } from "./shared";
import { toggleUserMute, VolumeSlider } from "./voice";

export interface StreamTarget {
    userId: string;
    channelId: string;
    guildId: string | null;
    streamKey: string;
}

const WINDOW_PREFIX = "DISCORD_VC_CHATPOPOUT_STREAM_";
const FULLSCREEN_PATH = "M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm14 0h2v6h-6v-2h4v-4Z";

/** Streams shown in their own window – a docked view must not stop them when it closes */
const inWindow = new Set<string>();

function encodeStreamKey(s: any): string | null {
    if (!s?.ownerId || !s?.channelId) return null;
    return s.streamType === "guild" || s.guildId
        ? `guild:${s.guildId}:${s.channelId}:${s.ownerId}`
        : `call:${s.channelId}:${s.ownerId}`;
}

/** Stream of a user in this channel, if they are live */
export function streamTargetFor(userId: string, channelId: string): StreamTarget | null {
    const channel = ChannelStore.getChannel(channelId);
    const guildId: string | null = channel?.guild_id ?? null;
    const stream: any = ApplicationStreamingStore.getStreamForUser(userId, guildId) ?? ApplicationStreamingStore.getAnyStreamForUser(userId);
    if (!stream || stream.channelId !== channelId) return null;
    const streamKey = encodeStreamKey(stream);
    return streamKey ? { userId, channelId, guildId, streamKey } : null;
}

export function startWatching(t: StreamTarget) {
    // Only possible while connected to the call (Discord's rule)
    if (SelectedChannelStore.getVoiceChannelId() !== t.channelId) {
        showToast("Join the call to watch the stream", "message");
        return false;
    }
    try {
        FluxDispatcher.dispatch({ type: "STREAM_WATCH", streamKey: t.streamKey, allowMultiple: true } as any);
        return true;
    } catch (e) {
        log.error("Couldn't watch stream", e);
        showToast("Couldn't open the stream", "failure");
        return false;
    }
}

export function stopWatching(t: StreamTarget) {
    // Your own stream keeps running – only the preview closes
    if (t.userId === UserStore.getCurrentUser()?.id) return;
    try {
        FluxDispatcher.dispatch({ type: "STREAM_CLOSE", streamKey: t.streamKey } as any);
    } catch (e) {
        log.error("Couldn't close stream", e);
    }
}

// ---------------------------------------------------------------- Video

function useStreamState(t: StreamTarget) {
    const streamId = useStateFromStores([ChannelRTCStore], () => {
        const p: any = (ChannelRTCStore.getParticipants(t.channelId) ?? []).find((x: any) => x?.stream && x.user?.id === t.userId);
        return (p?.streamId as string | undefined) ?? null;
    });
    const live = useStateFromStores([ApplicationStreamingStore], () => !!ApplicationStreamingStore.getActiveStreamForStreamKey(t.streamKey) || !!streamTargetFor(t.userId, t.channelId));
    const preview = useStateFromStores([ApplicationStreamPreviewStore], () => ApplicationStreamPreviewStore.getPreviewURLForStreamKey(t.streamKey) ?? null);
    return { streamId, live, preview };
}

function StreamVideo({ target }: { target: StreamTarget; }) {
    const { streamId, live, preview } = useStreamState(target);
    const Video: any = MediaEngineStore.getVideoComponent?.();

    if (!live) return <div className={cl("stream-empty")}>The stream has ended.</div>;

    return (
        <div className={cl("stream-video")}>
            {preview && <img className={cl("stream-preview")} src={preview} alt="" />}
            {streamId && Video
                ? <ErrorBoundary noop><Video streamId={streamId} fit="contain" paused={false} mirror={false} className={cl("stream-media")} /></ErrorBoundary>
                : <div className={cl("stream-loading")}><span className={cl("stream-spinner")} /> Connecting to stream …</div>}
        </div>
    );
}

const isOwn = (t: StreamTarget) => t.userId === UserStore.getCurrentUser()?.id;

/** Stream audio has its own volume/mute in Discord ("stream" context), separate from the voice */
function useStreamMuted(t: StreamTarget) {
    return useStateFromStores([MediaEngineStore], () => MediaEngineStore.isLocalMute(t.userId, "stream" as any));
}

function MuteButton({ target }: { target: StreamTarget; }) {
    const muted = useStreamMuted(target);
    if (isOwn(target)) return null;
    return (
        <button
            className={classes(cl("icon-btn"), muted && cl("icon-btn-muted"))}
            aria-label={muted ? "Unmute stream" : "Mute stream"}
            {...tip(muted ? "Unmute stream" : "Mute stream (right-click for volume)", "bottom", "end")}
            onClick={() => toggleUserMute(target.userId, "stream")}
        >
            <Icon path={muted ? MUTE_PATH : SPEAKER_PATH} size={16} />
        </button>
    );
}

function StreamHead({ target, children }: { target: StreamTarget; children: React.ReactNode; }) {
    const name = displayName(target.userId, target.guildId);
    return (
        <div className={cl("stream-head")}>
            <img className={cl("stream-avatar")} src={userAvatar(target.userId, UserStore.getUser(target.userId), 48)} alt="" data-user-id={target.userId} />
            <span className={cl("stream-name")}>{name}</span>
            <span className={cl("voice-row-live")}>LIVE</span>
            <div className={cl("stream-actions")}>
                <MuteButton target={target} />
                {children}
            </div>
        </div>
    );
}

/** Right-click on a stream: volume and mute of the stream audio, plus the window actions */
function streamMenu(t: StreamTarget, actions: MenuItem[]): MenuItem[][] {
    const audio: MenuItem[] = isOwn(t) ? [] : [
        { id: "stream-volume", label: "Stream Volume", render: () => <VolumeSlider userId={t.userId} context="stream" label="Stream Volume" /> },
        { id: "stream-mute", label: "Mute Stream", checked: () => MediaEngineStore.isLocalMute(t.userId, "stream" as any), action: () => toggleUserMute(t.userId, "stream") }
    ];
    return [audio, actions].filter(s => s.length);
}

/** Context menu state for a stream surface; the menu renders in the same window */
function useStreamMenu(build: () => MenuItem[][]) {
    const [menu, setMenu] = useState<MenuState | null>(null);
    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY, sections: build() });
    };
    const element = menu && <ErrorBoundary noop><ContextMenu state={menu} onClose={() => setMenu(null)} /></ErrorBoundary>;
    return { onContextMenu, element };
}

function toggleFullscreen(el: HTMLElement | null) {
    const doc = el?.ownerDocument;
    if (!el || !doc) return;
    if (doc.fullscreenElement) doc.exitFullscreen().catch(() => { });
    else el.requestFullscreen().catch(e => log.error("Fullscreen failed", e));
}

// ---------------------------------------------------------------- Docked (right side of the chat popout)

export function StreamDock({ target, width, onResize, onClose, onPopout }: {
    target: StreamTarget; width: number; onResize(w: number): void; onClose(): void; onPopout(): void;
}) {
    const ref = useRef<HTMLDivElement>(null);

    // Leaving the dock (closed, channel switched, window closed) stops watching – unless it moved to its own window
    useEffect(() => () => {
        if (!inWindow.has(target.streamKey)) stopWatching(target);
    }, [target.streamKey]);

    const startDrag = (e: React.MouseEvent) => {
        e.preventDefault();
        const doc = ref.current?.ownerDocument;
        const right = ref.current?.getBoundingClientRect().right ?? 0;
        if (!doc) return;
        const onMove = (ev: MouseEvent) => onResize(right - ev.clientX);
        const onUp = () => {
            doc.removeEventListener("mousemove", onMove);
            doc.removeEventListener("mouseup", onUp);
            doc.body.classList.remove(cl("resizing"));
        };
        doc.addEventListener("mousemove", onMove);
        doc.addEventListener("mouseup", onUp);
        doc.body.classList.add(cl("resizing"));
    };

    const menu = useStreamMenu(() => streamMenu(target, [
        { id: "fullscreen", label: "Fullscreen", icon: FULLSCREEN_PATH, action: () => toggleFullscreen(ref.current) },
        { id: "popout", label: "Open in Own Window", icon: POPOUT_PATH, action: onPopout },
        { id: "stop", label: "Stop Watching", icon: CLOSE_PATH, danger: true, action: onClose }
    ]));

    return (
        <div ref={ref} className={cl("stream-dock")} style={{ width }} onContextMenu={menu.onContextMenu}>
            {menu.element}
            <div className={cl("stream-resizer")} onMouseDown={startDrag} />
            <StreamHead target={target}>
                <button className={cl("icon-btn")} aria-label="Fullscreen" {...tip("Fullscreen", "bottom", "end")} onClick={() => toggleFullscreen(ref.current)}>
                    <Icon path={FULLSCREEN_PATH} size={16} />
                </button>
                <button className={cl("icon-btn")} aria-label="Pop out stream" {...tip("Open stream in its own window", "bottom", "end")} onClick={onPopout}>
                    <Icon path={POPOUT_PATH} size={16} />
                </button>
                <button className={classes(cl("icon-btn"), cl("icon-btn-danger"))} aria-label="Close stream" {...tip("Stop watching", "bottom", "end")} onClick={onClose}>
                    <Icon path={CLOSE_PATH} size={16} />
                </button>
            </StreamHead>
            <StreamVideo target={target} />
        </div>
    );
}

// ---------------------------------------------------------------- Own window

const windowKey = (t: StreamTarget) => WINDOW_PREFIX + t.userId;

function StreamWindow({ target, windowKey: key, onDock }: { target: StreamTarget; windowKey: string; onDock?(): void; }) {
    const rootRef = useRef<HTMLDivElement>(null);
    usePopoutDocument(rootRef, `${displayName(target.userId, target.guildId)} – Stream`);
    const pinned = useStateFromStores([PopoutWindowStore], () => PopoutWindowStore.getIsAlwaysOnTop(key));
    const native = (window as any).DiscordNative?.window;

    // Closing the window stops watching (not when it goes back into the chat window)
    const docking = useRef(false);
    useEffect(() => () => {
        inWindow.delete(target.streamKey);
        if (!docking.current) stopWatching(target);
    }, []);

    useAspectLock(rootRef);

    const dock = onDock && (() => {
        docking.current = true;
        try {
            onDock();
        } catch (e) {
            log.error("Couldn't dock stream", e);
        }
        PopoutActions.close(key);
    });

    const menu = useStreamMenu(() => streamMenu(target, [
        { id: "fullscreen", label: "Fullscreen", icon: FULLSCREEN_PATH, action: () => toggleFullscreen(rootRef.current) },
        ...(dock ? [{ id: "dock", label: "Dock into Chat Window", icon: MAIN_PATH, action: dock }] : []),
        { id: "pin", label: "Always on Top", checked: () => PopoutWindowStore.getIsAlwaysOnTop(key), action: () => PopoutActions.setAlwaysOnTop(key, !PopoutWindowStore.getIsAlwaysOnTop(key)) },
        { id: "stop", label: "Stop Watching", icon: CLOSE_PATH, danger: true, action: () => PopoutActions.close(key) }
    ]));

    const button = (path: string, label: string, onClick: () => void, extra?: string) => (
        <button className={classes(cl("icon-btn"), extra)} aria-label={label} {...tip(label, "bottom", "end")} onClick={onClick}>
            <Icon path={path} size={16} />
        </button>
    );

    return (
        <div ref={rootRef} className={classes(cl("window"), cl("stream-window"))} onContextMenu={menu.onContextMenu}>
            {menu.element}
            <header className={cl("titlebar")}>
                <img className={cl("title-icon")} src={userAvatar(target.userId, UserStore.getUser(target.userId), 64)} alt="" />
                <div className={cl("title-text")}>
                    <div className={cl("title-name")}>{displayName(target.userId, target.guildId)}</div>
                    <div className={cl("title-sub")}>Stream · {ChannelStore.getChannel(target.channelId)?.name ?? ""}</div>
                </div>
                <div className={cl("title-actions")}>
                    <MuteButton target={target} />
                    {button(PIN_PATH, pinned ? "Unpin from top" : "Always on top", () => PopoutActions.setAlwaysOnTop(key, !pinned), pinned ? cl("icon-btn-active") : undefined)}
                    {dock && button(MAIN_PATH, "Dock back into the chat window", dock)}
                    {button(FULLSCREEN_PATH, "Fullscreen", () => toggleFullscreen(rootRef.current))}
                    {native?.minimize && button(MIN_PATH, "Minimize", () => native.minimize(key))}
                    {native?.maximize && button(MAX_PATH, "Maximize", () => native.maximize(key))}
                    {button(CLOSE_PATH, "Close", () => PopoutActions.close(key), cl("icon-btn-danger"))}
                </div>
            </header>
            <StreamVideo target={target} />
        </div>
    );
}

export function openStreamWindow(t: StreamTarget, onDock?: () => void) {
    inWindow.add(t.streamKey);
    try {
        PopoutActions.open(windowKey(t), k => (
            <ErrorBoundary message="Couldn't display the stream.">
                <StreamWindow target={t} windowKey={k} onDock={onDock} />
            </ErrorBoundary>
        ), { defaultWidth: 960, defaultHeight: 580 });
    } catch (e) {
        inWindow.delete(t.streamKey);
        log.error("Couldn't open stream window", e);
        showToast("Couldn't open stream window", "failure");
    }
}

/** Remembers the docked width per window session */
export function useDockWidth(rootRef: React.RefObject<HTMLElement | null>) {
    const [width, setWidth] = useState(480);
    const clamp = (w: number) => {
        const total = rootRef.current?.getBoundingClientRect().width ?? 1000;
        return Math.round(Math.max(280, Math.min(w, total - 320)));
    };
    return [width, (w: number) => setWidth(clamp(w))] as const;
}

// ---------------------------------------------------------------- No black bars

/** Size of the stream picture (Discord renders it into a <video> or a <canvas>) */
function videoAspect(root: HTMLElement): number | null {
    const video = root.querySelector<HTMLVideoElement>(`.${cl("stream-video")} video`);
    if (video?.videoWidth && video.videoHeight) return video.videoWidth / video.videoHeight;
    const canvas = root.querySelector<HTMLCanvasElement>(`.${cl("stream-video")} canvas`);
    if (canvas?.width && canvas.height) return canvas.width / canvas.height;
    return null;
}

/**
 * Keeps the stream window at the stream's aspect ratio: drag the width and the height follows (and vice versa),
 * so there are never black bars. Not while maximized or in fullscreen.
 */
function useAspectLock(rootRef: React.RefObject<HTMLElement | null>) {
    useEffect(() => {
        const root = rootRef.current;
        const win = root?.ownerDocument.defaultView;
        if (!root || !win) return;

        let last = { w: win.innerWidth, h: win.innerHeight };
        let timer: ReturnType<typeof setTimeout> | undefined;

        const fit = () => {
            const aspect = videoAspect(root);
            if (!aspect || root.ownerDocument.fullscreenElement) return;
            const maximized = win.outerWidth >= win.screen.availWidth - 8 && win.outerHeight >= win.screen.availHeight - 8;
            if (maximized) return;

            const head = root.querySelector<HTMLElement>(`.${cl("titlebar")}`)?.offsetHeight ?? 0;
            const w = win.innerWidth, h = win.innerHeight;
            // Whichever side the user dragged stays, the other one follows
            const widthDragged = Math.abs(w - last.w) >= Math.abs(h - last.h);
            let targetW = w, targetH = h;
            if (widthDragged) targetH = Math.round(w / aspect) + head;
            else targetW = Math.round((h - head) * aspect);

            // Never bigger than the screen
            const maxW = win.screen.availWidth - (win.outerWidth - w);
            const maxH = win.screen.availHeight - (win.outerHeight - h);
            if (targetW > maxW) { targetW = maxW; targetH = Math.round(maxW / aspect) + head; }
            if (targetH > maxH) { targetH = maxH; targetW = Math.round((maxH - head) * aspect); }

            last = { w: targetW, h: targetH };
            if (Math.abs(targetW - w) > 1 || Math.abs(targetH - h) > 1) {
                try {
                    win.resizeBy(targetW - w, targetH - h);
                } catch { /* not resizable */ }
            }
        };

        const onResize = () => {
            clearTimeout(timer);
            timer = setTimeout(fit, 180);
        };
        win.addEventListener("resize", onResize);
        // First frame / resolution changes of the stream
        const interval = setInterval(fit, 1500);
        return () => {
            win.removeEventListener("resize", onResize);
            clearTimeout(timer);
            clearInterval(interval);
        };
    }, []);
}
