/*
 * Radar – reminders (RemindMe) & bookmarks
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showToast, Toasts } from "@webpack/common";

import { fireRule, snapshotMessage } from "./engine";
import { settings } from "./index";
import { Bookmark, bookmarksStore, logger, Reminder, remindersStore, Rule, uid } from "./store";

// ---------------------------------------------------------------- Quick picks

export interface QuickPick {
    id: string;
    label: string;
    at(): number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

function atTime(daysAhead: number, h: number, m = 0) {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    d.setHours(h, m, 0, 0);
    return d.getTime();
}

export function getQuickPicks(): QuickPick[] {
    const eveningToday = new Date().getHours() < 20;
    return [
        { id: "20m", label: "In 20 minutes", at: () => Date.now() + 20 * MIN },
        { id: "1h", label: "In 1 hour", at: () => Date.now() + HOUR },
        { id: "3h", label: "In 3 hours", at: () => Date.now() + 3 * HOUR },
        eveningToday
            ? { id: "evening", label: "Tonight 20:00", at: () => atTime(0, 20) }
            : { id: "evening", label: "Tomorrow evening 20:00", at: () => atTime(1, 20) },
        { id: "morning", label: "Tomorrow 09:00", at: () => atTime(1, 9) },
        { id: "2d", label: "In 2 days", at: () => Date.now() + 48 * HOUR }
    ];
}

// ---------------------------------------------------------------- Formatting

const dateFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

export function formatWhen(ts: number) {
    const d = new Date(ts);
    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);
    if (d.toDateString() === today.toDateString()) return `Today ${timeFmt.format(d)}`;
    if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${timeFmt.format(d)}`;
    return dateFmt.format(d);
}

export function formatRelative(ts: number) {
    const diff = ts - Date.now();
    const abs = Math.abs(diff);
    const future = diff > 0;
    let text: string;
    if (abs < MIN) text = "a few seconds";
    else if (abs < HOUR) text = `${Math.round(abs / MIN)} min`;
    else if (abs < 24 * HOUR) text = `${Math.round(abs / HOUR)} h`;
    else {
        const days = Math.round(abs / (24 * HOUR));
        text = `${days} ${days === 1 ? "day" : "days"}`;
    }
    return future ? `in ${text}` : `${text} ago`;
}

// ---------------------------------------------------------------- Reminders

let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;

export function addReminder(dueAt: number, note: string, message?: any) {
    const reminder: Reminder = {
        id: uid(),
        createdAt: Date.now(),
        dueAt,
        note: note.trim(),
        message: message ? snapshotMessage(message) : undefined,
        done: false
    };
    remindersStore.update(list => [...list, reminder]);
    scheduleReminders();
    showToast(`Reminder set for ${formatWhen(dueAt)}`, Toasts.Type.SUCCESS);
}

export function deleteReminder(id: string) {
    remindersStore.update(list => list.filter(r => r.id !== id));
    scheduleReminders();
}

export function snoozeReminder(id: string, ms: number) {
    remindersStore.update(list => list.map(r => r.id === id ? { ...r, dueAt: Date.now() + ms, done: false, missed: false, firedAt: undefined } : r));
    scheduleReminders();
}

export function clearDoneReminders() {
    remindersStore.update(list => list.filter(r => !r.done));
}

function reminderRule(): Rule {
    const s = settings.store;
    return {
        id: "radar-reminder",
        name: "Reminder",
        enabled: true,
        createdAt: 0,
        trigger: { type: "time" },
        conditions: undefined as any,
        actions: [
            { type: "notify", permanent: true },
            ...(s.reminderSound !== "none" ? [{ type: "sound" as const, sound: s.reminderSound, volume: s.reminderVolume }] : []),
            ...(s.reminderFlash ? [{ type: "flash" as const }] : []),
            { type: "inbox" }
        ]
    };
}

function fireReminder(r: Reminder, missed: boolean) {
    const m = r.message;
    const title = r.note || (m ? `Message from ${m.authorName}` : "Reminder");
    const body = m
        ? `${r.note ? `${m.authorName}: ` : ""}${m.content || (m.attachments ? "[Attachment]" : "[Message]")}`
        : r.note ? `Set ${formatWhen(r.createdAt)}` : "Reminder";

    const rule = reminderRule();
    fireRule(rule, {
        title,
        body,
        guildId: m?.guildId,
        channelId: m?.channelId,
        messageId: m?.messageId,
        icon: m?.authorAvatar,
        tag: missed ? "missed" : undefined
    }, { ignoreCooldown: true });
}

function checkReminders() {
    if (!running || !remindersStore.loaded) return;
    const now = Date.now();
    const due = remindersStore.value.filter(r => !r.done && r.dueAt <= now);
    if (due.length) {
        const ids = new Set(due.map(r => r.id));
        // More than a minute late = Discord was closed at that time
        const missedIds = new Set(due.filter(r => now - r.dueAt > MIN).map(r => r.id));
        remindersStore.update(list => list.map(r => ids.has(r.id) ? { ...r, done: true, firedAt: now, missed: missedIds.has(r.id) } : r));
        for (const r of due) {
            try {
                fireReminder(r, missedIds.has(r.id));
            } catch (e) {
                logger.error("Reminder failed", e);
            }
        }
    }
    scheduleReminders();
}

export function scheduleReminders() {
    clearTimeout(timer);
    timer = undefined;
    if (!running) return;
    const next = remindersStore.value.filter(r => !r.done).reduce((min, r) => Math.min(min, r.dueAt), Infinity);
    if (next === Infinity) return;
    // Wait at most one hour (timer upper limit, PC sleep mode)
    const delay = Math.min(Math.max(0, next - Date.now()), HOUR);
    timer = setTimeout(checkReminders, delay + 50);
}

export function startReminders() {
    running = true;
    checkReminders();
}

export function stopReminders() {
    running = false;
    clearTimeout(timer);
    timer = undefined;
}

// ---------------------------------------------------------------- Bookmarks

export function parseTags(text: string) {
    return [...new Set(text.split(/[,;#]/).map(t => t.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
}

export function findBookmark(messageId: string) {
    return bookmarksStore.value.find(b => b.message.messageId === messageId);
}

export function addBookmark(message: any, tags: string[], note: string) {
    const existing = findBookmark(message.id);
    if (existing) {
        bookmarksStore.update(list => list.map(b => b.id === existing.id ? { ...b, tags, note: note.trim() } : b));
        showToast("Bookmark updated", Toasts.Type.SUCCESS);
        return;
    }
    const bookmark: Bookmark = { id: uid(), createdAt: Date.now(), tags, note: note.trim(), message: snapshotMessage(message) };
    bookmarksStore.update(list => [bookmark, ...list]);
    showToast("Bookmark saved", Toasts.Type.SUCCESS);
}

export function deleteBookmark(id: string) {
    bookmarksStore.update(list => list.filter(b => b.id !== id));
}

export function allTags() {
    const counts = new Map<string, number>();
    for (const b of bookmarksStore.value) for (const t of b.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}
