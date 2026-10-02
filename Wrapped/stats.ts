/*
 * Wrapped – aggregation of the daily data for a period, fun facts
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Counter, dayKey, DayStats, getStats, parseDayKey } from "./store";

export type Period = "7" | "30" | "365" | "all";
export type Metric = "messages" | "voice" | "active";

export const PERIODS: { id: Period; label: string; }[] = [
    { id: "7", label: "7 days" },
    { id: "30", label: "30 days" },
    { id: "365", label: "Year" },
    { id: "all", label: "All tracked" }
];

export interface DayPoint {
    key: string;
    date: Date;
    messages: number;
    voice: number;
    active: number;
}

export interface Aggregate {
    days: DayPoint[];
    messages: number;
    chars: number;
    voice: number;
    active: number;
    /** [weekday 0 = Monday][hour] */
    heat: Record<Metric, number[][]>;
    hours: Record<Metric, number[]>;
    msgPlaces: Counter;
    msgChannels: Counter;
    dmSent: Counter;
    dmReceived: Counter;
    voicePlaces: Counter;
    voiceChannels: Counter;
    voiceWith: Counter;
    games: Counter;
}

const HOUR_FIELD = { messages: "msgHours", voice: "voiceHours", active: "activeHours" } as const;
const COUNTERS = ["msgPlaces", "msgChannels", "dmSent", "dmReceived", "voicePlaces", "voiceChannels", "voiceWith", "games"] as const;
const grid = () => Array.from({ length: 7 }, () => new Array(24).fill(0));

/** All day keys of the period, oldest first (days without data included) */
function periodKeys(period: Period) {
    const { since } = getStats();
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    if (period === "all") {
        const first = new Date(since);
        first.setHours(0, 0, 0, 0);
        const span = Math.round((start.getTime() - first.getTime()) / 86400_000) + 1;
        start.setDate(start.getDate() - Math.min(Math.max(span, 1), 366) + 1);
    } else start.setDate(start.getDate() - Number(period) + 1);

    const keys: string[] = [];
    const end = dayKey();
    for (const d = new Date(start); ; d.setDate(d.getDate() + 1)) {
        const k = dayKey(d);
        keys.push(k);
        if (k >= end || keys.length > 400) break;
    }
    return keys;
}

export function aggregate(period: Period): Aggregate {
    const { days } = getStats();
    const agg: Aggregate = {
        days: [], messages: 0, chars: 0, voice: 0, active: 0,
        heat: { messages: grid(), voice: grid(), active: grid() },
        hours: { messages: new Array(24).fill(0), voice: new Array(24).fill(0), active: new Array(24).fill(0) },
        msgPlaces: {}, msgChannels: {}, dmSent: {}, dmReceived: {}, voicePlaces: {}, voiceChannels: {}, voiceWith: {}, games: {}
    };

    for (const key of periodKeys(period)) {
        const day: DayStats = days[key] ?? {};
        const date = parseDayKey(key);
        const weekday = (date.getDay() + 6) % 7;
        agg.days.push({ key, date, messages: day.messages ?? 0, voice: day.voice ?? 0, active: day.active ?? 0 });
        agg.messages += day.messages ?? 0;
        agg.chars += day.chars ?? 0;
        agg.voice += day.voice ?? 0;
        agg.active += day.active ?? 0;

        for (const metric of ["messages", "voice", "active"] as Metric[]) {
            const arr = day[HOUR_FIELD[metric]];
            if (!arr) continue;
            arr.forEach((n, h) => {
                agg.heat[metric][weekday][h] += n;
                agg.hours[metric][h] += n;
            });
        }

        for (const field of COUNTERS) {
            const src = day[field];
            if (!src) continue;
            const dst = agg[field];
            for (const [id, n] of Object.entries(src)) dst[id] = (dst[id] ?? 0) + n;
        }
    }
    return agg;
}

export function top(counter: Counter, n: number, exclude?: string) {
    return Object.entries(counter)
        .filter(([id, v]) => v > 0 && id !== exclude)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n);
}

/** Merge two counters into rows with both values, sorted by the sum of their shares */
export function combine(a: Counter, b: Counter, n: number) {
    const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...ids]
        .map(id => ({ id, a: a[id] ?? 0, b: b[id] ?? 0 }))
        .sort((x, y) => (y.a + y.b) - (x.a + x.b))
        .slice(0, n);
}

// ---------------------------------------------------------------- Formatting

export function fmtDuration(secs: number) {
    if (secs < 60) return `${Math.round(secs)}s`;
    const m = Math.round(secs / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h >= 100 ? `${h}h` : `${h}h ${m % 60}m`;
}

export const fmtHours = (secs: number) => {
    const h = secs / 3600;
    return h >= 10 ? Math.round(h).toLocaleString("en-US") : h.toFixed(1);
};

export const fmtNum = (n: number) => Math.round(n).toLocaleString("en-US");

export const fmtDate = (d: Date, withYear = false) =>
    d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", ...(withYear ? { year: "numeric" } : {}) });

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export const fmtHour = (h: number) => `${String(h).padStart(2, "0")}:00`;

// ---------------------------------------------------------------- Fun facts

export interface Fact {
    emoji: string;
    text: string;
}

const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
const pct = (part: number, total: number) => Math.round(part / total * 100);

export function funFacts(agg: Aggregate, topGame?: [string, number]): Fact[] {
    const facts: Fact[] = [];
    const { days } = agg;

    const busiest = days.reduce<DayPoint | null>((best, d) => d.messages > (best?.messages ?? 0) ? d : best, null);
    if (busiest) facts.push({ emoji: "📈", text: `Your busiest day was ${fmtDate(busiest.date)} with ${fmtNum(busiest.messages)} messages.` });

    const loudest = days.reduce<DayPoint | null>((best, d) => d.voice > (best?.voice ?? 0) ? d : best, null);
    if (loudest && loudest.voice >= 600) facts.push({ emoji: "🎙️", text: `Longest voice day: ${fmtDuration(loudest.voice)} on ${fmtDate(loudest.date)}.` });

    const mh = agg.hours.messages;
    const totalMsgs = sum(mh);
    if (totalMsgs >= 20) {
        const night = sum(mh.slice(0, 5));
        const morning = sum(mh.slice(5, 9));
        const peak = mh.indexOf(Math.max(...mh));
        if (pct(night, totalMsgs) >= 15) facts.push({ emoji: "🦉", text: `Night owl: ${pct(night, totalMsgs)}% of your messages were sent between midnight and 5 am.` });
        else if (pct(morning, totalMsgs) >= 15) facts.push({ emoji: "🐦", text: `Early bird: ${pct(morning, totalMsgs)}% of your messages were sent before 9 am.` });
        facts.push({ emoji: "⏰", text: `You are most talkative around ${fmtHour(peak)}.` });

        const perWeekday = agg.heat.messages.map(sum);
        const wd = perWeekday.indexOf(Math.max(...perWeekday));
        facts.push({ emoji: "📅", text: `${WEEKDAYS[wd]} is your chattiest day of the week (${pct(perWeekday[wd], totalMsgs)}% of messages).` });
        const weekend = perWeekday[5] + perWeekday[6];
        if (pct(weekend, totalMsgs) >= 40) facts.push({ emoji: "🎉", text: `Weekend warrior: ${pct(weekend, totalMsgs)}% of your messages happen on Saturday and Sunday.` });
    }

    // Streak of consecutive days with at least one message
    let streak = 0, best = 0;
    for (const d of days) {
        streak = d.messages > 0 ? streak + 1 : 0;
        best = Math.max(best, streak);
    }
    if (best >= 3) facts.push({ emoji: "🔥", text: `Longest streak: ${best} days in a row with at least one message.` });

    if (agg.chars >= 1000) {
        // A typical novel has about 500,000 characters
        const novels = agg.chars / 500_000;
        facts.push({
            emoji: "✍️",
            text: novels >= 0.1
                ? `You typed ${fmtNum(agg.chars)} characters – about ${novels.toFixed(1)} novels.`
                : `You typed ${fmtNum(agg.chars)} characters – about ${fmtNum(agg.chars / 1800)} pages of a book.`
        });
        if (agg.messages) facts.push({ emoji: "💬", text: `Your average message is ${Math.round(agg.chars / agg.messages)} characters long.` });
    }

    const activeDays = days.filter(d => d.active > 0).length;
    if (activeDays) facts.push({ emoji: "🖥️", text: `On days you used Discord, you were active for ${fmtDuration(agg.active / activeDays)} on average.` });

    const received = sum(Object.values(agg.dmReceived));
    const sent = sum(Object.values(agg.dmSent));
    if (received + sent >= 20) {
        facts.push({
            emoji: received > sent ? "📥" : "📤",
            text: received > sent
                ? `People write you more than you write them: ${fmtNum(received)} DMs received vs ${fmtNum(sent)} sent.`
                : `You are the one who keeps DMs going: ${fmtNum(sent)} sent vs ${fmtNum(received)} received.`
        });
    }

    if (topGame && topGame[1] >= 1800) facts.push({ emoji: "🎮", text: `You played ${topGame[0]} for ${fmtDuration(topGame[1])}.` });

    return facts;
}
