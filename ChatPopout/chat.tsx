/*
 * ChatPopout – contents of a window: title bar, call bar, message list and input
 * Runs in the same process as the main window but is rendered into the popout window's document.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { sendMessage } from "@utils/discord";
import { classes } from "@utils/misc";
import {
    ChannelStore, FluxDispatcher, GuildChannelStore, GuildMemberStore, GuildStore, IconUtils, MessageActions, NavigationRouter, PendingReplyStore, PermissionsBits, PermissionStore, PopoutActions, PopoutWindowStore,
    PrivateChannelSortStore, ReadStateStore, RestAPI, showToast, TypingStore, useCallback, useEffect, useLayoutEffect, useMemo, useRef, UserGuildSettingsStore, UserStore,
    useState, useStateFromStores, VoiceStateStore
} from "@webpack/common";
import type { ComponentType, ReactNode } from "react";

import { getCommands, matchCommands, OptionType, PopoutCommand } from "./commands";
import { collectComponentMedia, IS_COMPONENTS_V2, MessageComponents } from "./components";
import { logger, settings } from "./index";
import { copyImage, copyText, mediaAttrs, mediaFromElement, MediaItem, MediaMeta, MediaViewer, openExternal, saveMedia } from "./media";
import { ContextMenu, MenuItem, MenuState } from "./menu";
import { RawMessage, useChannelMessages } from "./messages";
import { ProfileCard, ProfileTarget } from "./profile";
import {
    ANNOUNCE_PATH, CDN, CHEVRON_PATH, cl, CLOSE_PATH, COPY_PATH, displayName, DOWNLOAD_PATH, EDIT_PATH, FallbackImg, FILE_PATH, fitBox, GifVideo, HASH_PATH, Icon, ID_PATH,
    isAnimated, isSpoiler, LINK_PATH, MAIN_PATH, Markdown, MAX_PATH, MIN_PATH, PIN_PATH, PLAY_PATH, POPOUT_PATH, REPLY_PATH, SIDEBAR_PATH, sized, SPEAKER_PATH, Spoiler, tip,
    TRASH_PATH, usePopoutDocument, USER_PATH, userAvatar, ZOOM_PATH
} from "./shared";
import { sendFiles } from "./upload";
import { VoiceBar, voiceMenuSections } from "./voice";
import { openStreamWindow, startWatching, StreamDock, StreamTarget, streamTargetFor, useDockWidth } from "./watch";

export { Icon, POPOUT_PATH };

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

function formatSize(bytes?: number) {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const toColor = (n: unknown) => typeof n === "number" ? `#${n.toString(16).padStart(6, "0")}` : undefined;

function authorInfo(author: any, guildId: string | null) {
    const id: string = author?.id ?? "0";
    const member = guildId ? GuildMemberStore.getMember(guildId, id) : null;
    const name: string = member?.nick || author?.global_name || author?.globalName || author?.username || "Unknown";
    return { id, name, color: member?.colorString ?? undefined, avatar: userAvatar(id, author) };
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

/** Composer actions that the context menu can trigger */
interface ComposerApi {
    reply(m: RawMessage): void;
    edit(m: RawMessage): void;
    /** Replaces the selection in the input (or inserts at the cursor) */
    replaceSelection(text: string): void;
    textarea(): HTMLTextAreaElement | null;
}

/** Window context: document (for scrolling/lookup), media viewer, open messages and input */
interface WindowCtx {
    doc: () => Document;
    openMedia(items: MediaItem[], original: string, meta?: MediaMeta): void;
    messages: { current: RawMessage[]; };
    composer: { current: ComposerApi | null; };
    openProfile(el: Element, userId: string): void;
    watchStream(userId: string): void;
    /** Messages the host doesn't want in the list (SecretChat hides its key exchange and system messages) */
    hideMessage?(m: RawMessage): boolean;
    /**
     * Draws the message list instead of ours – SecretChat uses Discord's own message components (it runs in the
     * main window, where they work). Its element gets data-native-messages, so our menus / profile stay out of it.
     */
    renderMessages?(channel: any): ReactNode;
    /** Shown above the input while files are attached */
    attachmentNote?: string;
    /** Sends attached files instead of our upload (SecretChat encrypts them) */
    sendFiles?(channel: any, files: File[], messageReference?: unknown): Promise<void>;
}

// ---------------------------------------------------------------- Media of a message

function attachmentItem(a: any): MediaItem | null {
    if (!a?.url) return null;
    const type: string = a.content_type ?? "";
    const isImage = type.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif)$/i.test(a.filename ?? "");
    const isVideo = type.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(a.filename ?? "");
    if (!isImage && !isVideo) return null;
    return { url: a.proxy_url ?? a.url, original: a.url, kind: isVideo ? "video" : "image", name: a.filename, width: a.width, height: a.height };
}

function embedMedia(e: any): MediaItem | null {
    const img = e.type === "image" || e.type === "gifv" ? e.thumbnail ?? e.image : e.image;
    if (!img?.url) return null;
    return { url: img.proxy_url ?? img.url, original: img.url, kind: "image", width: img.width, height: img.height };
}

/** Everything in a message that the viewer can show, in display order */
function collectMedia(m: RawMessage): MediaItem[] {
    const v2 = ((m as any).flags ?? 0) & IS_COMPONENTS_V2;
    const items: MediaItem[] = v2 ? [] : (m.attachments ?? []).map(attachmentItem).filter(Boolean) as MediaItem[];
    collectComponentMedia((m as any).components, m, items);
    for (const e of m.embeds ?? []) {
        if (e.type === "gifv" && e.video) continue;
        const item = embedMedia(e);
        if (item) items.push(item);
    }
    return items;
}

// ---------------------------------------------------------------- Message parts

function Attachment({ a, open }: { a: any; open(original: string): void; }) {
    const item = attachmentItem(a);
    const box = fitBox(a.width, a.height);
    let content: React.ReactNode;

    if (item?.kind === "image") {
        // Resizing through the media proxy makes animated images static – load those unscaled
        const src = a.proxy_url && box.width && !isAnimated(a) ? sized(a.proxy_url, box.width * 2, box.height! * 2) : item.url;
        content = <FallbackImg className={cl("image")} src={src} fallback={a.url} alt={a.filename} width={box.width} height={box.height} onClick={() => open(a.url)} {...mediaAttrs(item)} />;
    } else if (item?.kind === "video") {
        content = <video className={cl("image")} src={item.url} controls preload="metadata" width={box.width} height={box.height} {...mediaAttrs(item)} />;
    } else {
        content = (
            <a className={cl("file")} href={a.url} target="_blank" rel="noreferrer noopener">
                <Icon path={FILE_PATH} size={22} />
                <span className={cl("file-name")}>{a.filename}</span>
                <span className={cl("file-size")}>{formatSize(a.size)}</span>
            </a>
        );
    }
    return isSpoiler(a) ? <Spoiler>{content}</Spoiler> : <>{content}</>;
}

function EmbedImage({ media, open, maxW, maxH, className }: { media: any; open(original: string): void; maxW?: number; maxH?: number; className?: string; }) {
    const box = fitBox(media.width, media.height, maxW, maxH);
    const item: MediaItem = { url: media.proxy_url ?? media.url, original: media.url, kind: "image" };
    return (
        <FallbackImg
            className={classes(cl("image"), className)}
            src={item.url}
            fallback={media.url}
            width={box.width}
            height={box.height}
            alt=""
            onClick={() => open(media.url)}
            {...mediaAttrs(item)}
        />
    );
}

function Embed({ e, channelId, messageId, open }: { e: any; channelId: string; messageId: string; open(original: string): void; }) {
    const thumb = e.thumbnail ?? null;
    const image = e.image ?? null;

    // Tenor/Giphy/Klipy GIFs are really looping MP4 videos – the thumbnail is only a still frame
    if (e.type === "gifv" && e.video) {
        const box = fitBox(e.video.width ?? thumb?.width, e.video.height ?? thumb?.height);
        const item: MediaItem = { url: e.video.proxy_url ?? e.video.url, original: e.url ?? e.video.url, kind: "video" };
        return <GifVideo src={item.url} fallback={e.video.url} poster={thumb?.proxy_url ?? thumb?.url} width={box.width} height={box.height} {...mediaAttrs(item)} />;
    }
    if ((e.type === "image" || e.type === "gifv") && (thumb || image)) {
        return <EmbedImage media={thumb ?? image} open={open} />;
    }
    if (!e.title && !e.description && !e.author?.name && !image && !thumb && !e.fields?.length && !e.footer?.text) return null;

    const color = toColor(e.color);
    // Videos (YouTube & co.) show the thumbnail big with a play button, like Discord
    const bigThumb = thumb && !image && (e.type === "video" || !!e.video);
    const md = (content: string) => <Markdown content={content} channelId={channelId} messageId={messageId} />;
    const date = e.timestamp ? new Date(e.timestamp) : null;

    return (
        <div className={cl("embed")} style={color ? { borderLeftColor: color } : undefined}>
            <div className={cl("embed-body")}>
                {e.provider?.name && (e.provider.url
                    ? <a className={cl("embed-provider")} href={e.provider.url} target="_blank" rel="noreferrer noopener">{e.provider.name}</a>
                    : <div className={cl("embed-provider")}>{e.provider.name}</div>)}
                {e.author?.name && (
                    <div className={cl("embed-author")}>
                        {e.author.icon_url && <img className={cl("embed-author-icon")} src={e.author.proxy_icon_url ?? e.author.icon_url} alt="" />}
                        {e.author.url
                            ? <a href={e.author.url} target="_blank" rel="noreferrer noopener">{e.author.name}</a>
                            : <span>{e.author.name}</span>}
                    </div>
                )}
                {e.title && (e.url
                    ? <a className={cl("embed-title")} href={e.url} target="_blank" rel="noreferrer noopener">{e.title}</a>
                    : <div className={cl("embed-title")}>{md(e.title)}</div>)}
                {e.description && <div className={cl("embed-desc")}>{md(e.description)}</div>}
                {!!e.fields?.length && (
                    <div className={cl("embed-fields")}>
                        {e.fields.map((f: any, i: number) => (
                            <div key={i} className={classes(cl("embed-field"), f.inline && cl("embed-field-inline"))}>
                                <div className={cl("embed-field-name")}>{md(f.name)}</div>
                                <div className={cl("embed-field-value")}>{md(f.value)}</div>
                            </div>
                        ))}
                    </div>
                )}
                {image && <EmbedImage media={image} open={open} maxW={400} maxH={300} className={cl("embed-image")} />}
                {bigThumb && (
                    <a className={cl("embed-video")} href={e.url} target="_blank" rel="noreferrer noopener" {...mediaAttrs({ url: thumb.proxy_url ?? thumb.url, original: thumb.url, kind: "image" })}>
                        <FallbackImg className={cl("image")} src={thumb.proxy_url ?? thumb.url} fallback={thumb.url} alt="" {...fitBox(thumb.width, thumb.height, 400, 225)} />
                        <span className={cl("embed-play")}><Icon path={PLAY_PATH} size={22} /></span>
                    </a>
                )}
                {(e.footer?.text || date) && (
                    <div className={cl("embed-footer")}>
                        {e.footer?.icon_url && <img className={cl("embed-footer-icon")} src={e.footer.proxy_icon_url ?? e.footer.icon_url} alt="" />}
                        <span>{[e.footer?.text, date && formatFull(date)].filter(Boolean).join(" • ")}</span>
                    </div>
                )}
            </div>
            {thumb && !image && !bigThumb && (
                <EmbedImage media={thumb} open={open} maxW={80} maxH={80} className={cl("embed-thumb")} />
            )}
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
            <img className={cl("reply-avatar")} src={a.avatar} alt="" data-user-id={a.id} />
            <span className={cl("reply-name")} style={{ color: a.color }} data-user-id={a.id}>{a.name}</span>
            <span className={cl("reply-text")}>{preview.length > 120 ? preview.slice(0, 120) + "…" : preview}</span>
        </div>
    );
}

/** Like Discord: a message that is only a link to a GIF/image shows just the media */
function isOnlyMediaLink(m: RawMessage) {
    const content = m.content?.trim();
    if (!content || !/^<?https?:\/\/\S+>?$/.test(content) || m.embeds?.length !== 1) return false;
    const e = m.embeds[0];
    return e.type === "gifv" || e.type === "image";
}

// ---------------------------------------------------------------- Message

function Message({ m, guildId, grouped, meId, ctx }: { m: RawMessage; guildId: string | null; grouped: boolean; meId?: string; ctx: WindowCtx; }) {
    const a = authorInfo(m.author, guildId);
    const date = new Date(m.timestamp);
    const isSystem = !NORMAL_TYPES.has(m.type);
    const mentioned = !!meId && (m.mention_everyone || m.mentions?.some((u: any) => u?.id === meId));
    const command = (m as any).interaction_metadata?.name ?? (m as any).interaction?.name;
    const jump = () => openInMain(m.channel_id, guildId, m.id);
    const v2 = !!(((m as any).flags ?? 0) & IS_COMPONENTS_V2);
    const open = (original: string) => ctx.openMedia(collectMedia(m), original, { author: a.name, avatar: a.avatar, date });

    const time = (
        <span className={cl("time")} {...tip(`${date.toLocaleString(LOCALE)} · show in main window`)} onClick={jump}>
            {grouped ? date.toLocaleTimeString(LOCALE, TIME) : formatFull(date)}
        </span>
    );

    if (isSystem) {
        return (
            <div id={`vc-chatpopout-msg-${m.id}`} data-message-id={m.id} className={classes(cl("message"), cl("system"))}>
                <div className={cl("row")}>
                    <div className={cl("gutter")}>→</div>
                    <div className={cl("body")}>
                        <span className={cl("name")} style={{ color: a.color }} data-user-id={a.id}>{a.name}</span>{" "}
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
            data-message-id={m.id}
            className={classes(cl("message"), !grouped && cl("group-start"), mentioned && cl("mentioned"), m._pending && cl("pending"), m._failed && cl("failed"))}
        >
            {m.type === 19 && <ReplyLine m={m} guildId={guildId} ctx={ctx} />}
            {command && <div className={cl("reply")}><span className={cl("muted")}>{a.name} used</span> <span className={cl("command")}>/{command}</span></div>}
            <div className={cl("row")}>
                <div className={cl("gutter")}>
                    {grouped
                        ? <span className={cl("gutter-time")} onClick={jump} {...tip("Show in main window", "top", "start")}>{date.toLocaleTimeString(LOCALE, TIME)}</span>
                        : <img className={cl("avatar")} src={a.avatar} alt="" data-user-id={a.id} />}
                </div>
                <div className={cl("body")}>
                    {!grouped && (
                        <div className={cl("meta")}>
                            <span className={cl("name")} style={{ color: a.color }} data-user-id={a.id}>{a.name}</span>
                            {m.author?.bot && <span className={cl("bot-tag")}>{m.author?.discriminator === "0000" ? "WEBHOOK" : "APP"}</span>}
                            {time}
                        </div>
                    )}
                    {m.content && !isOnlyMediaLink(m) && (
                        <div className={cl("content")}>
                            <Markdown content={m.content} channelId={m.channel_id} messageId={m.id} />
                            {m.edited_timestamp && <span className={cl("edited")}> (edited)</span>}
                        </div>
                    )}
                    {/* Components V2 messages place their attachments inside the components */}
                    {!v2 && !!m.attachments?.length && (
                        <div className={cl("attachments")}>
                            {m.attachments.map(att => <Attachment key={att.id ?? att.url} a={att} open={open} />)}
                        </div>
                    )}
                    <Stickers items={m.sticker_items} />
                    {m.embeds?.map((e, i) => <Embed key={i} e={e} channelId={m.channel_id} messageId={m.id} open={open} />)}
                    <MessageComponents components={(m as any).components} ctx={{ message: m, open, jump }} />
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
    const { messages: loaded, loading, loadingOlder, hasMore, error, newCount, loadOlder, reload } = useChannelMessages(channelId);
    const messages = useMemo(() => ctx.hideMessage ? loaded.filter(m => !ctx.hideMessage!(m)) : loaded, [loaded]);
    const meId = UserStore.getCurrentUser()?.id;
    ctx.messages.current = messages;

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
    if (!ids) return null;

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

type ComposeMode =
    | { type: "reply"; message: RawMessage; mention: boolean; }
    | { type: "edit"; message: RawMessage; draft: string; };

function editMessage(channelId: string, messageId: string, content: string) {
    try {
        return Promise.resolve(MessageActions.editMessage(channelId, messageId, { content }));
    } catch {
        return RestAPI.patch({ url: `/channels/${channelId}/messages/${messageId}`, body: { content } });
    }
}

export function deleteMessage(channelId: string, messageId: string) {
    const fail = (e: any) => {
        logger.error("Couldn't delete message", e);
        showToast("Couldn't delete message", "failure");
    };
    try {
        Promise.resolve(MessageActions.deleteMessage(channelId, messageId)).catch(fail);
    } catch {
        RestAPI.del({ url: `/channels/${channelId}/messages/${messageId}` }).catch(fail);
    }
}

function canEdit(m: RawMessage | undefined) {
    return !!m && m.author?.id === UserStore.getCurrentUser()?.id && NORMAL_TYPES.has(m.type) && !m._pending && !m._failed;
}

function Composer({ channel, name, ctx }: { channel: any; name: string; ctx: WindowCtx; }) {
    const channelId: string = channel.id;
    const guildId: string | null = channel.guild_id ?? null;
    const [text, setText] = useState(() => drafts.get(channelId) ?? "");
    const ref = useRef<HTMLTextAreaElement>(null);
    const canSend = useCanSend(channel);
    const { showTyping } = settings.use(["showTyping"]);
    const [mode, setMode] = useState<ComposeMode | null>(null);
    const [files, setFiles] = useState<File[]>([]);
    const fileRef = useRef<HTMLInputElement>(null);
    const addFiles = (list: ArrayLike<File> | null | undefined) => {
        const add = Array.from(list ?? []);
        if (add.length) setFiles(prev => [...prev, ...add].slice(0, 10));
    };

    // Slash commands
    const [commands, setCommands] = useState<PopoutCommand[] | null>(null);
    const [active, setActive] = useState<PopoutCommand | null>(null);
    const [selected, setSelected] = useState(0);
    const [dismissed, setDismissed] = useState(false);
    const slash = canSend && !active && !dismissed && mode?.type !== "edit" && /^\/[^\n]*$/.test(text) && !/^\/\S+\s+\S/.test(text);
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

    const focus = (caret?: number) => setTimeout(() => {
        const el = ref.current;
        if (!el) return;
        el.focus();
        if (caret != null) el.setSelectionRange(caret, caret);
    }, 0);

    useEffect(() => {
        const t = setTimeout(() => ref.current?.focus(), 150);
        return () => clearTimeout(t);
    }, []);

    const update = (v: string, keepDraft = mode?.type !== "edit") => {
        setText(v);
        if (!keepDraft) return;
        if (v) drafts.set(channelId, v);
        else drafts.delete(channelId);
    };

    const startEdit = (m: RawMessage) => {
        setActive(null);
        setMode({ type: "edit", message: m, draft: mode?.type === "edit" ? mode.draft : text });
        update(m.content ?? "", false);
        focus((m.content ?? "").length);
    };

    const cancelMode = () => {
        if (mode?.type === "edit") update(mode.draft, false);
        setMode(null);
        focus();
    };

    // With Discord's own messages (renderMessages), their "Reply" puts a pending reply into Discord's store –
    // take it over here, Discord's own chat input isn't there
    const pendingReply = useStateFromStores([PendingReplyStore], () => ctx.renderMessages ? PendingReplyStore.getPendingReply(channelId) : undefined, [channelId]);
    useEffect(() => {
        if (!pendingReply?.message) return;
        ctx.composer.current?.reply(pendingReply.message as any);
        if (pendingReply.shouldMention === false) setMode(m => m?.type === "reply" ? { ...m, mention: false } : m);
        FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId } as any);
    }, [pendingReply]);

    // Actions for the context menu
    const textRef = useRef(text);
    textRef.current = text;
    const modeRef = useRef(mode);
    modeRef.current = mode;
    useEffect(() => {
        ctx.composer.current = {
            reply(m) {
                setActive(null);
                if (modeRef.current?.type === "edit") update(modeRef.current.draft, false);
                setMode({ type: "reply", message: m, mention: m.author?.id !== UserStore.getCurrentUser()?.id });
                focus();
            },
            edit: startEdit,
            replaceSelection(insert) {
                const el = ref.current;
                const value = textRef.current;
                const start = el?.selectionStart ?? value.length;
                const end = el?.selectionEnd ?? value.length;
                update(value.slice(0, start) + insert + value.slice(end));
                focus(start + insert.length);
            },
            textarea: () => ref.current
        };
        return () => { ctx.composer.current = null; };
    });

    const pick = (cmd: PopoutCommand) => {
        setActive(cmd);
        update("");
    };

    const closeCommand = () => {
        setActive(null);
        focus();
    };

    const send = () => {
        const content = text.trim();
        if (mode?.type === "edit") {
            const m = mode.message;
            if (content && content !== m.content) {
                editMessage(channelId, m.id, content).catch((e: any) => {
                    logger.error("Couldn't edit message", e);
                    showToast("Couldn't edit message", "failure");
                });
            }
            cancelMode();
            return;
        }

        if ((!content && !files.length) || !canSend) return;
        if (content.length > 2000) {
            showToast("Message is too long (max. 2000 characters)", "failure");
            return;
        }

        const slow = channel.rateLimitPerUser ?? 0;
        const bypass = channel.isPrivate?.()
            || PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, channel)
            || PermissionStore.can(PermissionsBits.MANAGE_CHANNELS, channel);
        if (slow > 0 && !bypass) {
            const left = Math.ceil(((lastSent.get(channelId) ?? 0) + slow * 1000 - Date.now()) / 1000);
            if (left > 0) {
                showToast(`Slowmode: wait ${left}s`, "failure");
                return;
            }
        }

        const options = mode?.type === "reply" ? {
            messageReference: { guild_id: guildId ?? undefined, channel_id: channelId, message_id: mode.message.id },
            allowedMentions: mode.mention ? undefined : { parse: ["users", "roles", "everyone"], replied_user: false }
        } : {};

        lastSent.set(channelId, Date.now());
        update("");
        setMode(null);
        const attached = files;
        setFiles([]);
        if (attached.length) {
            const reference = content ? undefined : (options as any).messageReference;
            const sent = ctx.sendFiles ? ctx.sendFiles(channel, attached, reference) : sendFiles(channel, attached, reference, ctx.doc().defaultView);
            sent.catch((e: any) => {
                logger.error("Couldn't upload files", e);
                showToast("Couldn't upload the file", "failure");
            });
        }
        if (!content) return;
        try {
            Promise.resolve(sendMessage(channelId, { content }, false, options as any)).catch((e: any) => {
                logger.error("Couldn't send message", e);
                const slowmode = e?.body?.code === 20016 || e?.status === 429;
                showToast(slowmode ? "Slowmode is active – please wait a moment" : "Couldn't send message", "failure");
            });
        } catch (e) {
            logger.error("Couldn't send message", e);
            showToast("Couldn't send message", "failure");
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
        if (mode && e.key === "Escape") {
            e.preventDefault();
            cancelMode();
            return;
        }
        // Like Discord: arrow up in an empty input edits your last message
        if (e.key === "ArrowUp" && !text && !mode) {
            const last = [...ctx.messages.current].reverse().find(canEdit);
            if (last) {
                e.preventDefault();
                startEdit(last);
            }
            return;
        }
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
        }
    };

    const replyName = mode?.type === "reply" ? authorInfo(mode.message.author, guildId).name : "";

    return (
        <div className={cl("composer")}>
            {showTyping && <TypingLine channelId={channelId} guildId={guildId} />}
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
                    <div className={classes(cl("input-box"), mode && cl("input-box-mode"))}>
                        {mode && (
                            <div className={cl("mode-bar")}>
                                <Icon path={mode.type === "reply" ? REPLY_PATH : EDIT_PATH} size={14} />
                                <span className={cl("mode-text")}>
                                    {mode.type === "reply"
                                        ? <>Replying to <b>{replyName}</b></>
                                        : <>Editing message <span className={cl("muted")}>· Esc to cancel · Enter to save</span></>}
                                </span>
                                {mode.type === "reply" && (
                                    <button
                                        className={classes(cl("mode-mention"), mode.mention && cl("mode-mention-on"))}
                                        {...tip(mode.mention ? "Ping is on" : "Ping is off")}
                                        onClick={() => setMode({ ...mode, mention: !mode.mention })}
                                    >
                                        @ {mode.mention ? "ON" : "OFF"}
                                    </button>
                                )}
                                <button className={cl("icon-btn")} aria-label="Cancel" {...tip("Cancel (Esc)", "top", "end")} onClick={cancelMode}>
                                    <Icon path={CLOSE_PATH} size={14} />
                                </button>
                            </div>
                        )}
                        {!!files.length && (
                            <div className={cl("attach-bar")}>
                                {ctx.attachmentNote && <div className={cl("attach-note")}>{ctx.attachmentNote}</div>}
                                <div className={cl("attach-list")}>
                                    {files.map((f, i) => <AttachmentChip key={i} file={f} onRemove={() => setFiles(prev => prev.filter((_, j) => j !== i))} />)}
                                </div>
                            </div>
                        )}
                        <div
                            className={classes(cl("input-wrap"), !canSend && cl("input-disabled"))}
                            onDragOver={e => { if (canSend && mode?.type !== "edit" && e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
                            onDrop={e => {
                                if (!canSend || mode?.type === "edit" || !e.dataTransfer.files.length) return;
                                e.preventDefault();
                                addFiles(e.dataTransfer.files);
                            }}
                        >
                            {canSend && mode?.type !== "edit" && (
                                <>
                                    <button className={classes(cl("icon-btn"), cl("attach-btn"))} aria-label="Attach files" {...tip("Attach files", "top", "start")} onClick={() => fileRef.current?.click()}>
                                        <Icon path={PLUS_PATH} size={18} />
                                    </button>
                                    <input ref={fileRef} type="file" multiple hidden onChange={e => { addFiles(e.currentTarget.files); e.currentTarget.value = ""; }} />
                                </>
                            )}
                            <textarea
                                ref={ref}
                                className={cl("input")}
                                rows={1}
                                value={canSend ? text : ""}
                                disabled={!canSend}
                                placeholder={canSend ? `Message ${name} – "/" for commands` : "You don't have permission to send messages here."}
                                onChange={e => update(e.currentTarget.value)}
                                onKeyDown={onKeyDown}
                                onPaste={e => {
                                    if (mode?.type === "edit" || !e.clipboardData.files.length) return;
                                    e.preventDefault();
                                    addFiles(e.clipboardData.files);
                                }}
                            />
                            {canSend && (
                                <button className={cl("send")} onClick={send} disabled={!text.trim() && !files.length}>
                                    {mode?.type === "edit" ? "Save" : "Send"}
                                </button>
                            )}
                        </div>
                    </div>
                )}
        </div>
    );
}

const PLUS_PATH = "M13 5a1 1 0 1 0-2 0v6H5a1 1 0 1 0 0 2h6v6a1 1 0 1 0 2 0v-6h6a1 1 0 1 0 0-2h-6V5Z";

/** A file waiting to be sent: thumbnail for images, else a file icon – with name and size */
function AttachmentChip({ file, onRemove }: { file: File; onRemove(): void; }) {
    const [url, setUrl] = useState<string | null>(null);
    useEffect(() => {
        if (!file.type.startsWith("image/")) return;
        const u = URL.createObjectURL(file);
        setUrl(u);
        return () => URL.revokeObjectURL(u);
    }, [file]);

    return (
        <div className={cl("attach-chip")}>
            {url ? <img src={url} alt="" /> : <Icon path={FILE_PATH} size={28} />}
            <span className={cl("attach-name")}>{file.name}</span>
            <span className={cl("attach-size")}>{formatSize(file.size)}</span>
            <button className={cl("attach-remove")} aria-label="Remove" onClick={onRemove}><Icon path={CLOSE_PATH} size={12} /></button>
        </div>
    );
}

// ---------------------------------------------------------------- Call bar

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

function TitleBar({ info, windowKey, channelId, guildId, sidebar, onToggleSidebar, onClose }: {
    info: ReturnType<typeof useChannelInfo>; windowKey: string; channelId: string; guildId: string | null; sidebar: boolean; onToggleSidebar(): void;
    /** Embedded in the main window: no window buttons, closing is up to the host */
    onClose?(): void;
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
                {!onClose && <IconButton path={PIN_PATH} label={pinned ? "Unpin from top" : "Always on top"} active={pinned} onClick={() => PopoutActions.setAlwaysOnTop(windowKey, !pinned)} />}
                <IconButton path={MAIN_PATH} label="Open in main window" disabled={!info.channel} onClick={() => { openInMain(channelId, guildId); onClose?.(); }} />
                {!onClose && native?.minimize && <IconButton path={MIN_PATH} label="Minimize" onClick={() => native.minimize(windowKey)} />}
                {!onClose && native?.maximize && <IconButton path={MAX_PATH} label="Maximize" onClick={() => native.maximize(windowKey)} />}
                <IconButton path={CLOSE_PATH} label="Close" danger onClick={() => onClose ? onClose() : PopoutActions.close(windowKey)} />
            </div>
        </header>
    );
}

function ChannelView({ channel, name, showVoice, ctx }: { channel: any; name: string; showVoice: boolean; ctx: WindowCtx; }) {
    const guildId: string | null = channel.guild_id ?? null;
    return (
        <>
            {showVoice && <ErrorBoundary noop><VoiceBar channelId={channel.id} guildId={guildId} /></ErrorBoundary>}
            <ErrorBoundary message="Couldn't display messages.">
                {ctx.renderMessages ? ctx.renderMessages(channel) : <MessageList channelId={channel.id} guildId={guildId} ctx={ctx} />}
            </ErrorBoundary>
            <Composer channel={channel} name={name} ctx={ctx} />
        </>
    );
}

// ---------------------------------------------------------------- Context menu

function canSendIn(channel: any) {
    if (!channel) return false;
    if (channel.isPrivate?.()) return true;
    return PermissionStore.can(channel.isThread?.() ? PermissionsBits.SEND_MESSAGES_IN_THREADS : PermissionsBits.SEND_MESSAGES, channel);
}

async function readClipboard(win: Window): Promise<string> {
    const clip = (window as any).DiscordNative?.clipboard;
    if (typeof clip?.read === "function") return String(await clip.read() ?? "");
    return win.navigator.clipboard.readText();
}

/** Builds the menu for whatever was right-clicked – most specific first, like Discord */
function buildMenu(target: Element, ctx: WindowCtx, channel: any): MenuItem[][] {
    const doc = ctx.doc();
    const win = doc.defaultView ?? window;
    const guildId: string | null = channel?.guild_id ?? null;
    const sections: MenuItem[][] = [];

    // Text fields: cut, copy, paste
    const field = target.closest<HTMLTextAreaElement | HTMLInputElement>("textarea, input");
    if (field) {
        const selected = field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
        // execCommand keeps the browser's undo history and fires React's onChange
        const insert = (text: string) => {
            field.focus();
            doc.execCommand("insertText", false, text);
        };
        sections.push([
            ...(selected ? [
                { id: "cut", label: "Cut", action: () => { copyText(selected, "Cut"); field.focus(); doc.execCommand("delete"); } },
                { id: "copy", label: "Copy", icon: COPY_PATH, action: () => copyText(selected) }
            ] : []),
            { id: "paste", label: "Paste", action: () => readClipboard(win).then(insert).catch(e => logger.error("Couldn't paste", e)) },
            { id: "select-all", label: "Select All", action: () => { field.focus(); field.select(); } }
        ]);
        return sections;
    }

    // Selected text
    const selection = doc.getSelection()?.toString() ?? "";
    if (selection.trim()) sections.push([{ id: "copy", label: "Copy", icon: COPY_PATH, action: () => copyText(selection) }]);

    const msgEl = target.closest("[data-message-id]");
    const message = msgEl ? ctx.messages.current.find(m => m.id === msgEl.getAttribute("data-message-id")) : undefined;

    // Images & videos
    const media = mediaFromElement(target);
    if (media) {
        const label = media.kind === "video" ? "Video" : "Image";
        const items: MenuItem[] = [];
        if (message && media.kind === "image") {
            const a = authorInfo(message.author, guildId);
            items.push({ id: "view", label: "View Image", icon: ZOOM_PATH, action: () => ctx.openMedia(collectMedia(message), media.original, { author: a.name, avatar: a.avatar, date: new Date(message.timestamp) }) });
        }
        if (media.kind === "image") items.push({ id: "copy-image", label: "Copy Image", icon: COPY_PATH, action: () => copyImage(media, win) });
        items.push(
            { id: "save", label: `Save ${label}`, icon: DOWNLOAD_PATH, action: () => saveMedia(media, win) },
            { id: "copy-media-link", label: "Copy Link", icon: LINK_PATH, action: () => copyText(media.original, "Link copied") },
            { id: "open-media", label: "Open in Browser", icon: POPOUT_PATH, action: () => openExternal(media.original, doc) }
        );
        sections.push(items);
    }

    // Links (except media links, which are covered above)
    const link = target.closest<HTMLAnchorElement>("a[href]");
    if (link && /^https?:/i.test(link.href) && !media) {
        sections.push([
            { id: "open-link", label: "Open Link", icon: POPOUT_PATH, action: () => openExternal(link.href, doc) },
            { id: "copy-link", label: "Copy Link", icon: LINK_PATH, action: () => copyText(link.href, "Link copied") }
        ]);
    }

    // Users (avatar, name, call bar)
    const userId = target.closest("[data-user-id]")?.getAttribute("data-user-id");
    if (userId && userId !== "0") {
        const items: MenuItem[] = [];
        if (canSendIn(channel) && ctx.composer.current) {
            items.push({ id: "mention", label: "Mention", action: () => ctx.composer.current?.replaceSelection(`<@${userId}> `) });
        }
        const userEl = target.closest("[data-user-id]")!;
        items.push(
            { id: "profile", label: "Profile", icon: USER_PATH, action: () => ctx.openProfile(userEl, userId) },
            { id: "copy-user-id", label: "Copy User ID", icon: ID_PATH, action: () => copyText(userId, "User ID copied") }
        );
        sections.push(items);
        // Volume, mute, move … for people in this channel's call
        sections.push(...voiceMenuSections(userId, channel, ctx.watchStream));
    }

    // Message
    if (message && !message._pending) {
        const me = UserStore.getCurrentUser()?.id;
        const own = message.author?.id === me;
        const normal = NORMAL_TYPES.has(message.type);
        const canManage = !channel?.isPrivate?.() && PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, channel);
        const link = `https://discord.com${channelPath(message.channel_id, guildId, message.id)}`;

        const actions: MenuItem[] = [];
        if (normal && canSendIn(channel) && ctx.composer.current) {
            actions.push({ id: "reply", label: "Reply", icon: REPLY_PATH, action: () => ctx.composer.current?.reply(message) });
        }
        if (canEdit(message)) actions.push({ id: "edit", label: "Edit Message", icon: EDIT_PATH, action: () => ctx.composer.current?.edit(message) });
        if (message.content) actions.push({ id: "copy-text", label: "Copy Text", icon: COPY_PATH, action: () => copyText(message.content) });
        actions.push(
            { id: "copy-message-link", label: "Copy Message Link", icon: LINK_PATH, action: () => copyText(link, "Message link copied") },
            { id: "show-main", label: "Show in Main Window", icon: MAIN_PATH, action: () => openInMain(message.channel_id, guildId, message.id) }
        );
        sections.push(actions);

        const extra: MenuItem[] = [{ id: "copy-message-id", label: "Copy Message ID", icon: ID_PATH, action: () => copyText(message.id, "Message ID copied") }];
        if (!message._failed && (own || canManage)) {
            extra.push({
                id: "delete",
                label: "Delete Message",
                icon: TRASH_PATH,
                danger: true,
                confirm: "Click again to delete",
                action: () => deleteMessage(message.channel_id, message.id)
            });
        }
        sections.push(extra);
    }

    return sections.filter(s => s.length);
}

/** Clicked @mention in a message → user ID (Discord's mention elements carry no ID) */
function mentionUserId(target: Element, ctx: WindowCtx): string | null {
    const mention = target.closest<HTMLElement>('[class*="mention"]');
    const content = mention?.closest(`.${cl("content")}`);
    const msgEl = mention?.closest("[data-message-id]");
    if (!mention || !content || !msgEl) return null;
    const m = ctx.messages.current.find(x => x.id === msgEl.getAttribute("data-message-id"));
    if (!m) return null;

    const text = (mention.textContent ?? "").trim();
    if (!text.startsWith("@")) return null;

    // By name: the message lists every mentioned user
    const name = text.slice(1);
    const guildId = ChannelStore.getChannel(m.channel_id)?.guild_id ?? null;
    const byName = (m.mentions ?? []).find((u: any) => [
        guildId && GuildMemberStore.getNick(guildId, u.id), u.global_name, u.globalName, u.username
    ].includes(name));
    if (byName) return byName.id;

    // Otherwise by position: n-th mention in the text = n-th mention token in the content
    const all = Array.from(content.querySelectorAll<HTMLElement>('[class*="mention"]'))
        .filter(el => (el.textContent ?? "").trim().startsWith("@") && !el.parentElement?.closest('[class*="mention"]'));
    const outer = all.find(el => el.contains(mention)) ?? mention;
    const tokens = [...(m.content ?? "").matchAll(/<@!?(\d+)>|<@&\d+>|@everyone|@here/g)];
    const token = tokens[all.indexOf(outer)];
    return token?.[1] ?? null;
}

/** Opens an existing DM or creates it */
async function dmChannelId(userId: string): Promise<string | null> {
    const existing = ChannelStore.getDMFromUserId(userId);
    if (existing) return existing;
    try {
        const { body } = await RestAPI.post({ url: "/users/@me/channels", body: { recipient_id: userId } });
        return body?.id ?? null;
    } catch (e) {
        logger.error("Couldn't open DM", e);
        showToast("Couldn't open DM", "failure");
        return null;
    }
}

// ---------------------------------------------------------------- Window

export interface ChatSidebarProps {
    current: string;
    onSelect(id: string): void;
}

export interface ChatWindowProps {
    channelId: string;
    windowKey: string;
    /** Replaces the DM / channel list (SecretChat shows its rooms there) */
    sidebar?: ComponentType<ChatSidebarProps>;
    /** Shown instead of the chat while no channel is open */
    emptyView?: ReactNode;
    /** Window title while no channel is open */
    title?: string;
    /** Extra class on the window root, for a different look */
    className?: string;
    /** Rendered inside the main window (e.g. SecretChat's rooms window) instead of a popout – called by the close button */
    onClose?(): void;
    /** Messages to leave out of the list */
    hideMessage?(m: RawMessage): boolean;
    /** See WindowCtx.renderMessages */
    renderMessages?(channel: any): ReactNode;
    /** See WindowCtx.attachmentNote */
    attachmentNote?: string;
    /** See WindowCtx.sendFiles */
    sendFiles?(channel: any, files: File[], messageReference?: unknown): Promise<void>;
}

function ChatWindowInner({ channelId: initialChannelId, windowKey, sidebar: CustomSidebar, emptyView, title, className, onClose, hideMessage, renderMessages, attachmentNote, sendFiles: hostSendFiles }: ChatWindowProps) {
    const rootRef = useRef<HTMLDivElement>(null);
    // The window can switch channels via the sidebar; the window key stays that of the first channel
    const [channelId, setChannelId] = useState(initialChannelId);
    // The opener can switch the channel too (e.g. SecretChat opening a room in its already open window)
    useEffect(() => setChannelId(initialChannelId), [initialChannelId]);
    const channelInfo = useChannelInfo(channelId);
    const info = !channelInfo.channel && title ? { ...channelInfo, name: title, subtitle: "", prefix: "" } : channelInfo;
    const { sidebar: sidebarSetting } = settings.use(["sidebar"]);
    const [sidebar, setSidebar] = useState(CustomSidebar ? true : sidebarSetting);

    const toggleSidebar = () => {
        if (!CustomSidebar) settings.store.sidebar = !sidebar;
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
    const [viewer, setViewer] = useState<{ items: MediaItem[]; index: number; meta?: MediaMeta; } | null>(null);
    const [menu, setMenu] = useState<MenuState | null>(null);
    const closeMenu = useCallback(() => setMenu(null), []);
    const [profile, setProfile] = useState<ProfileTarget | null>(null);
    const [stream, setStream] = useState<StreamTarget | null>(null);
    const [dockWidth, setDockWidth] = useDockWidth(rootRef);
    const channelRef = useRef(channelId);
    channelRef.current = channelId;
    const closeProfile = useCallback(() => setProfile(null), []);
    const guildRef = useRef(guildId);
    guildRef.current = guildId;

    const ctx = useMemo<WindowCtx>(() => ({
        hideMessage,
        renderMessages,
        attachmentNote,
        sendFiles: hostSendFiles,
        doc: () => rootRef.current?.ownerDocument ?? document,
        openMedia(items, original, meta) {
            const index = items.findIndex(i => i.original === original);
            if (index >= 0) setViewer({ items, index, meta });
        },
        messages: { current: [] },
        composer: { current: null },
        openProfile(el, userId) {
            // Author object from the message as fallback for webhooks & users Discord hasn't loaded
            const msgEl = el.closest("[data-message-id]");
            const m = msgEl ? this.messages.current.find(x => x.id === msgEl.getAttribute("data-message-id")) : undefined;
            const fallback = m?.author?.id === userId ? m.author : m?.mentions?.find((u: any) => u?.id === userId);
            setProfile({ userId, guildId: guildRef.current, anchor: el.getBoundingClientRect(), fallback });
        },
        watchStream(userId) {
            const target = streamTargetFor(userId, channelRef.current);
            if (!target) {
                showToast("This stream isn't available here", "failure");
                return;
            }
            if (!startWatching(target)) return;
            setStream(target);
            // Make room for the stream next to the chat
            const win = rootRef.current?.ownerDocument?.defaultView;
            if (win && win.innerWidth < 900) {
                try {
                    win.resizeTo(win.outerWidth + 520, Math.max(win.outerHeight, 600));
                } catch { /* not resizable */ }
            }
        }
    }), []);

    // Left click on avatar, name, @mention or someone in the call bar → profile card
    const onClick = (e: React.MouseEvent) => {
        const target = e.target as Element;
        if (target.closest(`.${cl("profile")}, .${cl("menu")}, [data-native-messages]`)) return;
        // LIVE badge → watch the stream
        const live = target.closest("[data-stream-user]")?.getAttribute("data-stream-user");
        if (live) {
            e.preventDefault();
            e.stopPropagation();
            ctx.watchStream(live);
            return;
        }
        const userEl = target.closest("[data-user-id]");
        const userId = userEl?.getAttribute("data-user-id") ?? mentionUserId(target, ctx);
        if (!userId || userId === "0") return;
        e.preventDefault();
        e.stopPropagation();
        ctx.openProfile(userEl ?? target.closest('[class*="mention"]') ?? target, userId);
    };

    const messageUser = async (userId: string) => {
        const id = await dmChannelId(userId);
        if (id) selectChannel(id);
    };

    usePopoutDocument(rootRef, `${info.prefix}${info.name}`);

    // Capture phase: Discord components inside messages (mentions etc.) would otherwise open their menu in the main window
    const onContextMenu = (e: React.MouseEvent) => {
        if ((e.target as Element).closest(`.${cl("stream-dock")}, [data-native-messages]`)) return;
        e.preventDefault();
        e.stopPropagation();
        const target = e.target as Element;
        if (target.closest(`.${cl("menu")}`)) return;
        let sections: MenuItem[][] = [];
        try {
            sections = buildMenu(target, ctx, channel);
        } catch (err) {
            logger.error("Couldn't build context menu", err);
        }
        setMenu(sections.length ? { x: e.clientX, y: e.clientY, sections } : null);
    };

    return (
        <div ref={rootRef} className={classes(cl("window"), className)} onContextMenuCapture={onContextMenu} onClickCapture={onClick}>
            <TitleBar info={info} windowKey={windowKey} channelId={channelId} guildId={guildId} sidebar={sidebar} onToggleSidebar={toggleSidebar} onClose={onClose} />
            <div className={cl("main")}>
                {sidebar && (
                    <ErrorBoundary noop>
                        {CustomSidebar
                            ? <nav className={cl("sidebar")}><CustomSidebar current={channelId} onSelect={selectChannel} /></nav>
                            : <Sidebar channel={channel ?? ChannelStore.getChannel(initialChannelId)} current={channelId} onSelect={selectChannel} />}
                    </ErrorBoundary>
                )}
                <div className={cl("chat")}>
                    {channel
                        // One keyed view per channel, so switching fully replaces list, call bar and input
                        ? <ChannelView key={channelId} channel={channel} name={`${info.prefix}${info.name}`} showVoice={showVoice} ctx={ctx} />
                        : emptyView ?? <div className={cl("center")}>
                            <div className={cl("muted")}>This chat is no longer available.</div>
                            <button className={cl("button")} onClick={() => PopoutActions.close(windowKey)}>Close window</button>
                        </div>}
                </div>
                {stream && (
                    <ErrorBoundary noop>
                        <StreamDock
                            key={stream.streamKey}
                            target={stream}
                            width={dockWidth}
                            onResize={setDockWidth}
                            onClose={() => setStream(null)}
                            onPopout={() => {
                                const t = stream;
                                openStreamWindow(t, () => setStream(t));
                                setStream(null);
                            }}
                        />
                    </ErrorBoundary>
                )}
            </div>
            {viewer && <ErrorBoundary noop><MediaViewer {...viewer} onClose={() => setViewer(null)} /></ErrorBoundary>}
            {menu && <ErrorBoundary noop><ContextMenu state={menu} onClose={closeMenu} /></ErrorBoundary>}
            {profile && (
                <ErrorBoundary noop>
                    <ProfileCard
                        key={profile.userId}
                        target={profile}
                        onClose={closeProfile}
                        onMessage={messageUser}
                        onMention={channel && canSendIn(channel) ? id => ctx.composer.current?.replaceSelection(`<@${id}> `) : undefined}
                        onOpenMedia={(items, original) => { closeProfile(); ctx.openMedia(items, original); }}
                    />
                </ErrorBoundary>
            )}
        </div>
    );
}

export function ChatWindow(props: ChatWindowProps) {
    return (
        <ErrorBoundary message="Couldn't display the window.">
            <ChatWindowInner {...props} />
        </ErrorBoundary>
    );
}
