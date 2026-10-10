/*
 * MessageSelect – selection state, highlight style & message helpers
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel, Message } from "@vencord/discord-types";
import { ChannelStore, GuildMemberStore, GuildRoleStore, MessageStore, PermissionsBits, PermissionStore, UserStore } from "@webpack/common";

// ---------------------------------------------------------------- State

export interface Busy {
    label: string;
    done: number;
    total: number;
    cancelled: boolean;
}

interface SelectionState {
    channelId: string | null;
    ids: Set<string>;
    /** Last clicked message, start of Shift+click ranges */
    anchor: string | null;
    /** Messages that were selected from somewhere without a loaded MessageStore entry (e.g. search results) */
    cache: Map<string, Message>;
    busy: Busy | null;
}

export const state: SelectionState = {
    channelId: null,
    ids: new Set(),
    anchor: null,
    cache: new Map(),
    busy: null
};

const listeners = new Set<() => void>();
let version = 0;

export const getVersion = () => version;

export function subscribe(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

export function emit() {
    version++;
    updateHighlight();
    listeners.forEach(fn => {
        try { fn(); } catch { /* listener errors must not break the selection */ }
    });
}

export const isActive = () => state.ids.size > 0;

// ---------------------------------------------------------------- Snowflakes

export function compareIds(a: string, b: string) {
    return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

// ---------------------------------------------------------------- Mutations

function resetTo(channelId: string) {
    if (state.channelId !== channelId) {
        state.ids.clear();
        state.cache.clear();
        state.anchor = null;
    }
    state.channelId = channelId;
}

function remember(message?: Message | null) {
    if (message?.id) state.cache.set(message.id, message);
}

export function toggle(channelId: string, messageId: string, message?: Message) {
    resetTo(channelId);
    remember(message);
    if (state.ids.has(messageId)) state.ids.delete(messageId);
    else state.ids.add(messageId);
    state.anchor = messageId;
    if (!state.ids.size) state.channelId = null;
    emit();
}

export function select(channelId: string, messageId: string, message?: Message) {
    resetTo(channelId);
    remember(message);
    state.ids.add(messageId);
    state.anchor = messageId;
    emit();
}

/** Selects all loaded messages between the anchor and the given message (inclusive) */
export function selectRange(channelId: string, messageId: string, message?: Message) {
    if (state.channelId !== channelId || !state.anchor) return select(channelId, messageId, message);

    remember(message);
    const ordered = loadedMessages(channelId);
    const from = ordered.findIndex(m => m.id === state.anchor);
    const to = ordered.findIndex(m => m.id === messageId);
    if (from < 0 || to < 0) return select(channelId, messageId, message);

    const [start, end] = from < to ? [from, to] : [to, from];
    for (let i = start; i <= end; i++) state.ids.add(ordered[i].id);
    state.anchor = messageId;
    emit();
}

export function remove(channelId: string, ids: string[]) {
    if (state.channelId !== channelId) return;
    let changed = false;
    for (const id of ids) {
        if (state.ids.delete(id)) changed = true;
        state.cache.delete(id);
    }
    if (!changed) return;
    if (!state.ids.size && !state.busy) state.channelId = null;
    emit();
}

export function clear() {
    if (state.busy) state.busy.cancelled = true;
    state.ids.clear();
    state.cache.clear();
    state.anchor = null;
    state.channelId = null;
    state.busy = null;
    emit();
}

/** Stops a running delete/forward but keeps the selection */
export function cancelBusy() {
    if (state.busy) state.busy.cancelled = true;
    emit();
}

export function setBusy(busy: Busy | null) {
    state.busy = busy;
    emit();
}

// ---------------------------------------------------------------- Messages

/** Loaded messages of a channel, oldest first */
export function loadedMessages(channelId: string): Message[] {
    const out: Message[] = [];
    try {
        MessageStore.getMessages(channelId)?.forEach(m => void out.push(m));
    } catch { /* channel not loaded */ }
    return out;
}

/** The selected messages, oldest first. Prefers the current MessageStore version (edits). */
export function getSelectedMessages(): Message[] {
    const { channelId } = state;
    if (!channelId) return [];
    return [...state.ids]
        .sort(compareIds)
        .map(id => MessageStore.getMessage(channelId, id) ?? state.cache.get(id))
        .filter((m): m is Message => !!m);
}

export const getChannel = (): Channel | undefined => state.channelId ? ChannelStore.getChannel(state.channelId) : undefined;

/** Message types that cannot be deleted by anyone (recipient changes, calls, channel name changes, thread starters ...) */
const UNDELETABLE_TYPES = new Set([1, 2, 3, 4, 5, 14, 15, 16, 17, 21]);

export function canDelete(message: Message, channel: Channel | undefined) {
    if (!message || UNDELETABLE_TYPES.has(message.type)) return false;
    if ((message as any).state && (message as any).state !== "SENT") return false;
    if (message.author?.id === UserStore.getCurrentUser()?.id) return true;
    if (!channel || channel.isPrivate?.()) return false;
    try {
        return PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, channel);
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------- Names & text

export function displayName(user: { id: string; username?: string; globalName?: string | null; } | null | undefined, guildId?: string | null) {
    if (!user) return "Unknown";
    const nick = guildId ? GuildMemberStore.getNick(guildId, user.id) : null;
    return nick || user.globalName || user.username || "Unknown";
}

export function roleColor(userId: string, guildId?: string | null): string | null {
    if (!guildId) return null;
    try {
        return GuildMemberStore.getMember(guildId, userId)?.colorString || null;
    } catch {
        return null;
    }
}

export function messageDate(message: Message): Date {
    const t: any = message.timestamp;
    if (t?.toDate) return t.toDate();
    const d = new Date(t);
    return isNaN(+d) ? new Date() : d;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatFullDate(d: Date) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function roleName(guildId: string | null | undefined, roleId: string) {
    try {
        const store: any = GuildRoleStore;
        const role = guildId ? (store.getRole?.(guildId, roleId) ?? store.getRoles?.(guildId)?.[roleId]) : null;
        return role?.name ?? "role";
    } catch {
        return "role";
    }
}

export function channelName(channelId: string) {
    const c = ChannelStore.getChannel(channelId);
    return c?.name || "channel";
}

const TIMESTAMP_RE = /<t:(-?\d+)(?::[tTdDfFR])?>/g;

/**
 * Turns Discord's raw mention syntax into readable text, so quotes and copies don't ping anyone.
 * `nameOf` lets the screenshot replace user names (e.g. "User 1").
 */
export function readableContent(content: string, guildId: string | null | undefined, nameOf?: (userId: string) => string) {
    const userName = nameOf ?? ((id: string) => displayName(UserStore.getUser(id), guildId));
    return (content ?? "")
        .replace(/<@!?(\d+)>/g, (_, id) => `@${userName(id)}`)
        .replace(/<@&(\d+)>/g, (_, id) => `@${roleName(guildId, id)}`)
        .replace(/<#(\d+)>/g, (_, id) => `#${channelName(id)}`)
        .replace(/<a?:(\w+):\d+>/g, (_, name) => `:${name}:`)
        .replace(/<\/([\w -]+):\d+>/g, (_, name) => `/${name}`)
        .replace(TIMESTAMP_RE, (_, s) => formatFullDate(new Date(Number(s) * 1000)))
        .replace(/@(everyone|here)/g, "@​$1");
}

export function resolveRoleName(guildId: string | null | undefined, roleId: string) {
    return roleName(guildId, roleId);
}

/** Plain text for "Copy": `[time] Author: content` plus attachment URLs */
export function messagesToText(messages: Message[], guildId: string | null | undefined) {
    return messages.map(m => {
        const lines = [`[${formatFullDate(messageDate(m))}] ${displayName(m.author, guildId)}: ${readableContent(m.content, guildId)}`];
        for (const a of m.attachments ?? []) lines.push(`    ${a.url}`);
        for (const s of (m as any).stickerItems ?? m.stickers ?? []) lines.push(`    [Sticker: ${s.name}]`);
        return lines.join("\n");
    }).join("\n");
}

/** Markdown quote block for the chat input */
export function messagesToQuote(messages: Message[], guildId: string | null | undefined) {
    const blocks: string[] = [];
    let lastAuthor: string | null = null;
    for (const m of messages) {
        const body = readableContent(m.content, guildId).split("\n").filter((l, i, arr) => l.trim() || (i > 0 && i < arr.length - 1));
        for (const a of m.attachments ?? []) body.push(a.url);
        if (!body.length) continue;
        const lines = body.map(l => `> ${l}`);
        if (m.author?.id !== lastAuthor) lines.unshift(`> **${displayName(m.author, guildId)}**`);
        lastAuthor = m.author?.id ?? null;
        blocks.push(lines.join("\n"));
    }
    return blocks.join("\n") + "\n";
}

// ---------------------------------------------------------------- Highlight style

let styleEl: HTMLStyleElement | null = null;

export function mountStyle() {
    if (styleEl) return;
    styleEl = document.createElement("style");
    styleEl.id = "vc-msgselect-highlight";
    document.head.appendChild(styleEl);
    updateHighlight();
}

export function unmountStyle() {
    styleEl?.remove();
    styleEl = null;
    document.body.classList.remove("vc-msgselect-selecting");
}

/** CSS rules for the selected list items – no render patch needed, the ids are stable */
function updateHighlight() {
    document.body.classList.toggle("vc-msgselect-selecting", isActive());
    if (!styleEl) return;
    const { channelId } = state;
    if (!channelId || !state.ids.size) {
        styleEl.textContent = "";
        return;
    }
    const selectors = [...state.ids].map(id => `[id="chat-messages-${channelId}-${id}"]`).join(",\n");
    styleEl.textContent = `${selectors} {
    background: color-mix(in srgb, var(--vc-ui-blue) 16%, transparent) !important;
    box-shadow: inset 3px 0 0 var(--vc-ui-blue);
}`;
}
