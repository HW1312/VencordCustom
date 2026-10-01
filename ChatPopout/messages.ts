/*
 * ChatPopout – load messages & keep them updated live
 * History via REST (throttled), live updates via Flux events. Nothing is marked as read.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Constants, RestAPI, useCallback, useEffect, useRef, UserStore, useState } from "@webpack/common";

export const PAGE_SIZE = 50;

// ---------------------------------------------------------------- Types

/** Raw message object (API format, same as in Flux events) */
export interface RawMessage {
    id: string;
    channel_id: string;
    type: number;
    content: string;
    author: any;
    timestamp: string;
    edited_timestamp?: string | null;
    attachments?: any[];
    embeds?: any[];
    reactions?: RawReaction[];
    mentions?: any[];
    mention_everyone?: boolean;
    referenced_message?: RawMessage | null;
    message_reference?: { message_id?: string; channel_id?: string; guild_id?: string; };
    sticker_items?: { id: string; name: string; format_type: number; }[];
    nonce?: string;
    /** Local: sent but not confirmed yet */
    _pending?: boolean;
    /** Local: sending failed */
    _failed?: boolean;
}

export interface RawReaction {
    emoji: { id: string | null; name: string; animated?: boolean; };
    count: number;
    me?: boolean;
}

export type ChannelEvent =
    | { type: "create"; message: any; optimistic: boolean; }
    | { type: "update"; message: any; }
    | { type: "delete"; ids: string[]; }
    | { type: "failed"; id: string; }
    | { type: "reaction"; messageId: string; userId: string; emoji: any; delta: 1 | -1; }
    | { type: "reactionClear"; messageId: string; emoji?: any; };

// ---------------------------------------------------------------- Events

const listeners = new Map<string, Set<(e: ChannelEvent) => void>>();

export function emitChannelEvent(channelId: string | undefined, event: ChannelEvent) {
    if (!channelId) return;
    listeners.get(channelId)?.forEach(fn => {
        try {
            fn(event);
        } catch { /* One broken window must not affect the others */ }
    });
}

function subscribe(channelId: string, fn: (e: ChannelEvent) => void) {
    let set = listeners.get(channelId);
    if (!set) listeners.set(channelId, set = new Set());
    set.add(fn);
    return () => {
        set!.delete(fn);
        if (!set!.size) listeners.delete(channelId);
    };
}

// ---------------------------------------------------------------- Loading (throttled)

const MIN_GAP = 800;
let chain: Promise<unknown> = Promise.resolve();
let lastFetch = 0;

/** All history requests run one after another, at least 800 ms apart */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
        const wait = lastFetch + MIN_GAP - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastFetch = Date.now();
        return fn();
    });
    chain = run.catch(() => { });
    return run;
}

async function fetchMessages(channelId: string, before?: string): Promise<RawMessage[]> {
    const { body } = await throttled(() => RestAPI.get({
        url: Constants.Endpoints.MESSAGES(channelId),
        query: before ? { limit: PAGE_SIZE, before } : { limit: PAGE_SIZE },
        retries: 1
    }));
    return Array.isArray(body) ? (body as RawMessage[]).slice().reverse() : [];
}

function describeError(e: any) {
    const status = e?.status ?? e?.statusCode;
    if (status === 403) return "No access to this channel.";
    if (status === 404) return "Channel not found.";
    if (status === 429) return "Too many requests – please wait a moment.";
    return e?.body?.message || "Couldn't load messages.";
}

// ---------------------------------------------------------------- Helpers

const emojiKey = (emoji: any) => emoji?.id || emoji?.name || "";

function applyReaction(m: RawMessage, e: Extract<ChannelEvent, { type: "reaction"; }>): RawMessage {
    const isMe = e.userId === UserStore.getCurrentUser()?.id;
    const key = emojiKey(e.emoji);
    const reactions = (m.reactions ?? []).slice();
    const i = reactions.findIndex(r => emojiKey(r.emoji) === key);

    if (e.delta > 0) {
        // Own reactions arrive optimistically and again from the server – count them only once
        if (i >= 0 && isMe && reactions[i].me) return m;
        if (i >= 0) reactions[i] = { ...reactions[i], count: reactions[i].count + 1, me: reactions[i].me || isMe };
        else reactions.push({ emoji: e.emoji, count: 1, me: isMe });
    } else {
        if (i < 0 || (isMe && !reactions[i].me)) return m;
        const count = reactions[i].count - 1;
        if (count <= 0) reactions.splice(i, 1);
        else reactions[i] = { ...reactions[i], count, me: isMe ? false : reactions[i].me };
    }
    return { ...m, reactions };
}

/** Optimistic messages sometimes contain user records instead of API objects – normalize them */
function normalize(msg: any, optimistic = false): RawMessage {
    const ts = msg.timestamp;
    return {
        ...msg,
        channel_id: msg.channel_id ?? msg.channelId,
        timestamp: typeof ts === "string" ? ts : new Date(ts?.valueOf?.() ?? Date.now()).toISOString(),
        attachments: msg.attachments ?? [],
        embeds: msg.embeds ?? [],
        reactions: msg.reactions ?? [],
        _pending: optimistic
    };
}

// ---------------------------------------------------------------- Hook

export interface ChannelMessages {
    messages: RawMessage[];
    loading: boolean;
    loadingOlder: boolean;
    hasMore: boolean;
    error: string | null;
    /** Counter that increases with every newly arrived message */
    newCount: number;
    loadOlder(): void;
    reload(): void;
}

export function useChannelMessages(channelId: string): ChannelMessages {
    const [messages, setMessages] = useState<RawMessage[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [newCount, setNewCount] = useState(0);
    const [reloadKey, setReloadKey] = useState(0);

    const messagesRef = useRef(messages);
    messagesRef.current = messages;
    const busyRef = useRef(false);
    const aliveRef = useRef(true);

    useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
    }, []);

    // Initial load
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        setMessages([]);
        setHasMore(true);
        fetchMessages(channelId).then(list => {
            if (cancelled) return;
            // Keep live messages that arrived while loading
            setMessages(prev => {
                const known = new Set(list.map(m => m.id));
                return [...list, ...prev.filter(m => !known.has(m.id))];
            });
            setHasMore(list.length >= PAGE_SIZE);
        }).catch(e => {
            if (!cancelled) setError(describeError(e));
        }).finally(() => {
            if (!cancelled) setLoading(false);
        });
        return () => { cancelled = true; };
    }, [channelId, reloadKey]);

    // Live updates
    useEffect(() => subscribe(channelId, e => {
        switch (e.type) {
            case "create": {
                // Discord doesn't always flag its local copy as optimistic – it is recognizable by the
                // "SENDING" state or by its id being the nonce (the server assigns a real id)
                const optimistic = e.optimistic || e.message.state === "SENDING" || (!!e.message.nonce && e.message.id === e.message.nonce);
                const msg = normalize(e.message, optimistic);
                setMessages(prev => {
                    if (prev.some(m => m.id === msg.id)) return prev;
                    // Replace the locally shown copy of an own message with the server's confirmation
                    if (msg.nonce && !optimistic) {
                        const i = prev.findIndex(m => m.id === msg.nonce || (m._pending && m.nonce === msg.nonce));
                        if (i >= 0) {
                            const next = prev.slice();
                            next[i] = msg;
                            return next;
                        }
                    }
                    return [...prev, msg];
                });
                if (!optimistic) setNewCount(c => c + 1);
                break;
            }
            case "update":
                setMessages(prev => prev.map(m => m.id === e.message.id ? { ...m, ...e.message, _pending: false } : m));
                break;
            case "delete": {
                const ids = new Set(e.ids);
                setMessages(prev => prev.some(m => ids.has(m.id)) ? prev.filter(m => !ids.has(m.id)) : prev);
                break;
            }
            case "failed":
                setMessages(prev => prev.map(m => m.id === e.id ? { ...m, _pending: false, _failed: true } : m));
                break;
            case "reaction":
                setMessages(prev => prev.map(m => m.id === e.messageId ? applyReaction(m, e) : m));
                break;
            case "reactionClear":
                setMessages(prev => prev.map(m => m.id !== e.messageId ? m : {
                    ...m,
                    reactions: e.emoji ? (m.reactions ?? []).filter(r => emojiKey(r.emoji) !== emojiKey(e.emoji)) : []
                }));
                break;
        }
    }), [channelId]);

    const loadOlder = useCallback(() => {
        const oldest = messagesRef.current.find(m => !m._pending);
        if (busyRef.current || !oldest) return;
        busyRef.current = true;
        setLoadingOlder(true);
        fetchMessages(channelId, oldest.id).then(list => {
            if (!aliveRef.current) return;
            setMessages(prev => {
                const known = new Set(prev.map(m => m.id));
                return [...list.filter(m => !known.has(m.id)), ...prev];
            });
            setHasMore(list.length >= PAGE_SIZE);
        }).catch(e => {
            if (aliveRef.current) setError(describeError(e));
        }).finally(() => {
            busyRef.current = false;
            if (aliveRef.current) setLoadingOlder(false);
        });
    }, [channelId]);

    const reload = useCallback(() => setReloadKey(k => k + 1), []);

    return { messages, loading, loadingOlder, hasMore, error, newCount, loadOlder, reload };
}
