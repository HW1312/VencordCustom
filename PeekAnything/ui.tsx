/*
 * PeekAnything – floating preview card, stream & voice views, settings
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { Switch } from "@components/Switch";
import { classes } from "@utils/misc";
import { findByPropsLazy } from "@webpack";
import {
    ApplicationStreamingStore, ApplicationStreamPreviewStore, ChannelRTCStore, ChannelStore, createRoot, GuildMemberStore, GuildStore, IconUtils,
    MediaEngineStore, NavigationRouter, SelectedChannelStore, useEffect, useLayoutEffect, useRef, UserStore, useState, useStateFromStores, VoiceStateStore
} from "@webpack/common";
import type { Root } from "react-dom/client";

import { ChatPreview } from "./chat";
import { closePeek, getState, PeekState, setCallIndex, subscribe, switchTo } from "./controller";
import { cl, logger, settings } from "./index";
import { acquireStream, fetchPreview, inVoiceChannel, releaseStream, StreamRef, toggleStreamMute } from "./streams";
import { streamFor, streamsIn, Target, targetKey } from "./targets";

const ChannelActions = findByPropsLazy("selectVoiceChannel", "selectChannel");

// ---------------------------------------------------------------- Icons

const PIN_PATH = "M19.4 8.6 15.4 4.6a1 1 0 0 0-1.5.1l-.6.8a3 3 0 0 0-.4 2.6l-2.3 2.3a4 4 0 0 0-3.9 1l-.4.4a1 1 0 0 0 0 1.4l2.4 2.4-4.4 4.4a1 1 0 1 0 1.4 1.4l4.4-4.4 2.4 2.4a1 1 0 0 0 1.4 0l.4-.4a4 4 0 0 0 1-3.9l2.3-2.3a3 3 0 0 0 2.6-.4l.8-.6a1 1 0 0 0 .1-1.5Z";
const OPEN_PATH = "M14 3a1 1 0 1 0 0 2h3.6l-7.3 7.3a1 1 0 0 0 1.4 1.4L19 6.4V10a1 1 0 1 0 2 0V4a1 1 0 0 0-1-1h-6ZM5 5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 1 0-2 0v5H5V7h5a1 1 0 1 0 0-2H5Z";
const SPEAKER_PATH = "M12 3a1 1 0 0 0-1.7-.7L6.6 6H4a2 2 0 0 0-2 2v8c0 1.1.9 2 2 2h2.6l3.7 3.7A1 1 0 0 0 12 21V3Zm3.1 5.3a1 1 0 0 1 1.4 0 5 5 0 0 1 0 7.4 1 1 0 1 1-1.4-1.4 3 3 0 0 0 0-4.6 1 1 0 0 1 0-1.4Z";
const MUTED_PATH = "M12 3a1 1 0 0 0-1.7-.7L6.6 6H4a2 2 0 0 0-2 2v8c0 1.1.9 2 2 2h2.6l3.7 3.7A1 1 0 0 0 12 21V3Zm4.3 5.3a1 1 0 0 1 1.4 0L19 9.6l1.3-1.3a1 1 0 1 1 1.4 1.4L20.4 11l1.3 1.3a1 1 0 0 1-1.4 1.4L19 12.4l-1.3 1.3a1 1 0 0 1-1.4-1.4l1.3-1.3-1.3-1.3a1 1 0 0 1 0-1.4Z";
const MIC_OFF_PATH = "M3.3 3.3a1 1 0 0 1 1.4 0l16 16a1 1 0 0 1-1.4 1.4l-3.3-3.3A7 7 0 0 1 13 18.9V21h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-2.1A7 7 0 0 1 5 12a1 1 0 1 1 2 0 5 5 0 0 0 7.6 4.3l-1.5-1.5A3 3 0 0 1 9 12v-1.6L3.3 4.7a1 1 0 0 1 0-1.4ZM15 11.2 9.3 5.5A3 3 0 0 1 15 6v5.2Zm2.9 2.9-1.5-1.5c.1-.2.1-.4.1-.6a1 1 0 1 1 2 0c0 .7-.2 1.4-.6 2.1Z";
const DEAF_PATH = "M3.3 3.3a1 1 0 0 1 1.4 0l16 16a1 1 0 0 1-1.4 1.4l-1.5-1.5A3 3 0 0 1 16 20h-1a2 2 0 0 1-2-2v-4c0-.5.2-1 .5-1.4L5.4 4.7 4.7 6A8.9 8.9 0 0 0 4 9.6V12h3a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H6a3 3 0 0 1-3-3V9.6c0-1.6.4-3.1 1.2-4.5l-.9-.4a1 1 0 0 1 0-1.4ZM12 2.6a9 9 0 0 1 9 9V17l-2-2v-3h.1v-.4a7 7 0 0 0-11.5-5.3L6.2 4.9A9 9 0 0 1 12 2.6Z";
const VIDEO_PATH = "M4 5a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1.4l3.4 2.3A1 1 0 0 0 22 16V8a1 1 0 0 0-1.6-.8L17 9.4V8a3 3 0 0 0-3-3H4Z";
const HASH_PATH = "M10.9 3.1a1 1 0 0 0-2 .3L9.5 7H6a1 1 0 0 0 0 2h3.2l-.7 6H5a1 1 0 1 0 0 2h3.3l-.5 3.9a1 1 0 0 0 2 .2l.5-4.1h6l-.5 3.9a1 1 0 0 0 2 .2l.5-4.1H21a1 1 0 1 0 0-2h-2.5l.7-6H22a1 1 0 1 0 0-2h-3.1l.5-3.9a1 1 0 0 0-2-.2l-.5 4.1h-6l.5-3.9ZM16.5 15h-6l.7-6h6l-.7 6Z";

function Icon({ path, size = 14, className }: { path: string; size?: number; className?: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={classes(cl("icon"), className)} aria-hidden>
            <path fill="currentColor" d={path} />
        </svg>
    );
}

function HeadButton({ path, label, onClick, active }: { path: string; label: string; onClick(): void; active?: boolean; }) {
    return (
        <button className={classes(cl("head-btn"), active && cl("head-btn-active"))} title={label} aria-label={label} onClick={onClick}>
            <Icon path={path} />
        </button>
    );
}

// ---------------------------------------------------------------- Helpers

function userName(userId: string, guildId: string | null) {
    const u: any = UserStore.getUser(userId);
    return (guildId && GuildMemberStore.getNick(guildId, userId)) || u?.globalName || u?.username || "Unknown";
}

function userAvatar(userId: string, size = 32) {
    const u: any = UserStore.getUser(userId);
    return u ? IconUtils.getUserAvatarURL(u, false, size) : IconUtils.getDefaultAvatarURL(userId);
}

function channelLabel(channelId: string) {
    const channel: any = ChannelStore.getChannel(channelId);
    if (!channel) return { name: "Unknown channel", icon: null as string | null, sub: "", guildId: null as string | null };
    if (channel.isDM?.()) {
        const id = channel.recipients?.[0];
        return { name: id ? userName(id, null) : "Direct Message", icon: id ? userAvatar(id) : null, sub: "", guildId: null };
    }
    if (channel.isPrivate?.()) {
        const names = (channel.recipients ?? []).map((id: string) => userName(id, null)).join(", ");
        return { name: channel.name || names || "Group", icon: IconUtils.getChannelIconURL({ id: channel.id, icon: channel.icon, size: 32 }) ?? null, sub: "", guildId: null };
    }
    const guild = GuildStore.getGuild(channel.guild_id);
    return { name: channel.name, icon: null, sub: guild?.name ?? "", guildId: channel.guild_id as string };
}

function openChannel(channelId: string, messageId?: string) {
    const guildId = ChannelStore.getChannel(channelId)?.guild_id ?? "@me";
    closePeek();
    NavigationRouter.transitionTo(`/channels/${guildId}/${channelId}${messageId ? `/${messageId}` : ""}`);
}

function joinVoice(channelId: string) {
    try {
        ChannelActions.selectVoiceChannel(channelId);
    } catch (e) {
        logger.error("Couldn't join voice channel", e);
    }
}

function PinMark({ pinned }: { pinned: boolean; }) {
    if (!pinned) return null;
    return <span className={cl("pin")} title="Pinned (Esc or click outside to close)"><Icon path={PIN_PATH} size={12} /></span>;
}

// ---------------------------------------------------------------- Chat

function ChatCard({ channelId, messageId, pinned }: { channelId: string; messageId?: string; pinned: boolean; }) {
    const info = channelLabel(channelId);
    return (
        <>
            <header className={cl("head")}>
                {info.icon
                    ? <img className={cl("head-avatar")} src={info.icon} alt="" />
                    : <Icon path={HASH_PATH} size={14} className={cl("head-hash")} />}
                <span className={cl("head-name")} title={info.name}>{info.name}</span>
                {info.sub && <span className={cl("head-sub")}>{info.sub}</span>}
                <PinMark pinned={pinned} />
                <HeadButton path={OPEN_PATH} label={messageId ? "Jump to message" : "Open channel"} onClick={() => openChannel(channelId, messageId)} />
            </header>
            <ErrorBoundary message="Messages could not be displayed.">
                <ChatPreview channelId={channelId} guildId={info.guildId} messageId={messageId} />
            </ErrorBoundary>
        </>
    );
}

// ---------------------------------------------------------------- Stream

function useStreamId(ref: StreamRef) {
    return useStateFromStores([ChannelRTCStore], () => {
        const p: any = (ChannelRTCStore.getParticipants(ref.channelId) ?? []).find((x: any) => x?.stream && x.user?.id === ref.userId);
        return (p?.streamId as string | undefined) ?? null;
    });
}

function StreamView({ stream }: { stream: StreamRef; }) {
    const inVc = useStateFromStores([SelectedChannelStore], () => inVoiceChannel(stream.channelId));
    const live = useStateFromStores([ApplicationStreamingStore], () => !!streamFor(stream.userId, stream.channelId));
    const preview = useStateFromStores([ApplicationStreamPreviewStore], () => ApplicationStreamPreviewStore.getPreviewURLForStreamKey(stream.streamKey) ?? null);
    const streamId = useStreamId(stream);
    const Video: any = MediaEngineStore.getVideoComponent?.();

    useEffect(() => {
        fetchPreview(stream);
    }, [stream.streamKey]);

    useEffect(() => {
        if (!live) return;
        acquireStream(stream);
        return () => releaseStream(stream.streamKey);
    }, [stream.streamKey, inVc, live]);

    if (!live) return <div className={cl("video")}><div className={cl("overlay")}>The stream has ended.</div></div>;

    return (
        <div className={cl("video")}>
            {preview && <img className={cl("preview")} src={preview} alt="" />}
            {inVc && streamId && Video && (
                <ErrorBoundary noop>
                    <Video streamId={streamId} fit="contain" paused={false} mirror={false} className={cl("media")} />
                </ErrorBoundary>
            )}
            {inVc && !streamId && <div className={cl("overlay")}><span className={cl("spinner")} /></div>}
            {!inVc && (
                <div className={cl("overlay")}>
                    <button className={cl("btn")} onClick={() => joinVoice(stream.channelId)}>Join &amp; watch</button>
                </div>
            )}
        </div>
    );
}

function StreamMute({ stream }: { stream: StreamRef; }) {
    const muted = useStateFromStores([MediaEngineStore], () => {
        try {
            return MediaEngineStore.isLocalMute(stream.userId, "stream" as any);
        } catch {
            return false;
        }
    });
    const inVc = useStateFromStores([SelectedChannelStore], () => inVoiceChannel(stream.channelId));
    if (!inVc) return null;
    return <HeadButton path={muted ? MUTED_PATH : SPEAKER_PATH} label={muted ? "Unmute stream" : "Mute stream"} active={muted} onClick={() => toggleStreamMute(stream.userId)} />;
}

function StreamHead({ stream, pinned, children }: { stream: StreamRef; pinned: boolean; children?: React.ReactNode; }) {
    const channel = ChannelStore.getChannel(stream.channelId);
    return (
        <header className={cl("head")}>
            <img className={cl("head-avatar")} src={userAvatar(stream.userId)} alt="" />
            <span className={cl("head-name")}>{userName(stream.userId, stream.guildId)}</span>
            <span className={cl("live")}>LIVE</span>
            {channel?.name && <span className={cl("head-sub")}>{channel.name}</span>}
            {children}
            <PinMark pinned={pinned} />
            <StreamMute stream={stream} />
        </header>
    );
}

function StreamCard({ stream, pinned }: { stream: StreamRef; pinned: boolean; }) {
    return (
        <>
            <StreamHead stream={stream} pinned={pinned} />
            <StreamView stream={stream} />
        </>
    );
}

function CallCard({ index, pinned }: { index: number; pinned: boolean; }) {
    // Comma joined keys keep the store hook's comparison stable
    const keys = useStateFromStores([ApplicationStreamingStore, SelectedChannelStore], () =>
        streamsIn(SelectedChannelStore.getVoiceChannelId()).map(s => s.streamKey).join(","));
    const streams = streamsIn(SelectedChannelStore.getVoiceChannelId());

    useEffect(() => {
        if (!keys) closePeek();
    }, [keys]);

    if (!streams.length) return null;
    const i = Math.min(index, streams.length - 1);
    const stream = streams[i];

    return (
        <>
            <StreamHead stream={stream} pinned={pinned}>
                {streams.length > 1 && (
                    <span className={cl("dots")} title="Scroll or use the arrow keys to switch">
                        {streams.map((s, n) => (
                            <button key={s.streamKey} className={classes(cl("dot"), n === i && cl("dot-active"))} aria-label={`Stream ${n + 1}`} onClick={() => setCallIndex(n)} />
                        ))}
                    </span>
                )}
            </StreamHead>
            <StreamView key={stream.streamKey} stream={stream} />
        </>
    );
}

// ---------------------------------------------------------------- Voice channel

function VoiceCard({ channelId, pinned }: { channelId: string; pinned: boolean; }) {
    const channel: any = ChannelStore.getChannel(channelId);
    const guildId: string | null = channel?.guild_id ?? null;
    const me = UserStore.getCurrentUser()?.id;
    const inVc = useStateFromStores([SelectedChannelStore], () => inVoiceChannel(channelId));

    // Serialized so the store hook only re-renders on real changes
    const raw = useStateFromStores([VoiceStateStore, ApplicationStreamingStore], () => {
        const states: Record<string, any> = VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {};
        return JSON.stringify(Object.values(states).map((s: any) => [
            s.userId,
            !!(s.selfMute || s.mute || s.suppress),
            !!(s.selfDeaf || s.deaf),
            !!s.selfVideo,
            !!streamFor(s.userId, channelId)
        ]));
    });
    const people: [string, boolean, boolean, boolean, boolean][] = JSON.parse(raw);
    people.sort((a, b) => Number(b[4]) - Number(a[4]) || userName(a[0], guildId).localeCompare(userName(b[0], guildId)));

    const watch = (userId: string) => {
        const t = streamFor(userId, channelId);
        if (t && settings.store.streams) switchTo({ target: t, anchor: null });
    };

    return (
        <>
            <header className={cl("head")}>
                <Icon path={SPEAKER_PATH} size={14} className={cl("head-hash")} />
                <span className={cl("head-name")}>{channel?.name ?? "Voice channel"}</span>
                <span className={cl("head-sub")}>{people.length}</span>
                <PinMark pinned={pinned} />
                {!inVc && <button className={cl("btn")} onClick={() => joinVoice(channelId)}>Join</button>}
            </header>
            <div className={cl("voice-list")}>
                {!people.length && <div className={cl("muted-line")}>Nobody is here.</div>}
                {people.map(([userId, muted, deaf, video, live]) => (
                    <div
                        key={userId}
                        className={classes(cl("voice-row"), live && userId !== me && cl("voice-row-live"))}
                        onClick={live && userId !== me ? () => watch(userId) : undefined}
                        title={live && userId !== me ? "Show stream" : undefined}
                    >
                        <img className={cl("voice-avatar")} src={userAvatar(userId, 32)} alt="" />
                        <span className={cl("voice-name")}>{userName(userId, guildId)}</span>
                        {live && <span className={cl("live")}>LIVE</span>}
                        {video && <Icon path={VIDEO_PATH} size={13} className={cl("voice-icon")} />}
                        {muted && <Icon path={MIC_OFF_PATH} size={13} className={cl("voice-icon")} />}
                        {deaf && <Icon path={DEAF_PATH} size={13} className={cl("voice-icon")} />}
                    </div>
                ))}
            </div>
        </>
    );
}

// ---------------------------------------------------------------- Card & placement

const MARGIN = 8;

const CALL_MIN_W = 240;
const CALL_MAX_W = 1200;

function placeCard(card: HTMLElement, rect: DOMRect | null) {
    const W = window.innerWidth, H = window.innerHeight;
    // The call preview remembers where the user dragged it and how wide they made it
    const saved = !rect ? settings.store.callBox : null;
    if (saved) card.style.width = `${Math.max(CALL_MIN_W, Math.min(saved.width, W - 2 * MARGIN))}px`;

    const w = card.offsetWidth, h = card.offsetHeight;
    let left: number, top: number;

    if (saved) {
        left = saved.left;
        top = saved.top;
    } else if (!rect) {
        // Call peek: bottom right, above the chat input
        const box = document.querySelector('[class*="channelTextArea_"]')?.getBoundingClientRect();
        if (box?.width) {
            left = box.right - w;
            top = box.top - h - MARGIN;
        } else {
            left = W - w - 16;
            top = H - h - 90;
        }
    } else if (rect.right + MARGIN + w <= W - MARGIN) {
        left = rect.right + MARGIN;
        top = rect.top - 6;
    } else if (rect.left - MARGIN - w >= MARGIN) {
        left = rect.left - MARGIN - w;
        top = rect.top - 6;
    } else {
        left = rect.left;
        top = rect.bottom + MARGIN + h <= H - MARGIN ? rect.bottom + MARGIN : rect.top - MARGIN - h;
    }

    left = Math.max(MARGIN, Math.min(left, W - w - MARGIN));
    top = Math.max(MARGIN, Math.min(top, H - h - MARGIN));
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
    card.style.visibility = "visible";
}

function CardBody({ target, pinned, callIndex }: { target: Target; pinned: boolean; callIndex: number; }) {
    switch (target.kind) {
        case "chat": return <ChatCard channelId={target.channelId} messageId={target.messageId} pinned={pinned} />;
        case "stream": return <StreamCard stream={target} pinned={pinned} />;
        case "voice": return <VoiceCard channelId={target.channelId} pinned={pinned} />;
        case "call": return <CallCard index={callIndex} pinned={pinned} />;
    }
}

/** Drag the call preview by its header or resize it by the corner; the result is saved for next time */
function startCallDrag(e: React.MouseEvent<HTMLDivElement>, mode: "move" | "resize") {
    const card = e.currentTarget.closest<HTMLElement>(`.${cl("card")}`);
    if (!card || e.button !== 0) return;
    if (mode === "move" && (e.target as HTMLElement).closest("button, a, input")) return;
    e.preventDefault();

    const start = card.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    card.classList.add(cl("dragging"));

    const onMove = (ev: MouseEvent) => {
        const W = window.innerWidth, H = window.innerHeight;
        if (mode === "move") {
            const left = Math.max(MARGIN, Math.min(start.left + ev.clientX - sx, W - start.width - MARGIN));
            const top = Math.max(MARGIN, Math.min(start.top + ev.clientY - sy, H - card.offsetHeight - MARGIN));
            card.style.left = `${Math.round(left)}px`;
            card.style.top = `${Math.round(top)}px`;
        } else {
            const max = Math.min(CALL_MAX_W, W - start.left - MARGIN);
            card.style.width = `${Math.round(Math.max(CALL_MIN_W, Math.min(start.width + ev.clientX - sx, max)))}px`;
        }
    };
    const onUp = () => {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        card.classList.remove(cl("dragging"));
        const box = card.getBoundingClientRect();
        settings.store.callBox = { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width) };
    };
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
}

function Card({ state }: { state: PeekState; }) {
    const ref = useRef<HTMLDivElement>(null);
    const { hit, rect, pinned, callIndex } = state;
    const { kind } = hit!.target;
    const isCall = kind === "call";

    useLayoutEffect(() => {
        const card = ref.current;
        if (!card) return;
        placeCard(card, rect);
        // While the user drags/resizes, the card follows the mouse instead of being re-placed
        const ro = new ResizeObserver(() => !card.classList.contains(cl("dragging")) && placeCard(card, rect));
        ro.observe(card);
        return () => ro.disconnect();
    }, [rect]);

    return (
        <div
            ref={ref}
            className={classes(cl("card"), cl(`card-${kind}`), pinned && cl("card-pinned"))}
            style={{ visibility: "hidden" }}
            onMouseDown={isCall ? e => (e.target as HTMLElement).closest(`.${cl("head")}`) && startCallDrag(e, "move") : undefined}
        >
            <ErrorBoundary message="Preview could not be displayed.">
                <CardBody target={hit!.target} pinned={pinned} callIndex={callIndex} />
            </ErrorBoundary>
            {isCall && (
                <div
                    className={cl("resize")}
                    title="Drag to resize"
                    onMouseDown={e => { e.stopPropagation(); startCallDrag(e, "resize"); }}
                />
            )}
        </div>
    );
}

function PeekRoot() {
    const [state, setState] = useState(getState);
    useEffect(() => subscribe(() => setState(getState())), []);
    if (!state.hit) return null;
    // A new target remounts the card (fresh animation & placement)
    return <Card key={targetKey(state.hit.target)} state={state} />;
}

// ---------------------------------------------------------------- Mounting

let host: HTMLDivElement | null = null;
let root: Root | null = null;

export function mountRoot() {
    if (root) return;
    host = document.createElement("div");
    host.className = "vc-peek-root";
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(
        <ErrorBoundary noop>
            <PeekRoot />
        </ErrorBoundary>
    );
}

export function unmountRoot() {
    root?.unmount();
    root = null;
    host?.remove();
    host = null;
}

// ---------------------------------------------------------------- Settings

const KEY_OPTIONS = [
    ["alt", "Alt"],
    ["ctrl", "Ctrl"],
    ["shift", "Shift"],
    ["custom", "Custom"]
] as const;

const TARGETS = [
    ["channels", "Channels, threads & DMs in the sidebar"],
    ["messageLinks", "Message links in chat"],
    ["streams", "Streaming users in voice channels"],
    ["voiceChannels", "Voice channels (who is in there)"],
    ["callStreams", "Streams in your current call (nothing hovered)"]
] as const;

function KeyRecorder() {
    const { customKey } = settings.use(["customKey"]);
    const [recording, setRecording] = useState(false);

    useEffect(() => {
        if (!recording) return;
        const onKey = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.key !== "Escape") settings.store.customKey = e.code;
            setRecording(false);
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [recording]);

    return (
        <button className={classes(cl("btn"), recording && cl("btn-active"))} onClick={() => setRecording(r => !r)}>
            {recording ? "Press a key …" : customKey || "Record key"}
        </button>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(() => {
    const s = settings.use(["key", "holdDelay", "keepStreamSeconds", "muteStream", "callBox", ...TARGETS.map(([k]) => k)]);

    const number = (key: "holdDelay" | "keepStreamSeconds", min: number, max: number) => (
        <input
            className={cl("number")}
            type="number"
            min={min}
            max={max}
            value={s[key]}
            onChange={e => settings.store[key] = Math.max(min, Math.min(max, Math.round(Number(e.currentTarget.value) || 0)))}
        />
    );

    return (
        <div className={cl("settings")}>
            <div className={cl("option")}>
                <span>Hold this key to peek</span>
                <span className={cl("option-right")}>
                    <span className={cl("segmented")} role="radiogroup" aria-label="Hold key">
                        {KEY_OPTIONS.map(([v, label]) => (
                            <button
                                key={v}
                                role="radio"
                                aria-checked={s.key === v}
                                className={classes(cl("segment"), s.key === v && cl("segment-active"))}
                                onClick={() => settings.store.key = v}
                            >
                                {label}
                            </button>
                        ))}
                    </span>
                    {s.key === "custom" && <KeyRecorder />}
                </span>
            </div>
            <div className={cl("option")}>
                <span>Hold delay (ms)</span>
                {number("holdDelay", 0, 2000)}
            </div>
            <div className={cl("option")}>
                <span>Keep stream connected after a peek (seconds)</span>
                {number("keepStreamSeconds", 0, 600)}
            </div>
            <label className={cl("option")}>
                <span>Mute the audio of peeked streams</span>
                <Switch checked={s.muteStream} onChange={v => settings.store.muteStream = v} />
            </label>
            <div className={cl("option")}>
                <span>Call stream preview position & size</span>
                <button className={cl("small-btn")} disabled={!s.callBox} onClick={() => settings.store.callBox = null}>
                    {s.callBox ? "Reset" : "Default"}
                </button>
            </div>

            <div className={cl("label")}>Peek at</div>
            {TARGETS.map(([key, label]) => (
                <label key={key} className={cl("option")}>
                    <span>{label}</span>
                    <Switch checked={s[key]} onChange={v => settings.store[key] = v} />
                </label>
            ))}

            <div className={cl("hint")}>
                Click into a preview to pin it, Esc or a click outside closes it. Peeking never marks anything as read.
            </div>
        </div>
    );
}, { noop: true });
