/*
 * SplitView – a panel: header, message list and input field
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { openImageModal, openUserProfile, sendMessage } from "@utils/discord";
import { classes } from "@utils/misc";
import {
    ChannelStore, GuildMemberStore, GuildStore, IconUtils, NavigationRouter, Parser, PermissionsBits, PermissionStore, showToast,
    TypingStore, useEffect, useLayoutEffect, useMemo, useRef, UserStore, useState, useStateFromStores
} from "@webpack/common";

import { Button, Empty, Icon, IconButton, ICONS, Spinner } from "../_ui";

import { closePanel, logger, movePanel, settings } from "./index";
import { RawMessage, useChannelMessages } from "./messages";

const cl = classNameFactory("vc-splitview-");

// ---------------------------------------------------------------- Icons

const FILE_PATH = "M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.4a2 2 0 0 0-.6-1.4l-4.4-4.4A2 2 0 0 0 13.6 2H6Zm7 1.8L18.2 9H14a1 1 0 0 1-1-1V3.8Z";

// ---------------------------------------------------------------- Helpers

const CDN = "https://cdn.discordapp.com";
const GROUP_MS = 7 * 60 * 1000;

export function channelPath(channelId: string, guildId?: string | null, messageId?: string) {
    return `/channels/${guildId ?? "@me"}/${channelId}${messageId ? `/${messageId}` : ""}`;
}

export function openInMain(channelId: string, guildId?: string | null, messageId?: string) {
    NavigationRouter.transitionTo(channelPath(channelId, guildId, messageId));
}

/** Name, icon and server of a channel for the header & lists */
export function useChannelInfo(channelId: string) {
    const channel = useStateFromStores([ChannelStore], () => ChannelStore.getChannel(channelId));
    const guild = useStateFromStores([GuildStore], () => channel?.guild_id ? GuildStore.getGuild(channel.guild_id) : null);
    // As a string so the store hook compares a stable value
    const recipientKey = useStateFromStores([UserStore], () => (channel?.recipients ?? []).filter((id: string) => UserStore.getUser(id)).join(","));

    return useMemo(() => {
        const recipients = recipientKey ? recipientKey.split(",").map(id => UserStore.getUser(id)) : [];
        if (!channel) return { channel, guild: null, name: "Unknown channel", subtitle: "", icon: null as string | null, prefix: "" };

        if (channel.isDM?.() && recipients[0]) {
            const u: any = recipients[0];
            return {
                channel, guild: null, name: u.globalName || u.username, subtitle: "Direct Message",
                icon: IconUtils.getUserAvatarURL(u, false, 64) as string | null, prefix: "@"
            };
        }
        if (channel.isPrivate?.()) {
            const names = recipients.map((u: any) => u.globalName || u.username).join(", ");
            return {
                channel, guild: null, name: channel.name || names || "Group", subtitle: "Group DM",
                icon: IconUtils.getChannelIconURL({ id: channel.id, icon: channel.icon, size: 64 }) ?? null, prefix: ""
            };
        }
        return {
            channel, guild, name: channel.name, subtitle: guild?.name ?? "",
            icon: guild?.icon ? IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, size: 64 }) ?? null : null,
            prefix: channel.isThread?.() ? "" : "#"
        };
    }, [channel, guild, recipientKey]);
}

function authorInfo(author: any, guildId: string | null) {
    const id: string = author?.id ?? "0";
    const member = guildId ? GuildMemberStore.getMember(guildId, id) : null;
    const name: string = member?.nick || author?.global_name || author?.globalName || author?.username || "Unknown";

    let avatar: string;
    const user = UserStore.getUser(id);
    if (user && !author?.bot) avatar = IconUtils.getUserAvatarURL(user, false, 80);
    else if (author?.avatar) avatar = `${CDN}/avatars/${id}/${author.avatar}.webp?size=80`;
    else avatar = IconUtils.getDefaultAvatarURL(id, author?.discriminator);

    return { id, name, color: member?.colorString ?? undefined, avatar };
}

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

function formatFull(d: Date) {
    const now = new Date();
    const time = d.toLocaleTimeString("en-US", TIME);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return `Today at ${time}`;
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`;
    return `${d.toLocaleDateString("en-US")} ${time}`;
}

const formatDay = (d: Date) => d.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

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

function parseContent(content: string, channelId: string, messageId: string) {
    return Parser.parse(content, true, {
        channelId,
        messageId,
        allowLinks: true,
        allowHeading: true,
        allowList: true,
        allowEmojiLinks: true,
        viewingChannelId: channelId
    });
}

function Markdown({ content, channelId, messageId }: { content: string; channelId: string; messageId: string; }) {
    const nodes = useMemo(() => {
        try {
            return parseContent(content, channelId, messageId);
        } catch (e) {
            logger.error("Markdown could not be rendered", e);
            return content;
        }
    }, [content, channelId, messageId]);

    return (
        <ErrorBoundary noop fallback={() => <span>{content}</span>}>
            {nodes}
        </ErrorBoundary>
    );
}

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

// ---------------------------------------------------------------- Message building blocks

function Attachment({ a }: { a: any; }) {
    const type: string = a.content_type ?? "";
    const isImage = type.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif)$/i.test(a.filename ?? "");
    const isVideo = type.startsWith("video/");
    const box = fitBox(a.width, a.height);

    if (isImage && a.url) {
        const src = a.proxy_url && box.width ? sized(a.proxy_url, box.width * 2, box.height! * 2) : (a.proxy_url ?? a.url);
        return (
            <img
                className={cl("image")}
                src={src}
                alt={a.filename}
                width={box.width}
                height={box.height}
                loading="lazy"
                onClick={() => openImageModal({ url: a.url, original: a.url, width: a.width || 512, height: a.height || 512 })}
            />
        );
    }
    if (isVideo && a.url) {
        return <video className={cl("image")} src={a.proxy_url ?? a.url} controls preload="metadata" width={box.width} height={box.height} />;
    }
    return (
        <a className={cl("file")} href={a.url} target="_blank" rel="noreferrer noopener">
            <Icon path={FILE_PATH} size={22} className={cl("file-icon")} />
            <span className={cl("file-name")}>{a.filename}</span>
            <span className={cl("file-size")}>{formatSize(a.size)}</span>
        </a>
    );
}

function Embed({ e, channelId, messageId }: { e: any; channelId: string; messageId: string; }) {
    const thumb = e.thumbnail ?? null;
    const image = e.image ?? null;

    // Pure image/GIF embeds (e.g. Tenor) as an image only
    if ((e.type === "image" || e.type === "gifv") && thumb) {
        const box = fitBox(thumb.width, thumb.height);
        return <img className={cl("image")} src={thumb.proxy_url ?? thumb.url} width={box.width} height={box.height} loading="lazy" alt="" />;
    }
    if (!e.title && !e.description && !e.author?.name && !image && !thumb) return null;

    const color = typeof e.color === "number" ? `#${e.color.toString(16).padStart(6, "0")}` : undefined;
    const imgBox = image ? fitBox(image.width, image.height, 280, 200) : null;

    return (
        <div className={cl("embed")} style={color ? { borderLeftColor: color } : undefined}>
            <div className={cl("embed-body")}>
                {e.provider?.name && <div className={cl("embed-provider")}>{e.provider.name}</div>}
                {e.author?.name && <div className={cl("embed-author")}>{e.author.name}</div>}
                {e.title && (
                    e.url
                        ? <a className={cl("embed-title")} href={e.url} target="_blank" rel="noreferrer noopener">{e.title}</a>
                        : <div className={cl("embed-title")}>{e.title}</div>
                )}
                {e.description && (
                    <div className={cl("embed-desc")}>
                        <Markdown content={e.description} channelId={channelId} messageId={messageId} />
                    </div>
                )}
                {image && (
                    <img className={cl("embed-image")} src={image.proxy_url ?? image.url} width={imgBox?.width} height={imgBox?.height} loading="lazy" alt="" />
                )}
            </div>
            {thumb && !image && <img className={cl("embed-thumb")} src={thumb.proxy_url ?? thumb.url} loading="lazy" alt="" />}
        </div>
    );
}

function Reactions({ reactions }: { reactions: RawMessage["reactions"]; }) {
    if (!reactions?.length) return null;
    return (
        <div className={cl("reactions")}>
            {reactions.map(r => {
                const key = r.emoji.id ?? r.emoji.name;
                return (
                    <span key={key} className={classes(cl("reaction"), r.me && cl("reaction-me"))} title={r.emoji.name}>
                        {r.emoji.id
                            ? <img src={`${CDN}/emojis/${r.emoji.id}.${r.emoji.animated ? "gif" : "webp"}?size=32`} alt={r.emoji.name} />
                            : <span className={cl("reaction-emoji")}>{r.emoji.name}</span>}
                        <span>{r.count}</span>
                    </span>
                );
            })}
        </div>
    );
}

function Stickers({ items }: { items: RawMessage["sticker_items"]; }) {
    if (!items?.length) return null;
    return (
        <div className={cl("stickers")}>
            {items.map(s => s.format_type === 3
                ? <span key={s.id} className={cl("muted")}>[Sticker: {s.name}]</span>
                : <img key={s.id} className={cl("sticker")} title={s.name} alt={s.name}
                    src={`https://media.discordapp.net/stickers/${s.id}.${s.format_type === 4 ? "gif" : "webp"}?size=160`} />
            )}
        </div>
    );
}

function scrollToMessage(channelId: string, messageId: string, guildId: string | null) {
    const el = document.getElementById(`vc-splitview-msg-${channelId}-${messageId}`);
    if (!el) {
        openInMain(channelId, guildId, messageId);
        return;
    }
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove(cl("flash"));
    void el.offsetWidth;
    el.classList.add(cl("flash"));
}

function ReplyLine({ m, guildId }: { m: RawMessage; guildId: string | null; }) {
    const ref = m.referenced_message;
    if (!ref) {
        return <div className={cl("reply")}><span className={cl("muted")}>Original message was deleted</span></div>;
    }
    const a = authorInfo(ref.author, guildId);
    const preview = (ref.content || (ref.attachments?.length ? "Click to see attachment" : ref.embeds?.length ? "Embed" : "")).replace(/\s+/g, " ");

    return (
        <div className={cl("reply")} onClick={() => scrollToMessage(m.channel_id, ref.id, guildId)}>
            <img className={cl("reply-avatar")} src={a.avatar} alt="" />
            <span className={cl("reply-name")} style={{ color: a.color }}>{a.name}</span>
            <span className={cl("reply-text")}>{preview.length > 120 ? preview.slice(0, 120) + "…" : preview}</span>
        </div>
    );
}

// ---------------------------------------------------------------- Message

interface MessageProps {
    m: RawMessage;
    guildId: string | null;
    grouped: boolean;
    meId?: string;
}

function Message({ m, guildId, grouped, meId }: MessageProps) {
    const a = authorInfo(m.author, guildId);
    const date = new Date(m.timestamp);
    const isSystem = !NORMAL_TYPES.has(m.type);
    const mentioned = !!meId && (m.mention_everyone || m.mentions?.some((u: any) => u?.id === meId));
    const command = (m as any).interaction_metadata?.name ?? (m as any).interaction?.name;

    const jump = () => openInMain(m.channel_id, guildId, m.id);
    const profile = () => openUserProfile(a.id).catch(() => { });

    const time = (
        <span className={cl("time")} title={`${date.toLocaleString("en-US")} – show in main window`} onClick={jump}>
            {grouped ? date.toLocaleTimeString("en-US", TIME) : formatFull(date)}
        </span>
    );

    if (isSystem) {
        return (
            <div id={`vc-splitview-msg-${m.channel_id}-${m.id}`} className={classes(cl("message"), cl("system"))}>
                <div className={cl("gutter")}>→</div>
                <div className={cl("body")}>
                    <span className={cl("name")} style={{ color: a.color }} onClick={profile}>{a.name}</span>{" "}
                    <span className={cl("muted")}>{SYSTEM_TEXT[m.type] ?? "System message"}</span>{" "}
                    {time}
                    {m.content && m.type !== 7 && <div className={cl("content")}><Markdown content={m.content} channelId={m.channel_id} messageId={m.id} /></div>}
                </div>
            </div>
        );
    }

    return (
        <div
            id={`vc-splitview-msg-${m.channel_id}-${m.id}`}
            className={classes(
                cl("message"),
                !grouped && cl("group-start"),
                mentioned && cl("mentioned"),
                m._pending && cl("pending"),
                m._failed && cl("failed")
            )}
        >
            {m.type === 19 && <ReplyLine m={m} guildId={guildId} />}
            {command && <div className={cl("reply")}><span className={cl("muted")}>{a.name} used</span> <span className={cl("command")}>/{command}</span></div>}
            <div className={cl("row")}>
                <div className={cl("gutter")}>
                    {grouped
                        ? <span className={cl("gutter-time")} onClick={jump} title="Show in main window">{date.toLocaleTimeString("en-US", TIME)}</span>
                        : <img className={cl("avatar")} src={a.avatar} alt="" onClick={profile} />}
                </div>
                <div className={cl("body")}>
                    {!grouped && (
                        <div className={cl("meta")}>
                            <span className={cl("name")} style={{ color: a.color }} onClick={profile}>{a.name}</span>
                            {m.author?.bot && <span className={cl("bot-tag")}>{m.author?.discriminator === "0000" ? "WEBHOOK" : "APP"}</span>}
                            {time}
                        </div>
                    )}
                    {m.content && (
                        <div className={cl("content")}>
                            <Markdown content={m.content} channelId={m.channel_id} messageId={m.id} />
                            {m.edited_timestamp && <span className={cl("edited")}> (edited)</span>}
                        </div>
                    )}
                    {!!m.attachments?.length && (
                        <div className={cl("attachments")}>
                            {m.attachments.map(att => <Attachment key={att.id ?? att.url} a={att} />)}
                        </div>
                    )}
                    <Stickers items={m.sticker_items} />
                    {m.embeds?.map((e, i) => <Embed key={i} e={e} channelId={m.channel_id} messageId={m.id} />)}
                    <Reactions reactions={m.reactions} />
                    {m._failed && <div className={cl("error-text")}>Failed to send</div>}
                </div>
            </div>
        </div>
    );
}

function sameDay(a: Date, b: Date) {
    return a.toDateString() === b.toDateString();
}

function canGroup(prev: RawMessage | undefined, m: RawMessage) {
    if (!prev || !NORMAL_TYPES.has(m.type) || !NORMAL_TYPES.has(prev.type)) return false;
    if (m.type === 19 || m.type === 20 || m.type === 23) return false;
    if (prev.author?.id !== m.author?.id) return false;
    const a = new Date(prev.timestamp), b = new Date(m.timestamp);
    return b.getTime() - a.getTime() < GROUP_MS && sameDay(a, b);
}

// ---------------------------------------------------------------- Message list

function MessageList({ channelId, guildId }: { channelId: string; guildId: string | null; }) {
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

    // After loading older messages keep the position, otherwise stick to the bottom
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

    // New messages while reading further up
    useEffect(() => {
        const diff = newCount - seenCount.current;
        seenCount.current = newCount;
        if (diff > 0 && !atBottom.current) setUnseen(u => u + diff);
    }, [newCount]);

    // Late-loading images/embeds: stay at the bottom if you were at the bottom
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
        if (!prev || !sameDay(new Date(prev.timestamp), d)) {
            rows.push(<div key={`day-${m.id}`} className={cl("day")}><span>{formatDay(d)}</span></div>);
        }
        rows.push(
            <ErrorBoundary key={m.id} noop>
                <Message m={m} guildId={guildId} grouped={canGroup(prev, m) && !!prev && sameDay(new Date(prev.timestamp), d)} meId={meId} />
            </ErrorBoundary>
        );
        prev = m;
    }

    return (
        <div className={cl("list-wrap")}>
            <div className={cl("list")} ref={scrollRef} onScroll={onScroll}>
                <div ref={contentRef} className={cl("list-content")}>
                    {!loading && !error && (hasMore
                        ? <div className={cl("load-older")}>
                            <Button variant="gray" small disabled={loadingOlder} onClick={requestOlder}>
                                {loadingOlder ? "Loading …" : "Load older"}
                            </Button>
                        </div>
                        : <div className={cl("list-start")}>Start of the channel</div>)}
                    {rows}
                </div>
                {loading && <div className={cl("center")}><Spinner size={20} /> Loading messages …</div>}
                {error && (
                    <Empty icon={ICONS.warning} title={error}>
                        <Button small onClick={reload}>Try again</Button>
                    </Empty>
                )}
            </div>
            {unseen > 0 && (
                <div className={cl("new-pill")}>
                    <Button small onClick={scrollToBottom}>
                        {unseen === 1 ? "1 new message" : `${unseen} new messages`} ↓
                    </Button>
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------- Input

/** Drafts per channel so moving/hiding loses nothing */
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

    const names = ids.split(",").map(id => {
        const u: any = UserStore.getUser(id);
        return (guildId && GuildMemberStore.getNick(guildId, id)) || u?.globalName || u?.username || "Someone";
    });
    const text = names.length > 3
        ? "Several people are typing …"
        : names.length === 1 ? `${names[0]} is typing …` : `${names.join(", ")} are typing …`;

    return <div className={cl("typing")}><span className={cl("typing-dots")}><i /><i /><i /></span>{text}</div>;
}

function Composer({ channel, name }: { channel: any; name: string; }) {
    const channelId: string = channel.id;
    const [text, setText] = useState(() => drafts.get(channelId) ?? "");
    const ref = useRef<HTMLTextAreaElement>(null);
    const canSend = useCanSend(channel);
    const { showTyping } = settings.use(["showTyping"]);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    }, [text]);

    const update = (v: string) => {
        setText(v);
        if (v) drafts.set(channelId, v);
        else drafts.delete(channelId);
    };

    const send = () => {
        const content = text.trim();
        if (!content || !canSend) return;
        if (content.length > 2000) {
            showToast("Message is too long (max. 2000 characters)", "failure");
            return;
        }

        // Check slowmode beforehand (anyone who can manage messages/channel is exempt)
        const slow = channel.rateLimitPerUser ?? 0;
        const bypass = channel.isPrivate?.()
            || PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, channel)
            || PermissionStore.can(PermissionsBits.MANAGE_CHANNELS, channel);
        if (slow > 0 && !bypass) {
            const left = Math.ceil(((lastSent.get(channelId) ?? 0) + slow * 1000 - Date.now()) / 1000);
            if (left > 0) {
                showToast(`Slowmode: wait ${left} more s`, "failure");
                return;
            }
        }

        lastSent.set(channelId, Date.now());
        update("");
        try {
            Promise.resolve(sendMessage(channelId, { content }, false)).catch((e: any) => {
                logger.error("Message could not be sent", e);
                const slowmode = e?.body?.code === 20016 || e?.status === 429;
                showToast(slowmode ? "Slowmode active – please wait a moment" : "Message could not be sent", "failure");
            });
        } catch (e) {
            logger.error("Message could not be sent", e);
            showToast("Message could not be sent", "failure");
            update(content);
        }
    };

    return (
        <div className={cl("composer")}>
            <div className={classes(cl("input-wrap"), !canSend && cl("input-disabled"))}>
                <textarea
                    ref={ref}
                    className={cl("input")}
                    rows={1}
                    value={canSend ? text : ""}
                    disabled={!canSend}
                    placeholder={canSend ? `Message ${name}` : "You do not have permission to send messages in this channel."}
                    onChange={e => update(e.currentTarget.value)}
                    onKeyDown={e => {
                        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            send();
                        }
                    }}
                />
                {canSend && <Button small onClick={send} disabled={!text.trim()}>Send</Button>}
            </div>
            {showTyping && <TypingLine channelId={channelId} guildId={channel.guild_id ?? null} />}
        </div>
    );
}

// ---------------------------------------------------------------- Panel

export interface PanelProps {
    channelId: string;
    index: number;
    count: number;
    width: number;
    onResizeStart(index: number, e: React.MouseEvent): void;
}

export function Panel({ channelId, index, count, width, onResizeStart }: PanelProps) {
    const info = useChannelInfo(channelId);
    const { channel } = info;
    const guildId: string | null = channel?.guild_id ?? null;
    const title = `${info.prefix}${info.name}`;

    return (
        <section className={cl("panel")} style={{ width }}>
            <div className={cl("divider")} onMouseDown={e => onResizeStart(index, e)} title="Drag to resize" />
            <header className={cl("header")}>
                {info.icon
                    ? <img className={cl("header-icon")} src={info.icon} alt="" />
                    : <div className={classes(cl("header-icon"), cl("header-icon-text"))}>{(info.subtitle || info.name || "?").slice(0, 1)}</div>}
                <div className={cl("header-text")}>
                    <div className={cl("header-name")} title={title}>{title}</div>
                    {info.subtitle && <div className={cl("header-sub")}>{info.subtitle}</div>}
                </div>
                <div className={cl("header-actions")}>
                    <IconButton icon={ICONS.back} label="Move left" disabled={index === 0} onClick={() => movePanel(channelId, -1)} />
                    <IconButton icon={ICONS.chevron} label="Move right" disabled={index >= count - 1} onClick={() => movePanel(channelId, 1)} />
                    <IconButton icon={ICONS.external} label="Open in main window" disabled={!channel} onClick={() => openInMain(channelId, guildId)} />
                    <IconButton icon={ICONS.close} label="Close" destructive onClick={() => closePanel(channelId)} />
                </div>
            </header>
            {channel
                ? <>
                    <ErrorBoundary message="Messages could not be displayed.">
                        <MessageList channelId={channelId} guildId={guildId} />
                    </ErrorBoundary>
                    <Composer key={channelId} channel={channel} name={title} />
                </>
                : <Empty icon={ICONS.warning} title="This channel is no longer available.">
                    <Button small onClick={() => closePanel(channelId)}>Close panel</Button>
                </Empty>}
        </section>
    );
}
