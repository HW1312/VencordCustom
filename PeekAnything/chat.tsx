/*
 * PeekAnything – read-only chat preview
 * Messages come straight from the REST API (GET /channels/:id/messages). Nothing here touches read states:
 * no CHANNEL_SELECT, no ack, no MessageStore loading – the channel stays unread.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import {
    ChannelStore, Constants, FluxDispatcher, GuildMemberStore, IconUtils, NavigationRouter, Parser, RestAPI, useEffect, useLayoutEffect, useMemo, useRef, UserStore, useState
} from "@webpack/common";

// Bot buttons, selects and "Components V2" layouts (which many bots use instead of embeds now)
import { MessageComponents } from "../ChatPopout/components";
import { cl, logger } from "./index";

const PAGE = 40;
const CACHE_MS = 60_000;
const CDN = "https://cdn.discordapp.com";
const GROUP_MS = 7 * 60 * 1000;

// ---------------------------------------------------------------- Loading

interface Loaded {
    messages: any[];
    time: number;
}

/** Short cache so peeking the same channel twice is instant */
const cache = new Map<string, Loaded>();

const cacheKey = (channelId: string, around?: string) => `${channelId}:${around ?? ""}`;

async function fetchMessages(channelId: string, around?: string): Promise<any[]> {
    const { body } = await RestAPI.get({
        url: Constants.Endpoints.MESSAGES(channelId),
        query: around ? { limit: PAGE, around } : { limit: PAGE },
        retries: 1
    });
    return Array.isArray(body) ? body.slice().sort((a: any, b: any) => compareIds(a.id, b.id)) : [];
}

function compareIds(a: string, b: string) {
    return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function describeError(e: any) {
    const status = e?.status ?? e?.statusCode;
    if (status === 403) return "No access to this channel.";
    if (status === 404) return "Channel or message not found.";
    if (status === 429) return "Too many requests, try again in a moment.";
    return "Messages could not be loaded.";
}

function useMessages(channelId: string, around?: string) {
    const key = cacheKey(channelId, around);
    const cached = cache.get(key);
    const fresh = cached && Date.now() - cached.time < CACHE_MS ? cached.messages : null;
    const [messages, setMessages] = useState<any[] | null>(fresh);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const hit = cache.get(key);
        if (hit && Date.now() - hit.time < CACHE_MS) {
            setMessages(hit.messages);
            return;
        }
        setMessages(null);
        setError(null);
        fetchMessages(channelId, around).then(list => {
            cache.set(key, { messages: list, time: Date.now() });
            if (!cancelled) setMessages(list);
        }).catch(e => {
            if (!cancelled) setError(describeError(e));
        });
        return () => { cancelled = true; };
    }, [key]);

    // New messages while the preview is open (the latest page only)
    useEffect(() => {
        if (around) return;
        const onCreate = (e: any) => {
            const msg = e?.message;
            if (e?.optimistic || !msg || (e.channelId ?? msg.channel_id) !== channelId) return;
            setMessages(prev => {
                if (!prev || prev.some(m => m.id === msg.id)) return prev;
                const next = [...prev, msg];
                cache.set(key, { messages: next, time: Date.now() });
                return next;
            });
        };
        FluxDispatcher.subscribe("MESSAGE_CREATE", onCreate);
        return () => FluxDispatcher.unsubscribe("MESSAGE_CREATE", onCreate);
    }, [key]);

    return { messages, error };
}

// ---------------------------------------------------------------- Helpers

function authorInfo(author: any, guildId: string | null) {
    const id: string = author?.id ?? "0";
    const member = guildId ? GuildMemberStore.getMember(guildId, id) : null;
    const name: string = member?.nick || author?.global_name || author?.globalName || author?.username || "Unknown";
    const user = UserStore.getUser(id);
    const avatar = user && !author?.bot
        ? IconUtils.getUserAvatarURL(user, false, 48)
        : author?.avatar ? `${CDN}/avatars/${id}/${author.avatar}.webp?size=48` : IconUtils.getDefaultAvatarURL(id, author?.discriminator);
    return { name, color: member?.colorString ?? undefined, avatar };
}

const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

function formatTime(d: Date) {
    const now = new Date();
    const time = d.toLocaleTimeString("en-US", TIME);
    if (d.toDateString() === now.toDateString()) return time;
    return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

/** Normal messages (text, reply, commands) – everything else is a system line */
const NORMAL_TYPES = new Set([0, 19, 20, 23]);

function Markdown({ content, channelId, messageId }: { content: string; channelId: string; messageId: string; }) {
    const nodes = useMemo(() => {
        try {
            return Parser.parse(content, true, { channelId, messageId, allowLinks: true, allowEmojiLinks: true, viewingChannelId: channelId });
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

function fitBox(w?: number, h?: number, maxW = 220, maxH = 140) {
    if (!w || !h) return { width: undefined, height: undefined };
    const s = Math.min(1, maxW / w, maxH / h);
    return { width: Math.round(w * s), height: Math.round(h * s) };
}

function sized(url: string, w: number, h: number) {
    return `${url}${url.includes("?") ? "&" : "?"}width=${Math.round(w)}&height=${Math.round(h)}`;
}

// ---------------------------------------------------------------- Message parts

function Attachment({ a }: { a: any; }) {
    const type: string = a.content_type ?? "";
    const isImage = type.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif)$/i.test(a.filename ?? "");
    const box = fitBox(a.width, a.height);
    if (isImage && (a.proxy_url || a.url)) {
        const src = a.proxy_url && box.width ? sized(a.proxy_url, box.width * 2, box.height! * 2) : (a.proxy_url ?? a.url);
        return <img className={cl("image")} src={src} alt={a.filename} width={box.width} height={box.height} loading="lazy" />;
    }
    return (
        <a className={cl("file")} href={a.url} target="_blank" rel="noreferrer noopener">
            {type.startsWith("video/") ? "Video: " : "File: "}{a.filename}
        </a>
    );
}

const clip = (text: string, max: number) => text.length > max ? text.slice(0, max) + "…" : text;

function Embed({ e, channelId, messageId }: { e: any; channelId: string; messageId: string; }) {
    const thumb = e.thumbnail ?? null;
    const image = e.image ?? null;
    if ((e.type === "image" || e.type === "gifv") && thumb) {
        const box = fitBox(thumb.width, thumb.height);
        return <img className={cl("image")} src={thumb.proxy_url ?? thumb.url} width={box.width} height={box.height} loading="lazy" alt="" />;
    }
    const fields: any[] = e.fields ?? [];
    if (!e.title && !e.description && !e.author?.name && !image && !thumb && !fields.length && !e.footer?.text) return null;
    const color = typeof e.color === "number" ? `#${e.color.toString(16).padStart(6, "0")}` : undefined;
    const box = image ? fitBox(image.width, image.height) : null;
    const md = (text: string, max: number) => <Markdown content={clip(text, max)} channelId={channelId} messageId={messageId} />;

    return (
        <div className={cl("embed")} style={color ? { borderLeftColor: color } : undefined}>
            <div className={cl("embed-main")}>
                <div className={cl("embed-text")}>
                    {e.author?.name && (
                        <div className={cl("embed-author")}>
                            {e.author.icon_url && <img className={cl("embed-author-icon")} src={e.author.proxy_icon_url ?? e.author.icon_url} alt="" />}
                            {e.author.name}
                        </div>
                    )}
                    {e.title && (
                        <div className={cl("embed-title")}>
                            {e.url ? <a href={e.url} target="_blank" rel="noreferrer noopener">{md(e.title, 200)}</a> : md(e.title, 200)}
                        </div>
                    )}
                    {e.description && <div className={cl("embed-desc")}>{md(e.description, 600)}</div>}
                    {fields.length > 0 && (
                        <div className={cl("embed-fields")}>
                            {fields.slice(0, 10).map((f, i) => (
                                <div key={i} className={classes(cl("embed-field"), f.inline && cl("embed-field-inline"))}>
                                    <div className={cl("embed-field-name")}>{md(f.name ?? "", 120)}</div>
                                    <div className={cl("embed-field-value")}>{md(f.value ?? "", 300)}</div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                {thumb && !image && <img className={cl("embed-thumb")} src={thumb.proxy_url ?? thumb.url} alt="" loading="lazy" />}
            </div>
            {image && <img className={cl("image")} src={image.proxy_url ?? image.url} width={box?.width} height={box?.height} loading="lazy" alt="" />}
            {e.footer?.text && <div className={cl("embed-footer")}>{clip(e.footer.text, 120)}</div>}
        </div>
    );
}

function jumpTo(m: any) {
    const guildId = ChannelStore.getChannel(m.channel_id)?.guild_id ?? "@me";
    NavigationRouter.transitionTo(`/channels/${guildId}/${m.channel_id}/${m.id}`);
}

function Reactions({ reactions }: { reactions?: any[]; }) {
    if (!reactions?.length) return null;
    return (
        <div className={cl("reactions")}>
            {reactions.map(r => (
                <span key={r.emoji.id ?? r.emoji.name} className={cl("reaction")}>
                    {r.emoji.id
                        ? <img src={`${CDN}/emojis/${r.emoji.id}.${r.emoji.animated ? "gif" : "webp"}?size=32`} alt={r.emoji.name} />
                        : <span>{r.emoji.name}</span>}
                    {r.count}
                </span>
            ))}
        </div>
    );
}

function ReplyLine({ m, guildId }: { m: any; guildId: string | null; }) {
    const ref = m.referenced_message;
    if (!ref) return <div className={cl("reply")}>Original message was deleted</div>;
    const a = authorInfo(ref.author, guildId);
    const text = (ref.content || (ref.attachments?.length ? "Attachment" : "Embed")).replace(/\s+/g, " ");
    return (
        <div className={cl("reply")}>
            <span className={cl("reply-name")} style={{ color: a.color }}>{a.name}</span>
            <span className={cl("reply-text")}>{text.length > 90 ? text.slice(0, 90) + "…" : text}</span>
        </div>
    );
}

// ---------------------------------------------------------------- Message

function Message({ m, guildId, grouped, highlight }: { m: any; guildId: string | null; grouped: boolean; highlight: boolean; }) {
    const a = authorInfo(m.author, guildId);
    const date = new Date(m.timestamp);

    if (!NORMAL_TYPES.has(m.type)) {
        return (
            <div data-peek-id={m.id} className={classes(cl("msg"), cl("system"), highlight && cl("highlight"))}>
                <span className={cl("name")} style={{ color: a.color }}>{a.name}</span> <span className={cl("muted")}>system message</span>
            </div>
        );
    }

    return (
        <div data-peek-id={m.id} className={classes(cl("msg"), !grouped && cl("msg-start"), highlight && cl("highlight"))}>
            {m.type === 19 && <ReplyLine m={m} guildId={guildId} />}
            <div className={cl("msg-row")}>
                <div className={cl("gutter")}>{!grouped && <img className={cl("avatar")} src={a.avatar} alt="" />}</div>
                <div className={cl("msg-body")}>
                    {!grouped && (
                        <div className={cl("meta")}>
                            <span className={cl("name")} style={{ color: a.color }}>{a.name}</span>
                            {m.author?.bot && <span className={cl("tag")}>APP</span>}
                            <span className={cl("time")}>{formatTime(date)}</span>
                        </div>
                    )}
                    {m.content && (
                        <div className={cl("content")}>
                            <Markdown content={m.content} channelId={m.channel_id} messageId={m.id} />
                            {m.edited_timestamp && <span className={cl("muted")}> (edited)</span>}
                        </div>
                    )}
                    {m.attachments?.map((att: any) => <Attachment key={att.id ?? att.url} a={att} />)}
                    {m.sticker_items?.map((s: any) => <span key={s.id} className={cl("muted")}>[Sticker: {s.name}]</span>)}
                    {m.embeds?.slice(0, 3).map((e: any, i: number) => <Embed key={i} e={e} channelId={m.channel_id} messageId={m.id} />)}
                    {m.components?.length > 0 && (
                        <ErrorBoundary noop>
                            <div className={cl("components")}>
                                <MessageComponents
                                    components={m.components}
                                    ctx={{ message: m, open: url => window.open(url, "_blank", "noopener"), jump: () => jumpTo(m) }}
                                />
                            </div>
                        </ErrorBoundary>
                    )}
                    <Reactions reactions={m.reactions} />
                </div>
            </div>
        </div>
    );
}

function canGroup(prev: any, m: any) {
    if (!prev || !NORMAL_TYPES.has(m.type) || !NORMAL_TYPES.has(prev.type) || m.type !== 0) return false;
    if (prev.author?.id !== m.author?.id) return false;
    const a = new Date(prev.timestamp), b = new Date(m.timestamp);
    return b.getTime() - a.getTime() < GROUP_MS && a.toDateString() === b.toDateString();
}

// ---------------------------------------------------------------- List

export function ChatPreview({ channelId, guildId, messageId }: { channelId: string; guildId: string | null; messageId?: string; }) {
    const { messages, error } = useMessages(channelId, messageId);
    const scrollRef = useRef<HTMLDivElement>(null);
    const placed = useRef(false);

    // Start at the bottom, or centered on the linked message
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el || !messages) return;
        if (messageId && !placed.current) {
            const row = el.querySelector(`[data-peek-id="${messageId}"]`) as HTMLElement | null;
            if (row) el.scrollTop = row.offsetTop - el.clientHeight / 2 + row.offsetHeight / 2;
            placed.current = true;
            return;
        }
        if (!messageId) {
            const nearBottom = !placed.current || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            if (nearBottom) el.scrollTop = el.scrollHeight;
            placed.current = true;
        }
    }, [messages, messageId]);

    // Late images: keep the position
    useEffect(() => {
        const el = scrollRef.current;
        const content = el?.firstElementChild;
        if (!el || !content) return;
        let lastHeight = el.scrollHeight;
        const ro = new ResizeObserver(() => {
            if (messageId) {
                const row = el.querySelector(`[data-peek-id="${messageId}"]`) as HTMLElement | null;
                if (row) el.scrollTop = row.offsetTop - el.clientHeight / 2 + row.offsetHeight / 2;
            } else if (lastHeight - el.scrollTop - el.clientHeight < 80) {
                el.scrollTop = el.scrollHeight;
            }
            lastHeight = el.scrollHeight;
        });
        ro.observe(content);
        // Only while images load; afterwards the user may scroll freely
        const stop = setTimeout(() => ro.disconnect(), 2500);
        return () => {
            clearTimeout(stop);
            ro.disconnect();
        };
    }, [messages != null, messageId]);

    if (error) return <div className={cl("center")}>{error}</div>;
    if (!messages) return <div className={cl("center")}><span className={cl("spinner")} /></div>;
    if (!messages.length) return <div className={cl("center")}>No messages yet.</div>;

    const rows: React.ReactElement[] = [];
    let prev: any;
    for (const m of messages) {
        rows.push(
            <ErrorBoundary key={m.id} noop>
                <Message m={m} guildId={guildId} grouped={canGroup(prev, m)} highlight={m.id === messageId} />
            </ErrorBoundary>
        );
        prev = m;
    }

    return (
        <div className={cl("scroll")} ref={scrollRef}>
            <div className={cl("list")}>{rows}</div>
        </div>
    );
}
