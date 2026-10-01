/*
 * Radar – rule engine: trigger and action registry, firing, highlights
 * New types: add an entry to TRIGGERS or ACTIONS (+ editor in editor.tsx).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { getUserSettingLazy } from "@api/UserSettings";
import { PluginNative } from "@utils/types";
import { ChannelStore, GuildMemberStore, GuildStore, IconUtils, NavigationRouter, SelectedChannelStore, showToast, Toasts, UserStore } from "@webpack/common";

import { settings } from "./index";
import { playSound, SOUNDS } from "./sounds";
import { ActionConfig, ActionType, addInboxItem, Conditions, logger, MessageSnapshot, Rule, rulesStore, Signal, StatusValue, TriggerConfig, TriggerType } from "./store";

const Native = VencordNative.pluginHelpers.Radar as PluginNative<typeof import("./native")>;
const StatusSetting = getUserSettingLazy<string>("status", "status")!;

// ---------------------------------------------------------------- Inputs & hits

export type EngineInput =
    | { source: "message"; message: any; guildId: string | null; channelId: string; }
    | { source: "voice"; userId: string; guildId: string | null; channelId: string | null; prevChannelId: string | null; }
    | { source: "game"; started: string[]; stopped: string[]; running: string[]; }
    | { source: "tick"; now: Date; };

export type Source = EngineInput["source"];

/** What a trigger found - actions build notifications, history, etc. from it */
export interface Hit {
    title: string;
    body: string;
    guildId?: string | null;
    channelId?: string;
    messageId?: string;
    userId?: string;
    icon?: string;
    /** Note such as "missed" (reminders) */
    tag?: string;
}

export type IconName = "search" | "at" | "voiceIn" | "voiceOut" | "gamepad" | "gamepadOff" | "clock" | "bell" | "sound" | "moon" | "flash" | "highlight" | "inbox";

export interface TriggerDef {
    type: TriggerType;
    label: string;
    hint: string;
    icon: IconName;
    sources: Source[];
    /** Hide in the "New rule" picker */
    hidden?: boolean;
    create(): TriggerConfig;
    summary(cfg: TriggerConfig): string;
    test(cfg: TriggerConfig, input: EngineInput): Hit | null;
    /** Does the triggered state end? (e.g. game stopped → restore status) */
    testEnd?(cfg: TriggerConfig, input: EngineInput): boolean;
}

export interface ActionDef {
    type: ActionType;
    label: string;
    hint: string;
    icon: IconName;
    /** Noisy actions are throttled per rule (cooldown) */
    noisy: boolean;
    create(): ActionConfig;
    summary(a: ActionConfig): string;
    run(a: ActionConfig, hit: Hit, rule: Rule): void;
    end?(a: ActionConfig, rule: Rule): void;
}

// ---------------------------------------------------------------- Helpers

const STATUS_LABELS: Record<StatusValue, string> = {
    online: "Online",
    idle: "Idle",
    dnd: "Do Not Disturb",
    invisible: "Invisible"
};
export const STATUS_OPTIONS = (Object.keys(STATUS_LABELS) as StatusValue[]).map(value => ({ value, label: STATUS_LABELS[value] }));

export const myId = () => UserStore.getCurrentUser()?.id;

export function excerpt(text: string, max = 160) {
    const clean = (text ?? "").replace(/\s+/g, " ").trim();
    return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function userName(user: any, guildId?: string | null) {
    if (!user) return "Unknown";
    const nick = guildId && user.id ? GuildMemberStore.getNick(guildId, user.id) : null;
    return nick || user.globalName || user.global_name || user.username || "Unknown";
}

export function avatarUrl(user: any): string | undefined {
    if (!user?.id) return undefined;
    try {
        const cached = UserStore.getUser(user.id);
        if (cached) return IconUtils.getUserAvatarURL(cached, false, 64);
    } catch { }
    return user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : undefined;
}

/** "#channel · Server" or "Direct message" */
export function placeLabel(guildId: string | null | undefined, channelId: string | undefined) {
    const channel = channelId ? ChannelStore.getChannel(channelId) : null;
    if (!guildId) {
        if (!channel) return "Direct message";
        return channel.name ? `Group ${channel.name}` : "Direct message";
    }
    const guild = GuildStore.getGuild(guildId);
    return `#${channel?.name ?? "unknown"}${guild ? ` · ${guild.name}` : ""}`;
}

export function jumpTo(target: { guildId?: string | null; channelId?: string; messageId?: string; }) {
    if (!target.channelId) return;
    try {
        NavigationRouter.transitionTo(`/channels/${target.guildId ?? "@me"}/${target.channelId}${target.messageId ? `/${target.messageId}` : ""}`);
    } catch (e) {
        logger.error("Jumping failed", e);
        showToast("Radar: Could not jump to the message", Toasts.Type.FAILURE);
    }
}

function channelMatches(channelId: string, ids: string[]) {
    if (ids.includes(channelId)) return true;
    // Threads count as part of their parent channel
    const parent = ChannelStore.getChannel(channelId)?.parent_id;
    return !!parent && ids.includes(parent);
}

export function scopeMatches(scope: { mode: string; guildIds?: string[]; channelIds?: string[]; } | undefined, guildId: string | null, channelId: string) {
    switch (scope?.mode ?? "all") {
        case "guilds": return !!guildId && (scope!.guildIds ?? []).includes(guildId);
        case "channels": return channelMatches(channelId, scope!.channelIds ?? []);
        case "dms": return !guildId;
        default: return true;
    }
}

function messageHit(message: any, guildId: string | null, channelId: string, body?: string): Hit {
    return {
        title: `${userName(message.author, guildId)} · ${placeLabel(guildId, channelId)}`,
        body: body ?? (excerpt(message.content) || (message.attachments?.length ? "[Attachment]" : "[Message]")),
        guildId,
        channelId,
        messageId: message.id,
        userId: message.author?.id,
        icon: avatarUrl(message.author)
    };
}

// ---------------------------------------------------------------- Keywords

const matcherCache = new WeakMap<TriggerConfig, RegExp | null>();

export function buildMatcher(cfg: TriggerConfig): RegExp | null {
    if (matcherCache.has(cfg)) return matcherCache.get(cfg)!;
    let re: RegExp | null = null;
    try {
        const flags = cfg.caseSensitive ? "u" : "iu";
        let source: string;
        if (cfg.useRegex) {
            source = (cfg.regex ?? "").trim();
        } else {
            const words = (cfg.words as string[] ?? []).map(w => w.trim()).filter(Boolean);
            source = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        }
        if (source) {
            if (cfg.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
            re = new RegExp(source, flags);
        }
    } catch {
        re = null;
    }
    matcherCache.set(cfg, re);
    return re;
}

/** Error message for an invalid regular expression (for the editor) */
export function regexError(pattern: string) {
    if (!pattern.trim()) return null;
    try {
        new RegExp(pattern, "u");
        return null;
    } catch (e: any) {
        return String(e?.message ?? e);
    }
}

function keywordBody(content: string, match: RegExpExecArray) {
    // Excerpt around the match
    const start = Math.max(0, match.index - 60);
    const text = content.slice(start, match.index + match[0].length + 90);
    return (start > 0 ? "…" : "") + excerpt(text, 160);
}

// ---------------------------------------------------------------- Trigger

export const TRIGGERS: Record<TriggerType, TriggerDef> = {
    keyword: {
        type: "keyword",
        label: "Keyword",
        hint: "A message contains certain words or matches a regular expression",
        icon: "search",
        sources: ["message"],
        create: () => ({
            type: "keyword",
            words: [],
            useRegex: false,
            regex: "",
            caseSensitive: false,
            wholeWord: true,
            ignoreSelf: true,
            scope: { mode: "all", guildIds: [], channelIds: [] }
        }),
        summary(cfg) {
            const what = cfg.useRegex ? `/${cfg.regex || "…"}/` : (cfg.words?.length ? cfg.words.map((w: string) => `“${w}”`).join(", ") : "no words");
            return `${what} · ${scopeSummary(cfg.scope)}`;
        },
        test(cfg, input) {
            if (input.source !== "message") return null;
            const { message, guildId, channelId } = input;
            if (cfg.ignoreSelf && message.author?.id === myId()) return null;
            if (!scopeMatches(cfg.scope, guildId, channelId)) return null;
            const content: string = message.content ?? "";
            if (!content) return null;
            const re = buildMatcher(cfg);
            if (!re) return null;
            re.lastIndex = 0;
            const match = re.exec(content);
            return match ? messageHit(message, guildId, channelId, keywordBody(content, match)) : null;
        }
    },

    mention: {
        type: "mention",
        label: "Mention",
        hint: "You are mentioned - directly, via one of your roles, or optionally via @everyone",
        icon: "at",
        sources: ["message"],
        create: () => ({ type: "mention", guildIds: [], roles: true, everyone: false }),
        summary(cfg) {
            const parts = ["@you", cfg.roles && "Roles", cfg.everyone && "@everyone"].filter(Boolean).join(", ");
            return `${parts} · ${cfg.guildIds?.length ? plural(cfg.guildIds.length, "server", "servers") : "all servers"}`;
        },
        test(cfg, input) {
            if (input.source !== "message") return null;
            const { message, guildId, channelId } = input;
            const me = myId();
            if (!me || message.author?.id === me) return null;
            if (cfg.guildIds?.length && (!guildId || !cfg.guildIds.includes(guildId))) return null;

            let how: string | null = null;
            if ((message.mentions ?? []).some((u: any) => (u?.id ?? u) === me)) how = "mentioned you";
            else if (cfg.roles && guildId && message.mention_roles?.length) {
                const mine = GuildMemberStore.getMember(guildId, me)?.roles ?? [];
                if (message.mention_roles.some((r: string) => mine.includes(r))) how = "mentioned one of your roles";
            }
            if (!how && cfg.everyone && message.mention_everyone) how = "@everyone / @here";
            if (!how) return null;

            const hit = messageHit(message, guildId, channelId);
            hit.title = `${userName(message.author, guildId)} ${how}`;
            hit.body = `${placeLabel(guildId, channelId)}: ${hit.body}`;
            return hit;
        }
    },

    voiceJoin: {
        type: "voiceJoin",
        label: "Joins voice",
        hint: "A specific person joins a voice channel - any channel or yours",
        icon: "voiceIn",
        sources: ["voice"],
        create: () => ({ type: "voiceJoin", userIds: [], where: "any" }),
        summary: cfg => voiceSummary(cfg, "joins"),
        test(cfg, input) {
            if (input.source !== "voice") return null;
            const { userId, channelId, prevChannelId, guildId } = input;
            if (!channelId || channelId === prevChannelId || userId === myId()) return null;
            if (!voiceUserMatches(cfg, userId)) return null;
            if (cfg.where === "mine" && channelId !== SelectedChannelStore.getVoiceChannelId()) return null;
            return voiceHit(userId, guildId, channelId, "joined voice");
        }
    },

    voiceLeave: {
        type: "voiceLeave",
        label: "Leaves voice",
        hint: "A specific person leaves a voice channel - any channel or yours",
        icon: "voiceOut",
        sources: ["voice"],
        create: () => ({ type: "voiceLeave", userIds: [], where: "any" }),
        summary: cfg => voiceSummary(cfg, "leaves"),
        test(cfg, input) {
            if (input.source !== "voice") return null;
            const { userId, channelId, prevChannelId, guildId } = input;
            if (!prevChannelId || channelId === prevChannelId || userId === myId()) return null;
            if (!voiceUserMatches(cfg, userId)) return null;
            if (cfg.where === "mine" && prevChannelId !== SelectedChannelStore.getVoiceChannelId()) return null;
            const prevGuild = ChannelStore.getChannel(prevChannelId)?.guild_id ?? guildId;
            return voiceHit(userId, prevGuild, prevChannelId, "left voice");
        }
    },

    gameStart: {
        type: "gameStart",
        label: "Game starts",
        hint: "You start a game (any or specific ones) - ideal for automatic “Do Not Disturb”",
        icon: "gamepad",
        sources: ["game"],
        create: () => ({ type: "gameStart", games: [] }),
        summary: cfg => cfg.games?.length ? cfg.games.join(", ") : "any game",
        test(cfg, input) {
            if (input.source !== "game") return null;
            const game = input.started.find(g => gameMatches(cfg, g));
            return game ? { title: "Game started", body: game } : null;
        },
        testEnd(cfg, input) {
            return input.source === "game"
                && input.stopped.some(g => gameMatches(cfg, g))
                && !input.running.some(g => gameMatches(cfg, g));
        }
    },

    gameStop: {
        type: "gameStop",
        label: "Game stops",
        hint: "You quit a game (any or specific ones)",
        icon: "gamepadOff",
        sources: ["game"],
        create: () => ({ type: "gameStop", games: [] }),
        summary: cfg => cfg.games?.length ? cfg.games.join(", ") : "any game",
        test(cfg, input) {
            if (input.source !== "game") return null;
            const game = input.stopped.find(g => gameMatches(cfg, g));
            return game && !input.running.some(g => gameMatches(cfg, g)) ? { title: "Game stopped", body: game } : null;
        },
        testEnd(cfg, input) {
            return input.source === "game" && input.started.some(g => gameMatches(cfg, g));
        }
    },

    time: {
        type: "time",
        label: "Time of day",
        hint: "At a fixed time on selected weekdays (reminders for single messages: right-click → “Remind me…”)",
        icon: "clock",
        sources: ["tick"],
        create: () => ({ type: "time", time: "20:00", days: [1, 2, 3, 4, 5], note: "" }),
        summary(cfg) {
            const days = (cfg.days ?? []) as number[];
            const dayText = days.length === 7 ? "daily" : days.length ? [1, 2, 3, 4, 5, 6, 0].filter(d => days.includes(d)).map(d => WEEKDAYS[d]).join(", ") : "never";
            return `${cfg.time} · ${dayText}`;
        },
        test(cfg, input) {
            if (input.source !== "tick") return null;
            const { now } = input;
            if (!(cfg.days ?? []).includes(now.getDay())) return null;
            if (hhmm(now) !== cfg.time) return null;
            const key = now.toDateString();
            if (timeFired.get(cfg) === key) return null;
            timeFired.set(cfg, key);
            return { title: `It is ${cfg.time}`, body: cfg.note || "Time rule triggered" };
        }
    }
};

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const timeFired = new WeakMap<TriggerConfig, string>();

export const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

function scopeSummary(scope: any) {
    switch (scope?.mode) {
        case "guilds": return plural(scope.guildIds?.length ?? 0, "server", "servers");
        case "channels": return plural(scope.channelIds?.length ?? 0, "channel", "channels");
        case "dms": return "DMs only";
        default: return "everywhere";
    }
}

function voiceSummary(cfg: TriggerConfig, verb: string) {
    const who = cfg.userIds?.length
        ? cfg.userIds.map((id: string) => { const u = UserStore.getUser(id); return u ? userName(u) : id; }).slice(0, 3).join(", ") + (cfg.userIds.length > 3 ? " …" : "")
        : "Someone";
    return `${who} ${verb} ${cfg.where === "mine" ? "your channel" : "any channel"}`;
}

function voiceUserMatches(cfg: TriggerConfig, userId: string) {
    // Without a selection this only makes sense for "my channel", otherwise every voice movement would fire
    if (!cfg.userIds?.length) return cfg.where === "mine";
    return cfg.userIds.includes(userId);
}

function voiceHit(userId: string, guildId: string | null | undefined, channelId: string, what: string): Hit {
    const user = UserStore.getUser(userId);
    return {
        title: `${userName(user, guildId)} ${what}`,
        body: `Channel ${placeLabel(guildId ?? ChannelStore.getChannel(channelId)?.guild_id ?? null, channelId).replace(/^#/, "")}`,
        guildId: guildId ?? ChannelStore.getChannel(channelId)?.guild_id ?? null,
        channelId,
        userId,
        icon: avatarUrl(user)
    };
}

function gameMatches(cfg: TriggerConfig, game: string) {
    const wanted = (cfg.games ?? []) as string[];
    if (!wanted.length) return true;
    const g = game.toLowerCase();
    return wanted.some(w => w.trim() && g.includes(w.trim().toLowerCase()));
}

// ---------------------------------------------------------------- Actions

/** Status a rule has set, and the previous one (for restoring) */
const savedStatus = new Map<string, { previous: string; setTo: string; }>();

export const ACTIONS: Record<ActionType, ActionDef> = {
    notify: {
        type: "notify",
        label: "Notification",
        hint: "Desktop notification - clicking jumps to the message or channel",
        icon: "bell",
        noisy: true,
        create: () => ({ type: "notify", permanent: false }),
        summary: a => a.permanent ? "stays until clicked" : "Notification",
        run(a, hit, rule) {
            showNotification({
                title: `${hit.tag ? `[${hit.tag}] ` : ""}${hit.title}`,
                body: `${rule.name}: ${hit.body}`,
                icon: hit.icon,
                permanent: !!a.permanent,
                noPersist: true,
                onClick: hit.channelId ? () => jumpTo(hit) : undefined
            }).catch(e => logger.error("Notification failed", e));
        }
    },

    sound: {
        type: "sound",
        label: "Sound",
        hint: "Short built-in sound",
        icon: "sound",
        noisy: true,
        create: () => ({ type: "sound", sound: "ping", volume: 60 }),
        summary: a => `${SOUNDS[a.sound]?.label ?? a.sound} · ${a.volume}%`,
        run: a => playSound(a.sound, a.volume)
    },

    status: {
        type: "status",
        label: "Set status",
        hint: "Change your own status - for game rules optionally restore it afterwards",
        icon: "moon",
        noisy: false,
        create: () => ({ type: "status", status: "dnd", restore: true }),
        summary: a => `${STATUS_LABELS[a.status as StatusValue] ?? a.status}${a.restore ? " · restore afterwards" : ""}`,
        run(a, _hit, rule) {
            try {
                const current = StatusSetting.getSetting();
                if (current === a.status) return;
                if (a.restore && !savedStatus.has(rule.id)) savedStatus.set(rule.id, { previous: current, setTo: a.status });
                void StatusSetting.updateSetting(a.status);
            } catch (e) {
                logger.error("Could not set status", e);
                showToast("Radar: Could not set status", Toasts.Type.FAILURE);
            }
        },
        end(_a, rule) {
            restoreStatus(rule.id);
        }
    },

    flash: {
        type: "flash",
        label: "Flash taskbar",
        hint: "The Discord icon in the taskbar flashes until you click the window",
        icon: "flash",
        noisy: true,
        create: () => ({ type: "flash" }),
        summary: () => "until focused",
        run() {
            if (document.hasFocus()) return;
            Native?.flashFrame().catch(e => logger.error("Flashing failed", e));
        }
    },

    highlight: {
        type: "highlight",
        label: "Highlight message",
        hint: "Marks the triggering message with a color in the chat (until restart)",
        icon: "highlight",
        noisy: false,
        create: () => ({ type: "highlight", color: "#f0b232" }),
        summary: a => a.color,
        run(a, hit, rule) {
            if (hit.messageId && hit.channelId) addHighlight(hit.channelId, hit.messageId, a.color, rule.name);
        }
    },

    inbox: {
        type: "inbox",
        label: "Add to Radar history",
        hint: "Entry in the history (title bar icon shows unread)",
        icon: "inbox",
        noisy: false,
        create: () => ({ type: "inbox" }),
        summary: () => "History",
        run(_a, hit, rule) {
            addInboxItem({
                kind: rule.trigger.type,
                ruleId: rule.id,
                ruleName: rule.name,
                title: hit.title,
                body: hit.body,
                guildId: hit.guildId,
                channelId: hit.channelId,
                messageId: hit.messageId,
                icon: hit.icon
            });
        }
    }
};

function restoreStatus(ruleId: string) {
    const saved = savedStatus.get(ruleId);
    if (!saved) return;
    savedStatus.delete(ruleId);
    try {
        // Only restore if the status hasn't been changed manually in the meantime
        if (StatusSetting.getSetting() === saved.setTo) void StatusSetting.updateSetting(saved.previous);
    } catch (e) {
        logger.error("Could not restore status", e);
    }
}

// ---------------------------------------------------------------- Conditions

const toMinutes = (s: string) => {
    const [h, m] = (s ?? "0:0").split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
};

export function conditionsMet(c: Conditions | undefined) {
    if (!c) return true;
    if (c.onlyUnfocused && document.hasFocus()) return false;
    if (c.skipWhenDnd) {
        try {
            if (StatusSetting.getSetting() === "dnd") return false;
        } catch { }
    }
    if (c.hoursEnabled) {
        const now = new Date();
        const cur = now.getHours() * 60 + now.getMinutes();
        const from = toMinutes(c.hoursFrom);
        const to = toMinutes(c.hoursTo);
        // Support time windows that span midnight (e.g. 22:00–06:00)
        const inside = from <= to ? cur >= from && cur < to : cur >= from || cur < to;
        if (!inside) return false;
    }
    return true;
}

// ---------------------------------------------------------------- Firing

let active = false;
const lastNoisy = new Map<string, number>();

export function setEngineActive(on: boolean) {
    active = on;
    if (!on) {
        for (const id of [...savedStatus.keys()]) restoreStatus(id);
        lastNoisy.clear();
        clearHighlights();
    }
}

export function fireRule(rule: Rule, hit: Hit, { ignoreCooldown = false } = {}) {
    const cooldown = Math.max(0, settings.store.cooldown ?? 10) * 1000;
    const now = Date.now();
    const noisyAllowed = ignoreCooldown || now - (lastNoisy.get(rule.id) ?? 0) >= cooldown;
    let ranNoisy = false;

    for (const a of rule.actions) {
        const def = ACTIONS[a.type];
        if (!def) continue;
        if (def.noisy && !noisyAllowed) continue;
        try {
            def.run(a, hit, rule);
            if (def.noisy) ranNoisy = true;
        } catch (e) {
            logger.error(`Action "${a.type}" of rule "${rule.name}" failed`, e);
        }
    }
    if (ranNoisy) lastNoisy.set(rule.id, now);
}

function endRule(rule: Rule) {
    for (const a of rule.actions) {
        try {
            ACTIONS[a.type]?.end?.(a, rule);
        } catch (e) {
            logger.error(`End action "${a.type}" failed`, e);
        }
    }
}

export function processInput(input: EngineInput) {
    if (!active || !rulesStore.loaded) return;
    for (const rule of rulesStore.value) {
        if (!rule.enabled) continue;
        const def = TRIGGERS[rule.trigger?.type];
        if (!def || !def.sources.includes(input.source)) continue;
        try {
            if (def.testEnd?.(rule.trigger, input)) endRule(rule);
            const hit = def.test(rule.trigger, input);
            if (hit && conditionsMet(rule.conditions)) fireRule(rule, hit);
        } catch (e) {
            logger.error(`Rule "${rule.name}" failed`, e);
        }
    }
}

/** Try a rule with a sample hit (editor → "Test") */
export function testRule(rule: Rule) {
    const channelId = SelectedChannelStore.getChannelId();
    const channel = channelId ? ChannelStore.getChannel(channelId) : null;
    const me = UserStore.getCurrentUser();
    // Don't change the real status while testing
    const hasStatus = rule.actions.some(a => a.type === "status");
    if (hasStatus) showToast("Test: status will not be changed", Toasts.Type.MESSAGE);
    fireRule({ ...rule, id: `test-${rule.id}`, actions: rule.actions.filter(a => a.type !== "status") }, {
        title: `Test: ${rule.name || "New rule"}`,
        body: "This is what a hit of this rule looks like.",
        guildId: channel?.guild_id ?? null,
        channelId: channelId ?? undefined,
        icon: avatarUrl(me)
    }, { ignoreCooldown: true });
}

// ---------------------------------------------------------------- Message snapshot

export function snapshotMessage(message: any): MessageSnapshot {
    const channelId: string = message.channel_id;
    const channel = ChannelStore.getChannel(channelId);
    const guildId = channel?.guild_id ?? null;
    const guild = guildId ? GuildStore.getGuild(guildId) : null;
    const ts = message.timestamp;
    const timestamp = typeof ts?.valueOf === "function" ? Number(ts.valueOf()) : Date.parse(ts) || Date.now();

    let content: string = message.content ?? "";
    if (!content && message.embeds?.length) content = message.embeds[0]?.rawDescription ?? message.embeds[0]?.description ?? "[Embed]";

    return {
        guildId,
        channelId,
        messageId: message.id,
        authorId: message.author?.id,
        authorName: userName(message.author, guildId),
        authorAvatar: avatarUrl(message.author),
        content: excerpt(content, 400),
        timestamp,
        attachments: message.attachments?.length ?? 0,
        guildName: guild?.name,
        channelName: channel?.name ?? (channel ? "Direct message" : undefined)
    };
}

// ---------------------------------------------------------------- Highlights

export interface HighlightInfo {
    channelId: string;
    color: string;
    ruleName: string;
}

export const highlights = new Map<string, HighlightInfo>();
export const highlightSignal = new Signal();
let highlightStyle: HTMLStyleElement | null = null;

const safeColor = (c: string) => /^#[0-9a-f]{6}$/i.test(c) ? c : "#f0b232";
const safeId = (id: string) => /^\d+$/.test(id) ? id : "0";

function addHighlight(channelId: string, messageId: string, color: string, ruleName: string) {
    highlights.set(messageId, { channelId, color: safeColor(color), ruleName });
    // Cap size: remove oldest first
    while (highlights.size > 300) highlights.delete(highlights.keys().next().value!);
    renderHighlightCss();
}

export function removeHighlight(messageId: string) {
    if (highlights.delete(messageId)) renderHighlightCss();
}

function clearHighlights() {
    highlights.clear();
    highlightStyle?.remove();
    highlightStyle = null;
    highlightSignal.emit();
}

function renderHighlightCss() {
    if (!highlightStyle) {
        highlightStyle = document.createElement("style");
        highlightStyle.id = "vc-radar-highlights";
        document.head.appendChild(highlightStyle);
    }
    highlightStyle.textContent = [...highlights].map(([messageId, h]) =>
        `[id="chat-messages-${safeId(h.channelId)}-${safeId(messageId)}"]{background:color-mix(in srgb,${h.color} 13%,transparent)!important;box-shadow:inset 3px 0 0 ${h.color};}`
    ).join("\n");
    highlightSignal.emit();
}
