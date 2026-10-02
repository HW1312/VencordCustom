/*
 * PeekAnything – what is under the mouse?
 * Detection is DOM based (stable attributes + React props of the hovered element), no webpack patches.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationStreamingStore, ChannelStore, MessageStore, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";

import { settings } from "./index";

// ---------------------------------------------------------------- Types

export type Target =
    | { kind: "chat"; channelId: string; messageId?: string; }
    | { kind: "stream"; userId: string; channelId: string; guildId: string | null; streamKey: string; }
    | { kind: "voice"; channelId: string; }
    /** The streams of your own call (nothing specific hovered) */
    | { kind: "call"; };

export interface Hit {
    target: Target;
    /** Element the card is placed next to */
    anchor: Element | null;
}

export function targetKey(t: Target | null | undefined) {
    if (!t) return "";
    switch (t.kind) {
        case "chat": return `chat:${t.channelId}:${t.messageId ?? ""}`;
        case "stream": return `stream:${t.streamKey}`;
        case "voice": return `voice:${t.channelId}`;
        case "call": return "call";
    }
}

// ---------------------------------------------------------------- Helpers

export const VOICE_TYPES = new Set([2, 13]);
/** Categories, directories, forums & media channels have no chat of their own */
const NO_CHAT_TYPES = new Set([4, 14, 15, 16]);

const MESSAGE_URL = /^https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(@me|\d+)\/(\d+)(?:\/(\d+))?/;
const RELATIVE_CHANNEL = /^\/channels\/(@me|\d+)\/(\d+)(?:\/(\d+))?/;
/** Tokens that Discord renders as a ".channelMention" pill inside message content */
const PILL_TOKENS = /<#(\d+)>|https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(?:@me|\d+)\/(\d+)(?:\/(\d+))?/g;

export function encodeStreamKey(s: any): string | null {
    if (!s?.ownerId || !s?.channelId) return null;
    return s.streamType === "guild" || s.guildId
        ? `guild:${s.guildId}:${s.channelId}:${s.ownerId}`
        : `call:${s.channelId}:${s.ownerId}`;
}

/** Stream of a user in that voice channel, if they are live (never your own) */
export function streamFor(userId: string, channelId: string): Extract<Target, { kind: "stream"; }> | null {
    if (userId === UserStore.getCurrentUser()?.id) return null;
    const guildId: string | null = ChannelStore.getChannel(channelId)?.guild_id ?? null;
    const stream: any = ApplicationStreamingStore.getStreamForUser(userId, guildId) ?? ApplicationStreamingStore.getAnyStreamForUser(userId);
    if (!stream || stream.channelId !== channelId) return null;
    const streamKey = encodeStreamKey(stream);
    return streamKey ? { kind: "stream", userId, channelId, guildId, streamKey } : null;
}

/** Live streams in a voice channel (without your own) */
export function streamsIn(channelId: string | null | undefined) {
    if (!channelId) return [];
    const me = UserStore.getCurrentUser()?.id;
    const list: Extract<Target, { kind: "stream"; }>[] = [];
    for (const s of ApplicationStreamingStore.getAllApplicationStreamsForChannel(channelId) ?? []) {
        if (!s?.ownerId || s.ownerId === me) continue;
        const t = streamFor(s.ownerId, channelId);
        if (t && !list.some(x => x.streamKey === t.streamKey)) list.push(t);
    }
    return list;
}

function channelTarget(channelId: string, messageId?: string): Target | null {
    const channel = ChannelStore.getChannel(channelId);
    const s = settings.store;
    if (!channel) {
        // Message links into channels we don't know (yet) still get a chance, the API decides
        return messageId && s.messageLinks ? { kind: "chat", channelId, messageId } : null;
    }
    if (VOICE_TYPES.has(channel.type) && !messageId) return s.voiceChannels ? { kind: "voice", channelId } : null;
    if (NO_CHAT_TYPES.has(channel.type)) return null;
    if (messageId) return s.messageLinks ? { kind: "chat", channelId, messageId } : null;
    // Peeking the channel you are looking at is pointless
    if (channelId === SelectedChannelStore.getChannelId()) return null;
    return s.channels ? { kind: "chat", channelId } : null;
}

function reactFiber(el: Element): any {
    for (const key in el) {
        if (key.startsWith("__reactFiber$")) return (el as any)[key];
    }
    return null;
}

/** Inside the channel list of the sidebar (and not somewhere in the chat) */
function inChannelList(el: Element) {
    let node: Element | null = el;
    for (let i = 0; node && i < 14; i++, node = node.parentElement) {
        if (node.querySelector('[data-list-item-id^="channels___"], a[href^="/channels/"]')) {
            return !node.querySelector('li[id^="chat-messages-"], [class*="channelTextArea_"]');
        }
    }
    return false;
}

// ---------------------------------------------------------------- Message links

function messageUrlTarget(href: string | null): Target | null {
    const m = href ? MESSAGE_URL.exec(href) : null;
    if (!m) return null;
    return channelTarget(m[2], m[3]);
}

/**
 * Discord renders message and channel links in messages as ".channelMention" pills without an href.
 * Map the hovered pill to the n-th link token of the message content.
 */
function pillTarget(pill: Element): Target | null {
    const item = pill.closest('li[id^="chat-messages-"]');
    const content = pill.closest('[id^="message-content-"]');
    if (!item || !content) return null;
    const ids = /^chat-messages-(\d+)-(\d+)$/.exec(item.id);
    if (!ids) return null;
    const message: any = MessageStore.getMessage(ids[1], ids[2]);
    const text: string = message?.content ?? "";
    if (!text) return null;

    const tokens = [...text.matchAll(PILL_TOKENS)];
    const pills = [...content.querySelectorAll(".channelMention")];
    let token: RegExpMatchArray | undefined;
    if (pills.length === tokens.length) token = tokens[pills.indexOf(pill)];
    else {
        // Counts differ (e.g. links inside code blocks): only safe with exactly one message link
        const links = tokens.filter(t => t[3]);
        if (links.length === 1) token = links[0];
    }
    if (!token) return null;
    if (token[1]) return channelTarget(token[1]);
    return channelTarget(token[2], token[3]);
}

// ---------------------------------------------------------------- Voice users

/** Walks up the React tree of a hovered sidebar row: user row inside a voice channel, or the voice channel itself */
function voiceFromFiber(el: Element): Target | null {
    let fiber = reactFiber(el);
    let userId: string | null = null;
    for (let i = 0; fiber && i < 30; i++, fiber = fiber.return) {
        const p = fiber.memoizedProps;
        if (!p || typeof p !== "object") continue;
        if (!userId && typeof p.user?.id === "string" && "username" in p.user) userId = p.user.id;
        const channel = p.channel?.id && typeof p.channel.type === "number"
            ? p.channel
            : typeof p.channelId === "string" ? ChannelStore.getChannel(p.channelId) : null;
        if (!channel) continue;
        if (!VOICE_TYPES.has(channel.type)) return null;

        if (userId && VoiceStateStore.getVoiceStateForUser(userId)?.channelId === channel.id) {
            const stream = streamFor(userId, channel.id);
            if (stream) return settings.store.streams ? stream : null;
        }
        return settings.store.voiceChannels ? { kind: "voice", channelId: channel.id } : null;
    }
    return null;
}

// ---------------------------------------------------------------- Resolve

/** What the element under the mouse stands for; null = nothing specific */
export function resolveTarget(el: Element | null): Hit | null {
    if (!el || el.closest(".vc-peek-root")) return null;

    // 1. Message links (real anchors, e.g. masked links and embeds)
    const anchor = el.closest("a[href]") as HTMLAnchorElement | null;
    const href = anchor?.getAttribute("href") ?? null;
    if (anchor && href && /^https?:/.test(href)) {
        const t = messageUrlTarget(href);
        return t ? { target: t, anchor } : null;
    }

    // 2. Message/channel link pills in message content
    const pill = el.closest(".channelMention");
    if (pill) {
        const t = pillTarget(pill);
        return t ? { target: t, anchor: pill } : null;
    }

    // 3. Voice users & voice channels in the channel list
    if (inChannelList(el)) {
        const t = voiceFromFiber(el);
        if (t) {
            const row = el.closest("[data-list-item-id], [role='button'], a, li") ?? el;
            return { target: t, anchor: row };
        }
    }

    // 4. Channels, threads & DMs (sidebar / DM list)
    if (anchor && href) {
        const m = RELATIVE_CHANNEL.exec(href);
        if (m) {
            const t = channelTarget(m[2], m[3]);
            return t ? { target: t, anchor } : null;
        }
    }
    const item = el.closest('[data-list-item-id^="channels___"], [data-list-item-id^="private-channels-"]');
    const id = item?.getAttribute("data-list-item-id")?.split("___")[1];
    if (item && id && /^\d+$/.test(id)) {
        const t = channelTarget(id);
        return t ? { target: t, anchor: item } : null;
    }
    return null;
}

/** "Nothing hovered": the streams of the call you are in */
export function callHit(): Hit | null {
    if (!settings.store.callStreams) return null;
    return streamsIn(SelectedChannelStore.getVoiceChannelId()).length ? { target: { kind: "call" }, anchor: null } : null;
}
