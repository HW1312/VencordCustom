/*
 * ChatPopout – contents of a window: title bar, call bar, message list and input
 * Runs in the same process as the main window but is rendered into the popout window's document.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory, vencordRootNode } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { sendMessage } from "@utils/discord";
import { classes } from "@utils/misc";
import {
    ChannelStore, GuildChannelStore, GuildMemberStore, GuildStore, IconUtils, NavigationRouter, Parser, PermissionsBits, PermissionStore, PopoutActions, PopoutWindowStore,
    PrivateChannelSortStore, ReadStateStore, SelectedChannelStore, showToast, Toasts, TypingStore, useEffect, useLayoutEffect, useMemo, useRef, UserGuildSettingsStore, UserStore,
    useState, useStateFromStores, VoiceStateStore
} from "@webpack/common";

import { getCommands, matchCommands, OptionType, PopoutCommand } from "./commands";
import { isInCall, logger, openCallPopout, settings } from "./index";
import { RawMessage, useChannelMessages } from "./messages";

const cl = classNameFactory("vc-chatpopout-");

// ---------------------------------------------------------------- Icons

export const POPOUT_PATH = "M14 3a1 1 0 1 0 0 2h3.6l-7.3 7.3a1 1 0 0 0 1.4 1.4L19 6.4V10a1 1 0 1 0 2 0V4a1 1 0 0 0-1-1h-6ZM5 5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 1 0-2 0v5H5V7h5a1 1 0 1 0 0-2H5Z";
const CLOSE_PATH = "M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 0 0-1.4 1.4l4.9 4.9-4.9 4.9a1 1 0 1 0 1.4 1.4l4.9-4.9 4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z";
const MIN_PATH = "M5 12a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z";
const MAX_PATH = "M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v12h12V6H6Z";
const PIN_PATH = "M16 3a1 1 0 0 1 .7 1.7L16 5.4v4.2l2.7 2.7a1 1 0 0 1-.7 1.7h-5v6a1 1 0 1 1-2 0v-6H6a1 1 0 0 1-.7-1.7L8 9.6V5.4l-.7-.7A1 1 0 0 1 8 3h8Z";
const MAIN_PATH = "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 4v10h5V8H4Zm7 0v10h9V8h-9Z";
const CALL_PATH = "M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-5v2h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2H6a2 2 0 0 1-2-2V5Zm7.2 3.1a.6.6 0 0 0-.9.5v3.8a.6.6 0 0 0 .9.5l3-1.9a.6.6 0 0 0 0-1l-3-1.9Z";
const FILE_PATH = "M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.4a2 2 0 0 0-.6-1.4l-4.4-4.4A2 2 0 0 0 13.6 2H6Zm7 1.8L18.2 9H14a1 1 0 0 1-1-1V3.8Z";
const MUTE_PATH = "M3.3 3.3a1 1 0 0 1 1.4 0l16 16a1 1 0 0 1-1.4 1.4l-3.4-3.4A7 7 0 0 1 13 18.9V21a1 1 0 1 1-2 0v-2.1A7 7 0 0 1 5 12a1 1 0 1 1 2 0 5 5 0 0 0 7.5 4.3l-1.6-1.6A3 3 0 0 1 9 12V10.4L3.3 4.7a1 1 0 0 1 0-1.4ZM12 2a3 3 0 0 1 3 3v5.2l-6-6A3 3 0 0 1 12 2Zm6.6 12.4-1.6-1.6c.1-.3.1-.5.1-.8a1 1 0 1 1 2 0c0 .8-.2 1.6-.5 2.4Z";
const SIDEBAR_PATH = "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm6 0v14h10V5H9Zm-2 0H5v14h2V5Z";
const HASH_PATH = "M10.99 3.16A1 1 0 1 0 9 2.84L8.15 8H4a1 1 0 0 0 0 2h3.82l-.67 4H3a1 1 0 1 0 0 2h3.82l-.8 4.84a1 1 0 0 0 1.97.32L8.85 16h4.97l-.8 4.84a1 1 0 0 0 1.97.32l.86-5.16H20a1 1 0 1 0 0-2h-3.82l.67-4H21a1 1 0 1 0 0-2h-3.82l.8-4.84a1 1 0 1 0-1.97-.32L15.15 8h-4.97l.8-4.84ZM14.15 14l.67-4H9.85l-.67 4h4.97Z";
const SPEAKER_PATH = "M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM15.1 20.75c-.58.14-1.1-.33-1.1-.92v-.03c0-.5.37-.92.85-1.05a7 7 0 0 0 0-13.5A1.11 1.11 0 0 1 14 4.2v-.03c0-.6.52-1.06 1.1-.92a9 9 0 0 1 0 17.5ZM15.16 16.51c-.57.28-1.16-.2-1.16-.83v-.14c0-.43.28-.8.63-1.02a3 3 0 0 0 0-5.04c-.35-.23-.63-.6-.63-1.02v-.14c0-.63.59-1.1 1.16-.83a5 5 0 0 1 0 9.02Z";
const ANNOUNCE_PATH = "M19.56 2a3 3 0 0 0-2.46 1.28 3.85 3.85 0 0 1-1.86 1.42l-8.9 3.18a.5.5 0 0 0-.34.47v10.09a3 3 0 0 0 2.27 2.9l.62.16c1.57.4 3.15-.56 3.55-2.12l.92-3.68a.5.5 0 0 1 .65-.35l2.7.96a3.85 3.85 0 0 1 1.86 1.42 3 3 0 0 0 5.43-1.75V5A3 3 0 0 0 19.56 2ZM4 9a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h.5a.5.5 0 0 0 .5-.5v-6a.5.5 0 0 0-.5-.5H4Z";
const CHEVRON_PATH = "M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42Z";
const DEAF_PATH = "M3.3 3.3a1 1 0 0 1 1.4 0l16 16a1 1 0 0 1-1.4 1.4l-1.5-1.5A2 2 0 0 1 17 20h-1a2 2 0 0 1-2-2v-3.6L6.5 6.9A7 7 0 0 0 5 11v1h2a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H6a3 3 0 0 1-3-3v-8c0-1.8.6-3.5 1.6-4.9l-1.3-1.4a1 1 0 0 1 0-1.4ZM12 3a9 9 0 0 1 9 9v5.2l-2-2V12a7 7 0 0 0-11.6-5.3L6 5.3A9 9 0 0 1 12 3Z";

export function Icon({ path, size = 18, className }: { path: string; size?: number; className?: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden>
            <path fill="currentColor" d={path} />
        </svg>
    );
}

/**
 * Tooltip in the popout window. Discord's own tooltip would appear in the main window,
 * so this is a pure CSS recreation with Discord's colors, font and arrow.
 */
function tip(text: string, pos: "top" | "bottom" = "top", align: "center" | "start" | "end" = "center") {
    return { "data-tip": text, "data-tip-pos": pos, "data-tip-align": align };
}

function IconButton({ path, label, onClick, active, danger, disabled }: {
    path: string; label: string; onClick(): void; active?: boolean; danger?: boolean; disabled?: boolean;
}) {
    return (
        <button
            className={classes(cl("icon-btn"), active && cl("icon-btn-active"), danger && cl("icon-btn-danger"))}
            {...tip(label, "bottom", "end")}
            aria-label={label}
            aria-pressed={active}
            disabled={disabled}
            onClick={onClick}
        >
            <Icon path={path} size={16} />
        </button>
    );
}

// ---------------------------------------------------------------- Helpers

const CDN = "https://cdn.discordapp.com";
const GROUP_MS = 7 * 60 * 1000;
const LOCALE = "en-US";
const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

/** Normal messages (text, reply, commands) – everything else is a system message */
const NORMAL_TYPES = new Set([0, 19, 20, 23]);

const SYSTEM_TEXT: Record<number, string> = {
    1: "added someone to the group.",
    2: "removed someone from the group.",
    3: "started a call.",
    4: "changed the name.",
    5: "changed the icon.",
    6: "pinned a message.",
    7: "joined the server.",
    8: "boosted the server!",
    9: "boosted the server – Level 1!",
    10: "boosted the server – Level 2!",
    11: "boosted the server – Level 3!",
    12: "is now following this channel.",
    18: "started a thread.",
    24: "AutoMod flagged a message."
};

function channelPath(channelId: string, guildId?: string | null, messageId?: string) {
    return `/channels/${guildId ?? "@me"}/${channelId}${messageId ? `/${messageId}` : ""}`;
}

function openInMain(channelId: string, guildId?: string | null, messageId?: string) {
    NavigationRouter.transitionTo(channelPath(channelId, guildId, messageId));
    window.focus();
}

function formatFull(d: Date) {
    const now = new Date();
    const time = d.toLocaleTimeString(LOCALE, TIME);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return `Today at ${time}`;
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`;
    return `${d.toLocaleDateString(LOCALE)} ${time}`;
}

const formatDay = (d: Date) => d.toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

function sized(url: string, w: number, h: number) {
    return `${url}${url.includes("?") ? "&" : "?"}width=${Math.round(w)}&height=${Math.round(h)}`;
}

function fitBox(w?: number, h?: number, maxW = 300, maxH = 240) {
    if (!w || !h) return { width: undefined, height: undefined };
    const s = Math.min(1, maxW / w, maxH / h);
    return { width: Math.round(w * s), height: Math.round(h * s) };
}

function formatSize(bytes?: number) {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function userAvatar(id: string, author?: any, size = 80) {
    const user = UserStore.getUser(id);
    if (user && !author?.bot) return IconUtils.getUserAvatarURL(user, false, size) as string;
    if (author?.avatar) return `${CDN}/avatars/${id}/${author.avatar}.webp?size=${size}`;
    return IconUtils.getDefaultAvatarURL(id, author?.discriminator) as string;
}

function authorInfo(author: any, guildId: string | null) {
    const id: string = author?.id ?? "0";
    const member = guildId ? GuildMemberStore.getMember(guildId, id) : null;
    const name: string = member?.nick || author?.global_name || author?.globalName || author?.username || "Unknown";
    return { id, name, color: member?.colorString ?? undefined, avatar: userAvatar(id, author) };
}

function displayName(id: string, guildId: string | null) {
    const u: any = UserStore.getUser(id);
    return (guildId && GuildMemberStore.getNick(guildId, id)) || u?.globalName || u?.username || "Someone";
}

/** Name, icon and subtitle of a channel */
function useChannelInfo(channelId: string) {
    const channel = useStateFromStores([ChannelStore], () => ChannelStore.getChannel(channelId));
    const guild = useStateFromStores([GuildStore], () => channel?.guild_id ? GuildStore.getGuild(channel.guild_id) : null);
    const recipientKey = useStateFromStores([UserStore], () => (channel?.recipients ?? []).filter((id: string) => UserStore.getUser(id)).join(","));

    return useMemo(() => {
        const recipients = recipientKey ? recipientKey.split(",").map(id => UserStore.getUser(id)) : [];
        if (!channel) return { channel, name: "Unknown Channel", subtitle: "", icon: null as string | null, prefix: "" };

        if (channel.isDM?.() && recipients[0]) {
            const u: any = recipients[0];
            return { channel, name: u.globalName || u.username, subtitle: "Direct Message", icon: IconUtils.getUserAvatarURL(u, false, 64) as string | null, prefix: "@" };
        }
        if (channel.isPrivate?.()) {
            const names = recipients.map((u: any) => u.globalName || u.username).join(", ");
            return { channel, name: channel.name || names || "Group", subtitle: "Group DM", icon: IconUtils.getChannelIconURL({ id: channel.id, icon: channel.icon, size: 64 }) ?? null, prefix: "" };
        }
        const voice = channel.isGuildVoice?.() || channel.isGuildStageVoice?.();
        return {
            channel,
            name: channel.name,
            subtitle: [guild?.name, voice ? "Voice-Chat" : null].filter(Boolean).join(" · "),
            icon: guild?.icon ? IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, size: 64 }) ?? null : null,
            prefix: voice || channel.isThread?.() ? "" : "#"
        };
    }, [channel, guild, recipientKey]);
}

/** Window context: document (for scrolling/lookup) and image preview */
interface WindowCtx {
    doc: () => Document;
    zoom(url: string): void;
}

// ---------------------------------------------------------------- Message parts

function Markdown({ content, channelId, messageId }: { content: string; channelId: string; messageId: string; }) {
    const nodes = useMemo(() => {
        try {
            return Parser.parse(content, true, { channelId, messageId, allowLinks: true, allowHeading: true, allowList: true, allowEmojiLinks: true, viewingChannelId: channelId });
        } catch (e) {
            logger.error("Couldn't render markdown", e);
            return content;
        }
    }, [content, channelId, messageId]);

    return <ErrorBoundary noop fallback={() => <span>{content}</span>}>{nodes}</ErrorBoundary>;
}

/** Image that falls back to the original URL if the media proxy fails */
function FallbackImg({ src, fallback, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fallback?: string; }) {
    const [failed, setFailed] = useState(false);
    const url = failed && fallback ? fallback : src;
    return <img {...props} src={url} loading="lazy" onError={() => !failed && fallback && fallback !== src && setFailed(true)} />;
}

/** Autoplaying, muted, looping video like Discord's GIF player */
function GifVideo({ src, fallback, poster, width, height }: { src: string; fallback?: string; poster?: string; width?: number; height?: number; }) {
    const [failed, setFailed] = useState(false);
    return (
        <video
            className={cl("image")}
            src={failed && fallback ? fallback : src}
            poster={poster}
            width={width}
            height={height}
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            onError={() => !failed && fallback && fallback !== src && setFailed(true)}
        />
    );
}

function Attachment({ a, ctx }: { a: any; ctx: WindowCtx; }) {
    const type: string = a.content_type ?? "";
    const isImage = type.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif)$/i.test(a.filename ?? "");
    const isVideo = type.startsWith("video/");
    const box = fitBox(a.width, a.height);

    if (isImage && a.url) {
        // Resizing through the media proxy breaks (large) animated GIFs – load those unscaled
        const isGif = type === "image/gif" || /\.gif$/i.test(a.filename ?? "");
        const src = a.proxy_url && box.width && !isGif ? sized(a.proxy_url, box.width * 2, box.height! * 2) : (a.proxy_url ?? a.url);
        return <FallbackImg className={cl("image")} src={src} fallback={a.url} alt={a.filename} width={box.width} height={box.height} onClick={() => ctx.zoom(a.proxy_url ?? a.url)} />;
    }
    if (isVideo && a.url) {
        return <video className={cl("image")} src={a.proxy_url ?? a.url} controls preload="metadata" width={box.width} height={box.height} />;
    }
    return (
        <a className={cl("file")} href={a.url} target="_blank" rel="noreferrer noopener">
            <Icon path={FILE_PATH} size={22} />
            <span className={cl("file-name")}>{a.filename}</span>
            <span className={cl("file-size")}>{formatSize(a.size)}</span>
        </a>
    );
}

function Embed({ e, channelId, messageId, ctx }: { e: any; channelId: string; messageId: string; ctx: WindowCtx; }) {
    const thumb = e.thumbnail ?? null;
    const image = e.image ?? null;

    // Tenor/Giphy GIFs are really looping MP4 videos – the thumbnail is only a still frame
    if (e.type === "gifv" && e.video) {
        const box = fitBox(e.video.width ?? thumb?.width, e.video.height ?? thumb?.height);
        return <GifVideo src={e.video.proxy_url ?? e.video.url} fallback={e.video.url} poster={thumb?.proxy_url ?? thumb?.url} width={box.width} height={box.height} />;
    }
    if ((e.type === "image" || e.type === "gifv") && (thumb || image)) {
        const img = thumb ?? image;
        const box = fitBox(img.width, img.height);
        return <FallbackImg className={cl("image")} src={img.proxy_url ?? img.url} fallback={img.url} width={box.width} height={box.height} alt="" onClick={() => ctx.zoom(img.proxy_url ?? img.url)} />;
    }
    if (!e.title && !e.description && !e.author?.name && !image && !thumb) return null;

    const color = typeof e.color === "number" ? `#${e.color.toString(16).padStart(6, "0")}` : undefined;
    const imgBox = image ? fitBox(image.width, image.height, 280, 200) : null;

    return (
        <div className={cl("embed")} style={color ? { borderLeftColor: color } : undefined}>
            <div className={cl("embed-body")}>
                {e.provider?.name && <div className={cl("embed-provider")}>{e.provider.name}</div>}
                {e.author?.name && <div className={cl("embed-author")}>{e.author.name}</div>}
                {e.title && (e.url
                    ? <a className={cl("embed-title")} href={e.url} target="_blank" rel="noreferrer noopener">{e.title}</a>
                    : <div className={cl("embed-title")}>{e.title}</div>)}
                {e.description && <div className={cl("embed-desc")}><Markdown content={e.description} channelId={channelId} messageId={messageId} /></div>}
                {image && <img className={cl("embed-image")} src={image.proxy_url ?? image.url} width={imgBox?.width} height={imgBox?.height} loading="lazy" alt="" onClick={() => ctx.zoom(image.proxy_url ?? image.url)} />}
            </div>
            {thumb && !image && <img className={cl("embed-thumb")} src={thumb.proxy_url ?? thumb.url} loading="lazy" alt="" />}
        </div>
    );
}

function Reactions({ reactions }: { reactions: RawMessage["reactions"]; }) {
    if (!reactions?.length) return null;
    return (
        <div className={cl("reactions")}>
            {reactions.map(r => (
                <span key={r.emoji.id ?? r.emoji.name} className={classes(cl("reaction"), r.me && cl("reaction-me"))} {...tip(`:${r.emoji.name}:`)}>
                    {r.emoji.id
                        ? <img src={`${CDN}/emojis/${r.emoji.id}.${r.emoji.animated ? "gif" : "webp"}?size=32`} alt={r.emoji.name} />
                        : <span className={cl("reaction-emoji")}>{r.emoji.name}</span>}
                    <span>{r.count}</span>
                </span>
            ))}
        </div>
    );
}

function Stickers({ items }: { items: RawMessage["sticker_items"]; }) {
    if (!items?.length) return null;
    return (
        <div className={cl("stickers")}>
            {items.map(s => s.format_type === 3
                ? <span key={s.id} className={cl("muted")}>[Sticker: {s.name}]</span>
                : <img key={s.id} className={cl("sticker")} alt={s.name} src={`https://media.discordapp.net/stickers/${s.id}.${s.format_type === 4 ? "gif" : "webp"}?size=160`} />
            )}
        </div>
    );
}

function ReplyLine({ m, guildId, ctx }: { m: RawMessage; guildId: string | null; ctx: WindowCtx; }) {
    const ref = m.referenced_message;
    if (!ref) return <div className={cl("reply")}><span className={cl("muted")}>Original message was deleted</span></div>;

    const a = authorInfo(ref.author, guildId);
    const preview = (ref.content || (ref.attachments?.length ? "Click to see attachment" : ref.embeds?.length ? "Embed" : "")).replace(/\s+/g, " ");

    const jump = () => {
        const el = ctx.doc().getElementById(`vc-chatpopout-msg-${ref.id}`);
        if (!el) return openInMain(m.channel_id, guildId, ref.id);
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.remove(cl("flash"));
        void el.offsetWidth;
        el.classList.add(cl("flash"));
    };

    return (
        <div className={cl("reply")} onClick={jump}>
            <img className={cl("reply-avatar")} src={a.avatar} alt="" />
            <span className={cl("reply-name")} style={{ color: a.color }}>{a.name}</span>
            <span className={cl("reply-text")}>{preview.length > 120 ? preview.slice(0, 120) + "…" : preview}</span>
        </div>
    );
}

// ---------------------------------------------------------------- Message

function Message({ m, guildId, grouped, meId, ctx }: { m: RawMessage; guildId: string | null; grouped: boolean; meId?: string; ctx: WindowCtx; }) {
    const a = authorInfo(m.author, guildId);
    const date = new Date(m.timestamp);
    const isSystem = !NORMAL_TYPES.has(m.type);
    const mentioned = !!meId && (m.mention_everyone || m.mentions?.some((u: any) => u?.id === meId));
    const command = (m as any).interaction_metadata?.name ?? (m as any).interaction?.name;
    const jump = () => openInMain(m.channel_id, guildId, m.id);
    // Like Discord: a message that is only a GIF link shows just the GIF
    const onlyGif = !!m.content && m.embeds?.length === 1 && m.embeds[0].type === "gifv" && m.content.trim() === m.embeds[0].url;

    const time = (
        <span className={cl("time")} {...tip(`${date.toLocaleString(LOCALE)} · show in main window`)} onClick={jump}>
            {grouped ? date.toLocaleTimeString(LOCALE, TIME) : formatFull(date)}
        </span>
    );

    if (isSystem) {
        return (
            <div id={`vc-chatpopout-msg-${m.id}`} className={classes(cl("message"), cl("system"))}>
                <div className={cl("row")}>
                    <div className={cl("gutter")}>→</div>
                    <div className={cl("body")}>
                        <span className={cl("name")} style={{ color: a.color }}>{a.name}</span>{" "}
                        <span className={cl("muted")}>{SYSTEM_TEXT[m.type] ?? "System message"}</span>{" "}
                        {time}
                        {m.content && m.type !== 7 && <div className={cl("content")}><Markdown content={m.content} channelId={m.channel_id} messageId={m.id} /></div>}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div
            id={`vc-chatpopout-msg-${m.id}`}
            className={classes(cl("message"), !grouped && cl("group-start"), mentioned && cl("mentioned"), m._pending && cl("pending"), m._failed && cl("failed"))}
        >
            {m.type === 19 && <ReplyLine m={m} guildId={guildId} ctx={ctx} />}
            {command && <div className={cl("reply")}><span className={cl("muted")}>{a.name} used</span> <span className={cl("command")}>/{command}</span></div>}
            <div className={cl("row")}>
                <div className={cl("gutter")}>
                    {grouped
                        ? <span className={cl("gutter-time")} onClick={jump} {...tip("Show in main window", "top", "start")}>{date.toLocaleTimeString(LOCALE, TIME)}</span>
                        : <img className={cl("avatar")} src={a.avatar} alt="" />}
                </div>
                <div className={cl("body")}>
                    {!grouped && (
                        <div className={cl("meta")}>
                            <span className={cl("name")} style={{ color: a.color }}>{a.name}</span>
                            {m.author?.bot && <span className={cl("bot-tag")}>{m.author?.discriminator === "0000" ? "WEBHOOK" : "APP"}</span>}
                            {time}
                        </div>
                    )}
                    {m.content && !onlyGif && (
                        <div className={cl("content")}>
                            <Markdown content={m.content} channelId={m.channel_id} messageId={m.id} />
                            {m.edited_timestamp && <span className={cl("edited")}> (edited)</span>}
                        </div>
                    )}
                    {!!m.attachments?.length && (
                        <div className={cl("attachments")}>
                            {m.attachments.map(att => <Attachment key={att.id ?? att.url} a={att} ctx={ctx} />)}
                        </div>
                    )}
                    <Stickers items={m.sticker_items} />
                    {m.embeds?.map((e, i) => <Embed key={i} e={e} channelId={m.channel_id} messageId={m.id} ctx={ctx} />)}
                    <Reactions reactions={m.reactions} />
                    {m._failed && <div className={cl("error-text")}>Failed to send</div>}
                </div>
            </div>
        </div>
    );
}

function canGroup(prev: RawMessage | undefined, m: RawMessage) {
    if (!prev || !NORMAL_TYPES.has(m.type) || !NORMAL_TYPES.has(prev.type)) return false;
    if (m.type === 19 || m.type === 20 || m.type === 23) return false;
    if (prev.author?.id !== m.author?.id) return false;
    const a = new Date(prev.timestamp), b = new Date(m.timestamp);
    return b.getTime() - a.getTime() < GROUP_MS && sameDay(a, b);
}

// ---------------------------------------------------------------- Message list

function MessageList({ channelId, guildId, ctx }: { channelId: string; guildId: string | null; ctx: WindowCtx; }) {
    const { messages, loading, loadingOlder, hasMore, error, newCount, loadOlder, reload } = useChannelMessages(channelId);
    const meId = UserStore.getCurrentUser()?.id;

    const scrollRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const atBottom = useRef(true);
    const olderAnchor = useRef<{ height: number; top: number; } | null>(null);
    const seenCount = useRef(newCount);
    const [unseen, setUnseen] = useState(0);

    const requestOlder = () => {
        const el = scrollRef.current;
        if (!el || loading || loadingOlder || !hasMore || !messages.length) return;
        olderAnchor.current = { height: el.scrollHeight, top: el.scrollTop };
        loadOlder();
    };

    const onScroll = () => {
        const el = scrollRef.current;
        if (!el) return;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        if (atBottom.current && unseen) setUnseen(0);
        if (el.scrollTop < 80) requestOlder();
    };

    const scrollToBottom = () => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        atBottom.current = true;
        setUnseen(0);
    };

    // Keep position after loading older messages, otherwise stick to the bottom
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        if (olderAnchor.current) {
            el.scrollTop = el.scrollHeight - olderAnchor.current.height + olderAnchor.current.top;
            olderAnchor.current = null;
        } else if (atBottom.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [messages]);

    useEffect(() => {
        if (!loadingOlder) olderAnchor.current = null;
    }, [loadingOlder]);

    useEffect(() => {
        const diff = newCount - seenCount.current;
        seenCount.current = newCount;
        if (diff > 0 && !atBottom.current) setUnseen(u => u + diff);
    }, [newCount]);

    // Late-loading images/embeds: stay at the bottom if we were there
    useEffect(() => {
        const content = contentRef.current;
        if (!content) return;
        const ro = new ResizeObserver(() => {
            const el = scrollRef.current;
            if (el && atBottom.current) el.scrollTop = el.scrollHeight;
        });
        ro.observe(content);
        return () => ro.disconnect();
    }, []);

    const rows: React.ReactElement[] = [];
    let prev: RawMessage | undefined;
    for (const m of messages) {
        const d = new Date(m.timestamp);
        const newDay = !prev || !sameDay(new Date(prev.timestamp), d);
        if (newDay) rows.push(<div key={`day-${m.id}`} className={cl("day")}><span>{formatDay(d)}</span></div>);
        rows.push(
            <ErrorBoundary key={m.id} noop>
                <Message m={m} guildId={guildId} grouped={!newDay && canGroup(prev, m)} meId={meId} ctx={ctx} />
            </ErrorBoundary>
        );
        prev = m;
    }

    return (
        <div className={cl("list-wrap")}>
            <div className={cl("list")} ref={scrollRef} onScroll={onScroll}>
                <div ref={contentRef} className={cl("list-content")}>
                    {!loading && !error && (hasMore
                        ? <button className={cl("load-older")} onClick={requestOlder} disabled={loadingOlder}>{loadingOlder ? "Loading…" : "Load older messages"}</button>
                        : <div className={cl("list-start")}>Beginning of the chat</div>)}
                    {rows}
                </div>
                {loading && <div className={cl("center")}>Loading messages…</div>}
                {error && (
                    <div className={cl("center")}>
                        <div className={cl("error-text")}>{error}</div>
                        <button className={cl("button")} onClick={reload}>Try again</button>
                    </div>
                )}
            </div>
            {unseen > 0 && (
                <button className={cl("new-pill")} onClick={scrollToBottom}>
                    {unseen === 1 ? "1 new message" : `${unseen} new messages`} ↓
                </button>
            )}
        </div>
    );
}

// ---------------------------------------------------------------- Input

const drafts = new Map<string, string>();
const lastSent = new Map<string, number>();

function useCanSend(channel: any) {
    return useStateFromStores([PermissionStore], () => {
        if (!channel) return false;
        if (channel.isPrivate?.()) return true;
        const perm = channel.isThread?.() ? PermissionsBits.SEND_MESSAGES_IN_THREADS : PermissionsBits.SEND_MESSAGES;
        return PermissionStore.can(perm, channel);
    });
}

function TypingLine({ channelId, guildId }: { channelId: string; guildId: string | null; }) {
    const ids = useStateFromStores([TypingStore], () => {
        const me = UserStore.getCurrentUser()?.id;
        return Object.keys(TypingStore.getTypingUsers(channelId) ?? {}).filter(id => id !== me).join(",");
    });
    if (!ids) return <div className={cl("typing")} />;

    const names = ids.split(",").map(id => displayName(id, guildId));
    const text = names.length > 3 ? "Several people are typing…" : names.length === 1 ? `${names[0]} is typing…` : `${names.join(", ")} are typing…`;
    return <div className={cl("typing")}><span className={cl("typing-dots")}><i /><i /><i /></span>{text}</div>;
}

function CommandIcon({ cmd }: { cmd: PopoutCommand; }) {
    return cmd.icon
        ? <img className={cl("cmd-icon")} src={cmd.icon} alt="" />
        : <span className={classes(cl("cmd-icon"), cl("cmd-icon-text"))}>{cmd.source === "Vencord" ? "V" : "/"}</span>;
}

/** Suggestion list above the input */
function CommandSuggestions({ items, selected, loading, onPick, onHover }: {
    items: PopoutCommand[]; selected: number; loading: boolean; onPick(c: PopoutCommand): void; onHover(i: number): void;
}) {
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
    }, [selected]);

    return (
        <div className={cl("cmd-popup")}>
            <div className={cl("cmd-popup-head")}>Commands</div>
            <div className={cl("cmd-list")} ref={listRef}>
                {loading && !items.length && <div className={cl("cmd-empty")}>Loading commands…</div>}
                {!loading && !items.length && <div className={cl("cmd-empty")}>No matching command</div>}
                {items.map((c, i) => (
                    <button
                        key={c.key}
                        data-index={i}
                        className={classes(cl("cmd-item"), i === selected && cl("cmd-item-active"))}
                        onMouseEnter={() => onHover(i)}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => onPick(c)}
                    >
                        <CommandIcon cmd={c} />
                        <span className={cl("cmd-text")}>
                            <span className={cl("cmd-name")}>/{c.name}{c.options.map(o => <span key={o.name} className={cl("cmd-arg")}> {o.name}{o.required ? "" : "?"}</span>)}</span>
                            <span className={cl("cmd-desc")}>{c.description}</span>
                        </span>
                        <span className={cl("cmd-source")}>{c.source}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}

/** Selected command: one field per option, then run it */
function CommandForm({ cmd, onCancel, onDone }: { cmd: PopoutCommand; onCancel(): void; onDone(): void; }) {
    const [values, setValues] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const firstRef = useRef<HTMLInputElement & HTMLSelectElement>(null);

    useEffect(() => {
        const t = setTimeout(() => firstRef.current?.focus(), 30);
        return () => clearTimeout(t);
    }, []);

    const run = async () => {
        if (busy || cmd.unsupported) return;
        setBusy(true);
        setError(null);
        try {
            await cmd.run(values);
            onDone();
        } catch (e: any) {
            const msg = e?.body?.message || e?.message || "Couldn't run command";
            logger.error("Command failed", cmd.name, e);
            setError(msg);
        } finally {
            setBusy(false);
        }
    };

    const onKey = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
        } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            run();
        }
    };

    const set = (name: string, v: string) => setValues(prev => ({ ...prev, [name]: v }));

    return (
        <div className={cl("cmd-form")} onKeyDown={onKey}>
            <div className={cl("cmd-form-head")}>
                <CommandIcon cmd={cmd} />
                <span className={cl("cmd-form-name")}>/{cmd.name}</span>
                <span className={cl("cmd-form-desc")}>{cmd.description}</span>
                <button className={cl("icon-btn")} aria-label="Cancel" {...tip("Cancel (Esc)", "top", "end")} onClick={onCancel}>
                    <Icon path={CLOSE_PATH} size={14} />
                </button>
            </div>

            {cmd.unsupported
                ? <div className={cl("cmd-note")}>{cmd.unsupported}</div>
                : cmd.options.length > 0 && (
                    <div className={cl("cmd-fields")}>
                        {cmd.options.map((o, i) => {
                            const ref = i === 0 ? firstRef : undefined;
                            const label = <span className={cl("cmd-field-label")}>{o.name}{o.required && <b> *</b>}</span>;
                            if (o.type === OptionType.BOOLEAN || o.choices?.length) {
                                const choices = o.choices?.length ? o.choices : [{ name: "Yes", value: "true" }, { name: "No", value: "false" }];
                                return (
                                    <label key={o.name} className={cl("cmd-field")}>
                                        {label}
                                        <select ref={ref} className={cl("cmd-input")} value={values[o.name] ?? ""} onChange={e => set(o.name, e.currentTarget.value)}>
                                            <option value="">{o.required ? "Select…" : "—"}</option>
                                            {choices.map(c => <option key={String(c.value)} value={String(c.value)}>{c.name}</option>)}
                                        </select>
                                        {o.description && <span className={cl("cmd-field-hint")}>{o.description}</span>}
                                    </label>
                                );
                            }
                            const placeholder = o.type === OptionType.USER ? "@name or ID"
                                : o.type === OptionType.CHANNEL ? "#channel or ID"
                                    : o.type === OptionType.ROLE ? "@role or ID"
                                        : o.type === OptionType.INTEGER || o.type === OptionType.NUMBER ? "Number" : o.description;
                            return (
                                <label key={o.name} className={cl("cmd-field")}>
                                    {label}
                                    <input
                                        ref={ref}
                                        className={cl("cmd-input")}
                                        value={values[o.name] ?? ""}
                                        inputMode={o.type === OptionType.INTEGER || o.type === OptionType.NUMBER ? "decimal" : undefined}
                                        placeholder={placeholder}
                                        onChange={e => set(o.name, e.currentTarget.value)}
                                    />
                                    {o.description && placeholder !== o.description && <span className={cl("cmd-field-hint")}>{o.description}</span>}
                                </label>
                            );
                        })}
                    </div>
                )}

            {error && <div className={cl("error-text")}>{error}</div>}

            <div className={cl("cmd-actions")}>
                <span className={cl("cmd-hint")}>Enter to run · Esc to cancel</span>
                <button className={cl("send")} disabled={busy || !!cmd.unsupported} onClick={run}>
                    {busy ? "Running…" : "Run"}
                </button>
            </div>
        </div>
    );
}

function Composer({ channel, name }: { channel: any; name: string; }) {
    const channelId: string = channel.id;
    const [text, setText] = useState(() => drafts.get(channelId) ?? "");
    const ref = useRef<HTMLTextAreaElement>(null);
    const canSend = useCanSend(channel);
    const { showTyping } = settings.use(["showTyping"]);

    // Slash commands
    const [commands, setCommands] = useState<PopoutCommand[] | null>(null);
    const [active, setActive] = useState<PopoutCommand | null>(null);
    const [selected, setSelected] = useState(0);
    const [dismissed, setDismissed] = useState(false);
    const slash = canSend && !active && !dismissed && /^\/[^\n]*$/.test(text) && !/^\/\S+\s+\S/.test(text);
    const matches = useMemo(() => commands ? matchCommands(commands, text.slice(1)) : [], [commands, text]);

    useEffect(() => {
        if (!slash || commands) return;
        let alive = true;
        getCommands(channelId).then(list => alive && setCommands(list)).catch(() => alive && setCommands([]));
        return () => { alive = false; };
    }, [slash, channelId]);

    useEffect(() => setSelected(0), [text]);
    useEffect(() => { if (!text.startsWith("/")) setDismissed(false); }, [text]);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    }, [text, active]);

    useEffect(() => {
        const t = setTimeout(() => ref.current?.focus(), 150);
        return () => clearTimeout(t);
    }, []);

    const update = (v: string) => {
        setText(v);
        if (v) drafts.set(channelId, v);
        else drafts.delete(channelId);
    };

    const pick = (cmd: PopoutCommand) => {
        setActive(cmd);
        update("");
    };

    const closeCommand = () => {
        setActive(null);
        setTimeout(() => ref.current?.focus(), 0);
    };

    const send = () => {
        const content = text.trim();
        if (!content || !canSend) return;
        if (content.length > 2000) {
            showToast("Message is too long (max. 2000 characters)", Toasts.Type.FAILURE);
            return;
        }

        const slow = channel.rateLimitPerUser ?? 0;
        const bypass = channel.isPrivate?.()
            || PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, channel)
            || PermissionStore.can(PermissionsBits.MANAGE_CHANNELS, channel);
        if (slow > 0 && !bypass) {
            const left = Math.ceil(((lastSent.get(channelId) ?? 0) + slow * 1000 - Date.now()) / 1000);
            if (left > 0) {
                showToast(`Slowmode: wait ${left}s`, Toasts.Type.FAILURE);
                return;
            }
        }

        lastSent.set(channelId, Date.now());
        update("");
        try {
            Promise.resolve(sendMessage(channelId, { content }, false)).catch((e: any) => {
                logger.error("Couldn't send message", e);
                const slowmode = e?.body?.code === 20016 || e?.status === 429;
                showToast(slowmode ? "Slowmode is active – please wait a moment" : "Couldn't send message", Toasts.Type.FAILURE);
            });
        } catch (e) {
            logger.error("Couldn't send message", e);
            showToast("Couldn't send message", Toasts.Type.FAILURE);
            update(content);
        }
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (slash && matches.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const dir = e.key === "ArrowDown" ? 1 : -1;
                setSelected(s => (s + dir + matches.length) % matches.length);
                return;
            }
            if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                pick(matches[selected] ?? matches[0]);
                return;
            }
        }
        if (slash && e.key === "Escape") {
            e.preventDefault();
            setDismissed(true);
            return;
        }
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
        }
    };

    return (
        <div className={cl("composer")}>
            {slash && (
                <CommandSuggestions
                    items={matches}
                    selected={selected}
                    loading={!commands}
                    onPick={pick}
                    onHover={setSelected}
                />
            )}
            {active
                ? <CommandForm key={active.key} cmd={active} onCancel={closeCommand} onDone={closeCommand} />
                : (
                    <div className={classes(cl("input-wrap"), !canSend && cl("input-disabled"))}>
                        <textarea
                            ref={ref}
                            className={cl("input")}
                            rows={1}
                            value={canSend ? text : ""}
                            disabled={!canSend}
                            placeholder={canSend ? `Message ${name} – "/" for commands` : "You don't have permission to send messages here."}
                            onChange={e => update(e.currentTarget.value)}
                            onKeyDown={onKeyDown}
                        />
                        {canSend && <button className={cl("send")} onClick={send} disabled={!text.trim()}>Send</button>}
                    </div>
                )}
            {showTyping && <TypingLine channelId={channelId} guildId={channel.guild_id ?? null} />}
        </div>
    );
}

// ---------------------------------------------------------------- Call bar

function VoiceBar({ channelId, guildId }: { channelId: string; guildId: string | null; }) {
    // As a string so the store hook compares a stable value
    const key = useStateFromStores([VoiceStateStore], () => {
        const states = VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {};
        return Object.values(states as Record<string, any>)
            .map(s => `${s.userId}:${s.selfMute || s.mute ? 1 : 0}${s.selfDeaf || s.deaf ? 1 : 0}${s.selfStream ? 1 : 0}`)
            .join(",");
    });
    const inCall = useStateFromStores([SelectedChannelStore], () => isInCall(channelId));

    if (!key) return null;
    const people = key.split(",").map(p => {
        const [id, flags] = p.split(":");
        return { id, muted: flags[0] === "1", deaf: flags[1] === "1", live: flags[2] === "1" };
    });

    return (
        <div className={cl("voice")}>
            <span className={cl("voice-dot")} />
            <div className={cl("voice-people")}>
                {people.slice(0, 10).map(p => (
                    <span key={p.id} className={cl("voice-person")} {...tip(displayName(p.id, guildId) + (p.live ? " (live)" : ""), "bottom", "start")}>
                        <img src={userAvatar(p.id, UserStore.getUser(p.id), 48)} alt="" />
                        {(p.deaf || p.muted) && <span className={cl("voice-flag")}><Icon path={p.deaf ? DEAF_PATH : MUTE_PATH} size={10} /></span>}
                        {p.live && <span className={cl("voice-live")}>LIVE</span>}
                    </span>
                ))}
                {people.length > 10 && <span className={cl("voice-more")}>+{people.length - 10}</span>}
            </div>
            <span className={cl("voice-label")}>{people.length === 1 ? "1 in call" : `${people.length} in call`}</span>
            {inCall && (
                <button className={cl("voice-btn")} onClick={() => openCallPopout(channelId)} {...tip("Discord's call window with cameras & streams", "bottom", "end")}>
                    <Icon path={CALL_PATH} size={14} /> Call Window
                </button>
            )}
        </div>
    );
}

// ---------------------------------------------------------------- Sidebar (channel list)

const TEXT_TYPES = new Set([0, 5]); // text, announcement
const VOICE_TYPES = new Set([2, 13]); // voice, stage (both have a text chat)

interface SidebarGroup {
    id: string;
    name: string | null;
    channels: any[];
}

/** Channels of a server like in Discord's list: uncategorized first, then categories; text before voice */
function useGuildGroups(guildId: string): SidebarGroup[] {
    const data = useStateFromStores([GuildChannelStore], () => GuildChannelStore.getChannels(guildId));

    return useMemo(() => {
        const list = [...(data?.SELECTABLE ?? []), ...(data?.VOCAL ?? [])]
            .map((c: any) => c.channel)
            .filter((c: any) => c && (TEXT_TYPES.has(c.type) || VOICE_TYPES.has(c.type)));

        const byParent = new Map<string, any[]>();
        for (const c of list) {
            const key = c.parent_id ?? "";
            if (!byParent.has(key)) byParent.set(key, []);
            byParent.get(key)!.push(c);
        }

        const rank = (c: any) => VOICE_TYPES.has(c.type) ? 1 : 0;
        const sortChannels = (arr: any[]) => arr.sort((a, b) => rank(a) - rank(b) || (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id));

        return [...byParent.entries()]
            .map(([id, channels]) => {
                const category = id ? ChannelStore.getChannel(id) : null;
                return { id, name: category?.name ?? null, position: id ? (category?.position ?? 0) : -1, channels: sortChannels(channels) };
            })
            .sort((a, b) => a.position - b.position)
            .map(({ position, ...g }) => g);
    }, [data]);
}

function useDmList(): string[] {
    const ids = useStateFromStores([PrivateChannelSortStore], () => PrivateChannelSortStore.getPrivateChannelIds().join(","));
    return useMemo(() => ids ? ids.split(",") : [], [ids]);
}

function channelIcon(c: any) {
    if (c.type === 5) return ANNOUNCE_PATH;
    if (VOICE_TYPES.has(c.type)) return SPEAKER_PATH;
    return HASH_PATH;
}

function SidebarChannel({ c, guildId, active, onSelect }: { c: any; guildId: string; active: boolean; onSelect(id: string): void; }) {
    const unread = useStateFromStores([ReadStateStore], () => ReadStateStore.hasUnread(c.id));
    const mentions = useStateFromStores([ReadStateStore], () => ReadStateStore.getMentionCount(c.id));
    const muted = useStateFromStores([UserGuildSettingsStore], () => UserGuildSettingsStore.isChannelMuted(guildId, c.id));
    const inVoice = useStateFromStores([VoiceStateStore], () => VOICE_TYPES.has(c.type) ? Object.keys(VoiceStateStore.getVoiceStatesForChannel(c.id) ?? {}).length : 0);

    return (
        <button
            className={classes(cl("side-item"), active && cl("side-item-active"), unread && !muted && cl("side-item-unread"), muted && cl("side-item-muted"))}
            onClick={() => onSelect(c.id)}
        >
            <Icon path={channelIcon(c)} size={18} className={cl("side-icon")} />
            <span className={cl("side-name")}>{c.name}</span>
            {inVoice > 0 && <span className={cl("side-count")}>{inVoice}</span>}
            {mentions > 0 && <span className={cl("side-badge")}>{mentions}</span>}
        </button>
    );
}

function GuildSidebar({ guildId, current, onSelect }: { guildId: string; current: string; onSelect(id: string): void; }) {
    const groups = useGuildGroups(guildId);
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

    const toggle = (id: string) => setCollapsed(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });

    return (
        <>
            {groups.map(g => {
                const isCollapsed = collapsed.has(g.id);
                // Like Discord: a collapsed category still shows the open channel
                const visible = isCollapsed ? g.channels.filter(c => c.id === current) : g.channels;
                return (
                    <div key={g.id || "none"} className={cl("side-group")}>
                        {g.name && (
                            <button className={classes(cl("side-category"), isCollapsed && cl("side-category-collapsed"))} onClick={() => toggle(g.id)}>
                                <Icon path={CHEVRON_PATH} size={12} className={cl("side-chevron")} />
                                <span>{g.name}</span>
                            </button>
                        )}
                        {visible.map(c => <SidebarChannel key={c.id} c={c} guildId={guildId} active={c.id === current} onSelect={onSelect} />)}
                    </div>
                );
            })}
        </>
    );
}

function DmSidebarItem({ id, active, onSelect }: { id: string; active: boolean; onSelect(id: string): void; }) {
    const info = useChannelInfo(id);
    const unread = useStateFromStores([ReadStateStore], () => ReadStateStore.hasUnread(id));
    const mentions = useStateFromStores([ReadStateStore], () => ReadStateStore.getMentionCount(id));
    if (!info.channel) return null;

    return (
        <button className={classes(cl("side-item"), cl("side-dm"), active && cl("side-item-active"), unread && cl("side-item-unread"))} onClick={() => onSelect(id)}>
            {info.icon
                ? <img className={cl("side-avatar")} src={info.icon} alt="" />
                : <span className={classes(cl("side-avatar"), cl("title-icon-text"))}>{(info.name || "?").slice(0, 1)}</span>}
            <span className={cl("side-name")}>{info.name}</span>
            {mentions > 0 && <span className={cl("side-badge")}>{mentions}</span>}
        </button>
    );
}

function DmSidebar({ current, onSelect }: { current: string; onSelect(id: string): void; }) {
    const ids = useDmList();
    return <>{ids.slice(0, 100).map(id => <DmSidebarItem key={id} id={id} active={id === current} onSelect={onSelect} />)}</>;
}

function Sidebar({ channel, current, onSelect }: { channel: any; current: string; onSelect(id: string): void; }) {
    const guildId: string | null = channel?.guild_id ?? null;
    const guild = useStateFromStores([GuildStore], () => guildId ? GuildStore.getGuild(guildId) : null);
    const listRef = useRef<HTMLDivElement>(null);

    // Keep the open channel in view when switching
    useEffect(() => {
        listRef.current?.querySelector(`.${cl("side-item-active")}`)?.scrollIntoView({ block: "nearest" });
    }, [current]);

    return (
        <nav className={cl("sidebar")}>
            <div className={cl("side-head")}>{guildId ? guild?.name ?? "Server" : "Direct Messages"}</div>
            <div className={cl("side-list")} ref={listRef}>
                {guildId
                    ? <GuildSidebar guildId={guildId} current={current} onSelect={onSelect} />
                    : <DmSidebar current={current} onSelect={onSelect} />}
            </div>
        </nav>
    );
}

// ---------------------------------------------------------------- Window

function nativeWindow(): any {
    return (window as any).DiscordNative?.window;
}

function TitleBar({ info, windowKey, channelId, guildId, sidebar, onToggleSidebar }: {
    info: ReturnType<typeof useChannelInfo>; windowKey: string; channelId: string; guildId: string | null; sidebar: boolean; onToggleSidebar(): void;
}) {
    const pinned = useStateFromStores([PopoutWindowStore], () => PopoutWindowStore.getIsAlwaysOnTop(windowKey));
    const native = nativeWindow();
    const title = `${info.prefix}${info.name}`;

    return (
        <header className={cl("titlebar")}>
            <button
                className={classes(cl("icon-btn"), sidebar && cl("icon-btn-active"))}
                {...tip(sidebar ? "Hide channel list" : "Show channel list", "bottom", "start")}
                aria-label={sidebar ? "Hide channel list" : "Show channel list"}
                aria-pressed={sidebar}
                onClick={onToggleSidebar}
            >
                <Icon path={SIDEBAR_PATH} size={16} />
            </button>
            {info.icon
                ? <img className={cl("title-icon")} src={info.icon} alt="" />
                : <span className={classes(cl("title-icon"), cl("title-icon-text"))}>{(info.name || "?").slice(0, 1)}</span>}
            <div className={cl("title-text")}>
                <div className={cl("title-name")}>{title}</div>
                {info.subtitle && <div className={cl("title-sub")}>{info.subtitle}</div>}
            </div>
            <div className={cl("title-actions")}>
                <IconButton path={PIN_PATH} label={pinned ? "Unpin from top" : "Always on top"} active={pinned} onClick={() => PopoutActions.setAlwaysOnTop(windowKey, !pinned)} />
                <IconButton path={MAIN_PATH} label="Open in main window" disabled={!info.channel} onClick={() => openInMain(channelId, guildId)} />
                {native?.minimize && <IconButton path={MIN_PATH} label="Minimize" onClick={() => native.minimize(windowKey)} />}
                {native?.maximize && <IconButton path={MAX_PATH} label="Maximize" onClick={() => native.maximize(windowKey)} />}
                <IconButton path={CLOSE_PATH} label="Close" danger onClick={() => PopoutActions.close(windowKey)} />
            </div>
        </header>
    );
}

function Lightbox({ url, onClose }: { url: string; onClose(): void; }) {
    return (
        <div className={cl("lightbox")} onClick={onClose}>
            <img src={url} alt="" onClick={e => e.stopPropagation()} />
            <a className={cl("lightbox-open")} href={url} target="_blank" rel="noreferrer noopener" onClick={e => e.stopPropagation()}>Open in browser</a>
        </div>
    );
}

function ChannelView({ channel, name, showVoice, ctx }: { channel: any; name: string; showVoice: boolean; ctx: WindowCtx; }) {
    const guildId: string | null = channel.guild_id ?? null;
    return (
        <>
            {showVoice && <ErrorBoundary noop><VoiceBar channelId={channel.id} guildId={guildId} /></ErrorBoundary>}
            <ErrorBoundary message="Couldn't display messages.">
                <MessageList channelId={channel.id} guildId={guildId} ctx={ctx} />
            </ErrorBoundary>
            <Composer channel={channel} name={name} />
        </>
    );
}

function ChatWindowInner({ channelId: initialChannelId, windowKey }: { channelId: string; windowKey: string; }) {
    const rootRef = useRef<HTMLDivElement>(null);
    // The window can switch channels via the sidebar; the window key stays that of the first channel
    const [channelId, setChannelId] = useState(initialChannelId);
    const info = useChannelInfo(channelId);
    const { sidebar: sidebarSetting } = settings.use(["sidebar"]);
    const [sidebar, setSidebar] = useState(sidebarSetting);

    const toggleSidebar = () => {
        settings.store.sidebar = !sidebar;
        setSidebar(!sidebar);
    };

    const selectChannel = (id: string) => {
        setChannelId(id);
        // Narrow window: the sidebar covers the chat, so close it after picking
        const win = rootRef.current?.ownerDocument?.defaultView;
        if (win && win.innerWidth < 560) setSidebar(false);
    };
    const { channel } = info;
    const guildId: string | null = channel?.guild_id ?? null;
    const { showVoice } = settings.use(["showVoice"]);
    const [zoom, setZoom] = useState<string | null>(null);

    const ctx = useMemo<WindowCtx>(() => ({
        doc: () => rootRef.current?.ownerDocument ?? document,
        zoom: setZoom
    }), []);

    // Prepare the popout document: copy theme classes and make sure Vencord styles are present
    useLayoutEffect(() => {
        const doc = rootRef.current?.ownerDocument;
        if (!doc || doc === document) return;
        doc.documentElement.className = document.documentElement.className;
        doc.body.classList.add(...Array.from(document.body.classList));
        if (!doc.querySelector("vencord-root")) doc.documentElement.appendChild(vencordRootNode.cloneNode(true));
    }, []);

    useEffect(() => {
        const doc = rootRef.current?.ownerDocument;
        if (doc) doc.title = `${info.prefix}${info.name}`;
    }, [info.name, info.prefix]);

    // Esc closes the image preview
    useEffect(() => {
        const doc = rootRef.current?.ownerDocument;
        if (!doc || !zoom) return;
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoom(null);
        doc.addEventListener("keydown", onKey);
        return () => doc.removeEventListener("keydown", onKey);
    }, [zoom]);

    return (
        <div ref={rootRef} className={cl("window")}>
            <TitleBar info={info} windowKey={windowKey} channelId={channelId} guildId={guildId} sidebar={sidebar} onToggleSidebar={toggleSidebar} />
            <div className={cl("main")}>
                {sidebar && (
                    <ErrorBoundary noop>
                        <Sidebar channel={channel ?? ChannelStore.getChannel(initialChannelId)} current={channelId} onSelect={selectChannel} />
                    </ErrorBoundary>
                )}
                <div className={cl("chat")}>
                    {channel
                        // One keyed view per channel, so switching fully replaces list, call bar and input
                        ? <ChannelView key={channelId} channel={channel} name={`${info.prefix}${info.name}`} showVoice={showVoice} ctx={ctx} />
                        : <div className={cl("center")}>
                            <div className={cl("muted")}>This chat is no longer available.</div>
                            <button className={cl("button")} onClick={() => PopoutActions.close(windowKey)}>Close window</button>
                        </div>}
                </div>
            </div>
            {zoom && <Lightbox url={zoom} onClose={() => setZoom(null)} />}
        </div>
    );
}

export function ChatWindow(props: { channelId: string; windowKey: string; }) {
    return (
        <ErrorBoundary message="Couldn't display the window.">
            <ChatWindowInner {...props} />
        </ErrorBoundary>
    );
}
