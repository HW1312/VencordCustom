/*
 * ModKit – ModNotes sync: a private mod channel per server is the database.
 * Each note is a message (readable line + machine-readable JSON block).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { ChannelStore, PermissionsBits, PermissionStore, RestAPI, showToast, UserStore } from "@webpack/common";

import { settings } from "./index";

const logger = new Logger("ModKit");

// ---------------------------------------------------------------- Types

export const NOTE_TYPES = ["note", "warn", "timeout", "kick", "ban", "unban"] as const;
export type NoteType = typeof NOTE_TYPES[number];

export const NOTE_LABELS: Record<NoteType, string> = {
    note: "Note",
    warn: "Warning",
    timeout: "Timeout",
    kick: "Kick",
    ban: "Ban",
    unban: "Unban"
};

export const NOTE_EMOJI: Record<NoteType, string> = {
    note: "📝",
    warn: "⚠️",
    timeout: "⏱️",
    kick: "👢",
    ban: "🔨",
    unban: "🕊️"
};

export interface Note {
    /** Message ID in the ModNotes channel */
    id: string;
    channelId: string;
    authorId: string;
    timestamp: number;
    type: NoteType;
    userId: string;
    reason: string;
    duration?: number;
    ref?: string;
    excerpt?: string;
}

export interface NewNote {
    type: NoteType;
    userId: string;
    reason: string;
    duration?: number;
    ref?: string;
    excerpt?: string;
}

// ---------------------------------------------------------------- Helpers

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const DISCORD_EPOCH = 1420070400000n;
export const snowflakeTime = (id: string) => {
    try {
        return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
    } catch {
        return 0;
    }
};

const compareIds = (a: string, b: string) => {
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
};

export function formatDuration(sec: number) {
    if (sec % 86400 === 0) return `${sec / 86400} ${sec === 86400 ? "day" : "days"}`;
    if (sec % 3600 === 0) return `${sec / 3600} h`;
    if (sec % 60 === 0) return `${sec / 60} min`;
    return `${sec} s`;
}

/** Translates API errors into readable messages */
export function describeError(e: any): string {
    const status = e?.status;
    const msg = e?.body?.message;
    if (status === 403) return "Missing permission";
    if (status === 404) return "Not found (maybe already deleted)";
    if (status === 429) return "Too many requests - please wait a moment";
    if (status === 400 && msg) return `Invalid request: ${msg}`;
    if (status >= 500) return "Discord server error";
    return msg ?? e?.message ?? "Unknown error";
}

/** REST call honoring 429 retry_after */
export async function rest(method: "get" | "post" | "put" | "patch" | "del", data: Record<string, any>, maxRetries = 4): Promise<any> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await RestAPI[method](data as any);
        } catch (e: any) {
            if (e?.status === 429 && attempt < maxRetries) {
                const wait = Math.min(60, Number(e.body?.retry_after) || 2) * 1000;
                await sleep(wait + 250);
                continue;
            }
            throw e;
        }
    }
}

// ---------------------------------------------------------------- Message format

const MACHINE_RE = /`(\{"mk":1[^`]*\})`/;
const ID_RE = /^\d{15,21}$/;

export function buildNoteContent(n: NewNote, authorId: string) {
    const payload: Record<string, any> = { mk: 1, t: n.type, u: n.userId, r: n.reason.slice(0, 900) };
    if (n.duration) payload.d = n.duration;
    if (n.ref) payload.ref = n.ref;
    if (n.excerpt) payload.m = n.excerpt.slice(0, 150);

    // Backticks and pipes would break the code block / spoiler -> use \u escapes
    const json = JSON.stringify(payload).replace(/`/g, "\\u0060").replace(/\|/g, "\\u007c");

    const reason = n.reason.replace(/\s+/g, " ").trim().slice(0, 900) || "_no reason given_";
    const dur = n.duration ? ` (${formatDuration(n.duration)})` : "";
    let text = `${NOTE_EMOJI[n.type]} **${NOTE_LABELS[n.type]}**${dur} for <@${n.userId}> by <@${authorId}>: ${reason}`;
    if (n.ref) text += `\n↪ ${n.ref}`;
    text += `\n||\`${json}\`||`;
    return text;
}

export function parseNote(msg: any): Note | null {
    const content: string | undefined = msg?.content;
    if (!content || !msg.id) return null;
    const m = MACHINE_RE.exec(content);
    if (!m) return null;

    let data: any;
    try {
        data = JSON.parse(m[1]);
    } catch {
        return null;
    }
    if (data?.mk !== 1 || !NOTE_TYPES.includes(data.t) || typeof data.u !== "string" || !ID_RE.test(data.u)) return null;

    return {
        id: msg.id,
        channelId: msg.channel_id,
        authorId: msg.author?.id ?? "0",
        timestamp: snowflakeTime(msg.id),
        type: data.t,
        userId: data.u,
        reason: typeof data.r === "string" ? data.r : "",
        duration: typeof data.d === "number" ? data.d : undefined,
        ref: typeof data.ref === "string" ? data.ref : undefined,
        excerpt: typeof data.m === "string" ? data.m : undefined
    };
}

// ---------------------------------------------------------------- Cache

interface ChannelCache {
    notes: Map<string, Note>;
    lastId: string | null;
    loaded: boolean;
    loading: Promise<void> | null;
    /** Messages already loaded during the initial load */
    progress: number;
    cancelled: boolean;
    error: string | null;
}

const caches = new Map<string, ChannelCache>();
const listeners = new Set<() => void>();
let version = 0;

export function subscribe(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

export const getVersion = () => version;

function emit() {
    version++;
    countIndex = null;
    listeners.forEach(fn => {
        try {
            fn();
        } catch (e) {
            logger.error("Listener error", e);
        }
    });
}

function getCache(channelId: string) {
    let c = caches.get(channelId);
    if (!c) {
        c = { notes: new Map(), lastId: null, loaded: false, loading: null, progress: 0, cancelled: false, error: null };
        caches.set(channelId, c);
    }
    return c;
}

export function getNotesChannelId(guildId: string | null | undefined): string | null {
    if (!guildId) return null;
    return settings.store.notesChannels?.[guildId] ?? null;
}

export function isNotesChannel(channelId: string) {
    return Object.values(settings.store.notesChannels ?? {}).includes(channelId);
}

export function getLoadState(guildId: string) {
    const channelId = getNotesChannelId(guildId);
    if (!channelId) return null;
    const c = caches.get(channelId);
    return {
        loaded: c?.loaded ?? false,
        loading: !!c?.loading,
        progress: c?.progress ?? 0,
        error: c?.error ?? null,
        count: c?.notes.size ?? 0
    };
}

// ---------------------------------------------------------------- Saving (DataStore)

const storeKey = (channelId: string) => `ModKit_notes_${channelId}`;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSave(channelId: string) {
    clearTimeout(saveTimers.get(channelId));
    saveTimers.set(channelId, setTimeout(() => {
        saveTimers.delete(channelId);
        const c = caches.get(channelId);
        if (!c?.loaded) return;
        DataStore.set(storeKey(channelId), { lastId: c.lastId, notes: [...c.notes.values()] })
            .catch(e => logger.error("Could not save ModNotes", e));
    }, 1500));
}

export async function clearStored(channelId: string) {
    caches.delete(channelId);
    clearTimeout(saveTimers.get(channelId));
    saveTimers.delete(channelId);
    await DataStore.del(storeKey(channelId)).catch(() => { });
    emit();
}

// ---------------------------------------------------------------- Loading

const PAGE_DELAY = 800;
const MAX_PAGES = 200;

function noteLastId(c: ChannelCache, id: string) {
    if (!c.lastId || compareIds(id, c.lastId) > 0) c.lastId = id;
}

function ingest(c: ChannelCache, msgs: any[]) {
    for (const msg of msgs) {
        noteLastId(c, msg.id);
        const note = parseNote(msg);
        if (note) c.notes.set(note.id, note);
    }
}

/** Loads a server's notes if not done yet (cache first, then only new messages from Discord) */
export function ensureLoaded(guildId: string | null | undefined, force = false): Promise<void> {
    const channelId = getNotesChannelId(guildId);
    if (!channelId) return Promise.resolve();
    const c = getCache(channelId);
    if (c.loaded) return Promise.resolve();
    if (c.loading) return c.loading;
    // After cancel or error, don't restart on every render - only on explicit request
    if ((c.cancelled || c.error) && !force) return Promise.resolve();

    c.cancelled = false;
    c.error = null;
    c.loading = load(channelId, c)
        .catch(e => {
            c.error = describeError(e);
            logger.error("Could not load ModNotes", e);
            showToast(`ModKit: Could not load ModNotes - ${c.error}`, "failure");
        })
        .finally(() => {
            c.loading = null;
            emit();
        });
    // May be called during a render (context menu) -> don't notify synchronously
    queueMicrotask(emit);
    return c.loading;
}

async function load(channelId: string, c: ChannelCache) {
    const channel = ChannelStore.getChannel(channelId);
    if (channel && !PermissionStore.can(PermissionsBits.VIEW_CHANNEL | PermissionsBits.READ_MESSAGE_HISTORY, channel))
        throw { message: "No access to the ModNotes channel (read/history)" };

    const stored = await DataStore.get<{ lastId: string | null; notes: Note[]; }>(storeKey(channelId)).catch(() => undefined);
    if (stored?.lastId) {
        for (const n of stored.notes ?? []) c.notes.set(n.id, n);
        noteLastId(c, stored.lastId);
        emit();
        await fetchNewer(channelId, c);
    } else {
        await fetchAll(channelId, c);
    }

    if (c.cancelled) return;
    c.loaded = true;
    scheduleSave(channelId);
}

async function fetchAll(channelId: string, c: ChannelCache) {
    let before: string | undefined;
    c.progress = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
        if (c.cancelled) return;
        const res = await rest("get", { url: `/channels/${channelId}/messages`, query: { limit: 100, ...(before && { before }) }, retries: 2 });
        const msgs: any[] = Array.isArray(res?.body) ? res.body : [];
        ingest(c, msgs);
        c.progress += msgs.length;
        emit();
        if (msgs.length < 100) return;
        before = msgs.reduce((min, m) => compareIds(m.id, min) < 0 ? m.id : min, msgs[0].id);
        await sleep(PAGE_DELAY);
    }
    showToast("ModKit: Very long history - only the latest 20,000 messages were loaded", "message");
}

async function fetchNewer(channelId: string, c: ChannelCache) {
    for (let page = 0; page < MAX_PAGES; page++) {
        if (c.cancelled || !c.lastId) return;
        const res = await rest("get", { url: `/channels/${channelId}/messages`, query: { limit: 100, after: c.lastId }, retries: 2 });
        const msgs: any[] = Array.isArray(res?.body) ? res.body : [];
        ingest(c, msgs);
        c.progress += msgs.length;
        emit();
        if (msgs.length < 100) return;
        await sleep(PAGE_DELAY);
    }
}

/** Cancel loading (e.g. for a huge history) */
export function cancelLoad(guildId: string) {
    const channelId = getNotesChannelId(guildId);
    const c = channelId && caches.get(channelId);
    if (c && c.loading) c.cancelled = true;
}

/** Discard the cache and reload the entire history (also detects notes deleted while offline) */
export async function resync(guildId: string) {
    const channelId = getNotesChannelId(guildId);
    if (!channelId) return;
    const c = caches.get(channelId);
    if (c?.loading) return;
    await clearStored(channelId);
    return ensureLoaded(guildId, true);
}

// ---------------------------------------------------------------- Live updates (Flux)

export function onMessageCreate(channelId: string, message: any) {
    const c = caches.get(channelId);
    if (!c || !message?.id) return;
    noteLastId(c, message.id);
    const note = parseNote({ ...message, channel_id: channelId });
    if (note) {
        c.notes.set(note.id, note);
        emit();
    }
    if (c.loaded) scheduleSave(channelId);
}

export function onMessageUpdate(message: any) {
    const c = message?.channel_id && caches.get(message.channel_id);
    if (!c || typeof message.content !== "string") return;
    const had = c.notes.has(message.id);
    const note = parseNote({ ...message, author: message.author ?? { id: c.notes.get(message.id)?.authorId } });
    if (note) c.notes.set(note.id, note);
    else if (had) c.notes.delete(message.id);
    else return;
    emit();
    if (c.loaded) scheduleSave(message.channel_id);
}

export function onMessageDelete(channelId: string, ids: string[]) {
    const c = caches.get(channelId);
    if (!c) return;
    let changed = false;
    for (const id of ids) changed = c.notes.delete(id) || changed;
    if (!changed) return;
    emit();
    if (c.loaded) scheduleSave(channelId);
}

// ---------------------------------------------------------------- Queries

export function getNotesForUser(guildId: string, userId: string): Note[] {
    const channelId = getNotesChannelId(guildId);
    const c = channelId && caches.get(channelId);
    if (!c) return [];
    return [...c.notes.values()].filter(n => n.userId === userId).sort((a, b) => b.timestamp - a.timestamp);
}

/** Counts warnings (or all violations) per server and user for the badges */
let countIndex: Map<string, Map<string, { warn: number; all: number; }>> | null = null;

export function getCounts(guildId: string, userId: string) {
    if (!countIndex) {
        countIndex = new Map();
        const byChannel = new Map(Object.entries(settings.store.notesChannels ?? {}).map(([g, ch]) => [ch, g]));
        for (const [channelId, c] of caches) {
            const g = byChannel.get(channelId);
            if (!g) continue;
            const map = new Map<string, { warn: number; all: number; }>();
            for (const n of c.notes.values()) {
                const entry = map.get(n.userId) ?? { warn: 0, all: 0 };
                if (n.type === "warn") entry.warn++;
                if (n.type !== "note" && n.type !== "unban") entry.all++;
                map.set(n.userId, entry);
            }
            countIndex.set(g, map);
        }
    }
    return countIndex.get(guildId)?.get(userId) ?? { warn: 0, all: 0 };
}

// ---------------------------------------------------------------- Writing & deleting

export function canWriteNotes(guildId: string): string | null {
    const channelId = getNotesChannelId(guildId);
    if (!channelId) return "No ModNotes channel is set for this server.";
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return "ModNotes channel not found (deleted or no access).";
    if (!PermissionStore.can(PermissionsBits.VIEW_CHANNEL | PermissionsBits.SEND_MESSAGES, channel))
        return "You cannot send messages in the ModNotes channel.";
    return null;
}

/** Writes a note - only call after an explicit click */
export async function writeNote(guildId: string, n: NewNote) {
    const problem = canWriteNotes(guildId);
    if (problem) throw { message: problem };
    const channelId = getNotesChannelId(guildId)!;
    const me = UserStore.getCurrentUser().id;

    const res = await rest("post", {
        url: `/channels/${channelId}/messages`,
        body: { content: buildNoteContent(n, me), allowed_mentions: { parse: [] } }
    });
    if (res?.body?.id) onMessageCreate(channelId, { ...res.body, author: res.body.author ?? { id: me } });
    return res?.body;
}

export function canDeleteNote(note: Note) {
    if (note.authorId === UserStore.getCurrentUser()?.id) return true;
    const channel = ChannelStore.getChannel(note.channelId);
    return !!channel && PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, channel);
}

export async function deleteNote(note: Note) {
    await rest("del", { url: `/channels/${note.channelId}/messages/${note.id}` });
    onMessageDelete(note.channelId, [note.id]);
}

// ---------------------------------------------------------------- Cleanup

export function resetAll() {
    for (const [channelId, timer] of saveTimers) {
        clearTimeout(timer);
        const c = caches.get(channelId);
        if (c?.loaded) DataStore.set(storeKey(channelId), { lastId: c.lastId, notes: [...c.notes.values()] }).catch(() => { });
    }
    saveTimers.clear();
    for (const c of caches.values()) c.cancelled = true;
    caches.clear();
    listeners.clear();
    countIndex = null;
}
