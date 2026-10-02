/*
 * Wrapped – recording: messages via flux events, voice / active time / games by sampling the stores
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, GuildStore, RunningGameStore, SelectedChannelStore, SelfPresenceStore, UserStore, VoiceStateStore, WindowStore } from "@webpack/common";

import { settings } from "./index";
import { add, addHour, count, flushStats, loadStats, rememberName, today } from "./store";

/** Sampling interval for time based stats */
const TICK_MS = 10_000;
/** Flush interval for the DataStore */
const FLUSH_MS = 60_000;
/** A longer gap between two ticks means the PC slept – do not count it */
const MAX_GAP_MS = 60_000;

const DM = 1;
const GROUP_DM = 3;

let running = false;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let flushTimer: ReturnType<typeof setInterval> | undefined;
let lastTick = 0;
let lastInput = Date.now();

// ---------------------------------------------------------------- Names

export const userName = (u: any) => u?.globalName || u?.global_name || u?.username || null;

function rememberUser(id: string) {
    const u = UserStore.getUser(id);
    if (u) rememberName(id, userName(u));
}

function rememberPlace(guildId: string | null | undefined) {
    if (guildId) rememberName(guildId, GuildStore.getGuild(guildId)?.name);
}

function rememberChannel(channel: any) {
    if (!channel?.id) return;
    if (channel.type === DM) {
        const rid = channel.recipients?.[0];
        if (rid) {
            rememberUser(rid);
            const u = UserStore.getUser(rid);
            if (u) rememberName(channel.id, "@" + userName(u));
        }
    } else rememberName(channel.id, channel.name ? (channel.type === GROUP_DM ? channel.name : "#" + channel.name) : null);
}

// ---------------------------------------------------------------- Messages

/** Recently counted message ids – MESSAGE_CREATE can arrive twice (optimistic + real, multiple windows) */
const seen = new Set<string>();
function firstTime(id: string) {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 500) seen.delete(seen.values().next().value!);
    return true;
}

export function onMessageCreate({ message, optimistic, isPushNotification }: { message?: any; optimistic?: boolean; isPushNotification?: boolean; }) {
    if (!running || !settings.store.trackMessages || optimistic || isPushNotification || !message?.id) return;
    // Regular messages and replies only
    if (message.type != null && message.type !== 0 && message.type !== 19) return;
    if (message.state === "SENDING" || message.state === "SEND_FAILED") return;

    const me = UserStore.getCurrentUser()?.id;
    const author = message.author?.id;
    if (!me || !author) return;

    const channel = ChannelStore.getChannel(message.channel_id);
    if (!channel) return;
    const isDm = channel.type === DM;
    const isPrivate = isDm || channel.type === GROUP_DM;

    if (author === me) {
        if (!firstTime(message.id)) return;
        lastInput = Date.now();
        const day = today();
        const now = new Date();
        add(day, "messages", 1);
        add(day, "chars", typeof message.content === "string" ? message.content.length : 0);
        addHour(day, "msgHours", now.getHours(), 1);

        const place = isPrivate ? "@me" : (message.guild_id ?? channel.guild_id);
        if (place) {
            count(day, "msgPlaces", place, 1);
            if (!isPrivate) rememberPlace(place);
        }
        count(day, "msgChannels", channel.id, 1);
        rememberChannel(channel);

        if (isDm) {
            const rid = channel.recipients?.[0];
            if (rid) count(day, "dmSent", rid, 1);
        }
    } else if (isDm && !message.author?.bot) {
        if (!firstTime(message.id)) return;
        count(today(), "dmReceived", author, 1);
        rememberName(author, userName(message.author));
        rememberChannel(channel);
    }
}

// ---------------------------------------------------------------- Sampling

function onInput() {
    lastInput = Date.now();
}

function isActive(now: number) {
    let focused = document.hasFocus();
    try { focused = WindowStore.isAppFocused() || focused; } catch { /* ignore */ }
    if (!focused || document.visibilityState === "hidden") return false;
    return now - lastInput < settings.store.idleMinutes * 60_000;
}

function currentGames(): string[] {
    const names = new Set<string>();
    try {
        for (const a of SelfPresenceStore.getActivities() ?? [])
            if (a?.type === 0 && a.name) names.add(a.name);
    } catch { /* ignore */ }
    if (!names.size) {
        try {
            const g = RunningGameStore.getVisibleGame?.();
            if (g?.name) names.add(g.name);
        } catch { /* ignore */ }
    }
    return [...names];
}

function sampleVoice(secs: number, hour: number) {
    const me = UserStore.getCurrentUser()?.id;
    if (!me) return;
    // Voice channel of this client (not of another device)
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!channelId) return;

    const channel = ChannelStore.getChannel(channelId);
    const place = channel?.guild_id ?? "@me";
    const day = today();
    add(day, "voice", secs);
    addHour(day, "voiceHours", hour, secs);
    count(day, "voicePlaces", place, secs);
    count(day, "voiceChannels", channelId, secs);
    if (place !== "@me") rememberPlace(place);
    rememberChannel(channel);

    for (const uid of Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {})) {
        if (uid === me) continue;
        count(day, "voiceWith", uid, secs);
        rememberUser(uid);
    }
}

function tick() {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    if (gap <= 0 || gap > MAX_GAP_MS) return;
    const secs = Math.round(gap / 1000);
    if (!secs) return;
    const hour = new Date(now).getHours();
    const s = settings.store;

    try {
        if (s.trackVoice) sampleVoice(secs, hour);
    } catch { /* store not ready */ }

    if (s.trackActive && isActive(now)) {
        const day = today();
        add(day, "active", secs);
        addHour(day, "activeHours", hour, secs);
    }

    if (s.trackGames) {
        const games = currentGames();
        if (games.length) {
            const day = today();
            for (const g of games) count(day, "games", g, secs);
        }
    }
}

// ---------------------------------------------------------------- Lifecycle

const INPUT_EVENTS = ["mousemove", "mousedown", "keydown", "wheel", "touchstart"] as const;
const onUnload = () => void flushStats();

export function startTracking() {
    running = true;
    lastTick = Date.now();
    lastInput = Date.now();
    void loadStats();
    tickTimer = setInterval(tick, TICK_MS);
    flushTimer = setInterval(() => void flushStats(), FLUSH_MS);
    for (const e of INPUT_EVENTS) window.addEventListener(e, onInput, { passive: true, capture: true });
    window.addEventListener("beforeunload", onUnload);
}

export function stopTracking() {
    if (running) tick();
    running = false;
    clearInterval(tickTimer);
    clearInterval(flushTimer);
    for (const e of INPUT_EVENTS) window.removeEventListener(e, onInput, { capture: true });
    window.removeEventListener("beforeunload", onUnload);
    void flushStats();
}
