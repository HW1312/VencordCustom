/*
 * Radar – Vencord Userplugin
 * Local if-then rules (keywords, mentions, voice, games, time of day), reminders and bookmarks.
 * All actions run only on your side - Radar never sends messages.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { ChannelStore, Menu, RunningGameStore, VoiceStateStore } from "@webpack/common";

import { processInput, setEngineActive } from "./engine";
import { addReminder, findBookmark, getQuickPicks, startReminders, stopReminders } from "./reminders";
import { closeAudio } from "./sounds";
import { ALL_STORES, logger, markAllRead } from "./store";
import { HighlightChip, openBookmarkModal, openRadarModal, openReminderModal, renderTitleBarButton, SettingsPanel } from "./ui";

const Native = VencordNative.pluginHelpers.Radar as PluginNative<typeof import("./native")>;

let running = false;

// ---------------------------------------------------------------- Settings

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    showTitleBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show the Radar icon in the title bar",
        default: true,
        hidden: true
    },
    cooldown: {
        type: OptionType.NUMBER,
        description: "Minimum interval in seconds between notifications from the same rule",
        default: 10,
        hidden: true
    },
    reminderSound: {
        type: OptionType.STRING,
        description: "Sound for reminders",
        default: "chime",
        hidden: true
    },
    reminderVolume: {
        type: OptionType.NUMBER,
        description: "Volume for reminders",
        default: 60,
        hidden: true
    },
    reminderFlash: {
        type: OptionType.BOOLEAN,
        description: "Flash the taskbar on reminders",
        default: true,
        hidden: true
    },
    /** Last opened tab */
    lastTab: { type: OptionType.STRING, description: "internal", default: "inbox", hidden: true }
});

// ---------------------------------------------------------------- Messages

/** Messages already processed (MESSAGE_CREATE can arrive twice) */
const seenMessages = new Set<string>();

function onMessageCreate({ message, optimistic, isPushNotification, channelId }: any) {
    if (!running || optimistic || isPushNotification || !message?.id) return;
    if (seenMessages.has(message.id)) return;
    seenMessages.add(message.id);
    if (seenMessages.size > 1000) seenMessages.delete(seenMessages.values().next().value!);

    const chId: string = message.channel_id ?? channelId;
    const guildId: string | null = message.guild_id ?? ChannelStore.getChannel(chId)?.guild_id ?? null;
    processInput({ source: "message", message, guildId, channelId: chId });
}

// ---------------------------------------------------------------- Voice

/** Last known voice channel per user (in case Discord doesn't send oldChannelId) */
const lastVoice = new Map<string, string>();

function seedVoiceStates() {
    lastVoice.clear();
    try {
        const all = VoiceStateStore.getAllVoiceStates();
        for (const users of Object.values(all ?? {}))
            for (const [userId, vs] of Object.entries(users ?? {}))
                if (vs?.channelId) lastVoice.set(userId, vs.channelId);
    } catch (e) {
        logger.error("Could not read voice state", e);
    }
}

function onVoiceStateUpdates({ voiceStates }: { voiceStates: any[]; }) {
    if (!running || !Array.isArray(voiceStates)) return;
    for (const vs of voiceStates) {
        if (!vs?.userId) continue;
        const prev: string | null = vs.oldChannelId ?? lastVoice.get(vs.userId) ?? null;
        const channelId: string | null = vs.channelId ?? null;
        if (channelId) lastVoice.set(vs.userId, channelId);
        else lastVoice.delete(vs.userId);
        if (prev === channelId) continue;
        processInput({ source: "voice", userId: vs.userId, guildId: vs.guildId ?? null, channelId, prevChannelId: prev });
    }
}

// ---------------------------------------------------------------- Games

let runningGames = new Set<string>();

const gameNames = (games: any[] | undefined) => new Set((games ?? []).map(g => g?.name).filter(Boolean) as string[]);

function onRunningGamesChange({ games }: { games?: any[]; }) {
    if (!running) return;
    const now = gameNames(games ?? RunningGameStore.getRunningGames());
    const started = [...now].filter(g => !runningGames.has(g));
    const stopped = [...runningGames].filter(g => !now.has(g));
    runningGames = now;
    if (started.length || stopped.length) processInput({ source: "game", started, stopped, running: [...now] });
}

// ---------------------------------------------------------------- Context menu

const messageContextMenu: NavContextMenuPatchCallback = (children, { message }: { message: any; }) => {
    if (!message?.id || !message.channel_id) return;
    const bookmarked = !!findBookmark(message.id);

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem id="vc-radar-remind" label="Remind me…">
                {getQuickPicks().map(p => (
                    <Menu.MenuItem key={p.id} id={`vc-radar-remind-${p.id}`} label={p.label} action={() => addReminder(p.at(), "", message)} />
                ))}
                <Menu.MenuSeparator />
                <Menu.MenuItem id="vc-radar-remind-custom" label="Custom time / note…" action={() => openReminderModal(message)} />
            </Menu.MenuItem>
            <Menu.MenuItem
                id="vc-radar-bookmark"
                label={bookmarked ? "Edit bookmark" : "Add bookmark"}
                action={() => openBookmarkModal(message)}
            />
        </Menu.MenuGroup>
    );
};

// ---------------------------------------------------------------- Plugin

let tickTimer: ReturnType<typeof setInterval> | undefined;

const plugin = definePlugin({
    name: "Radar",
    description: "Local if-then rules: keyword alerts, mentions, friends in voice, status while gaming - plus reminders and bookmarks for messages",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Notifications", "Utility"],
    dependencies: ["UserSettingsAPI"],
    settings,

    patches: [
        {
            // Title bar on the left (next to back/forward & inbox): append the button at the end.
            // Order of plugin icons = plugin load order (alphabetical by folder).
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(leading:.{0,600}?)\]\}\),title:/,
                replace: "$1,$self.renderTitleBarButton()]}),title:"
            }
        }
    ],

    renderTitleBarButton,

    renderMessageAccessory: props => <HighlightChip message={props.message} />,

    contextMenus: {
        "message": messageContextMenu
    },

    flux: {
        MESSAGE_CREATE: onMessageCreate,
        VOICE_STATE_UPDATES: onVoiceStateUpdates,
        RUNNING_GAMES_CHANGE: onRunningGamesChange
    },

    toolboxActions: {
        "Open Radar": () => openRadarModal(),
        "Mark Radar history as read": () => markAllRead()
    },

    async start() {
        running = true;
        seedVoiceStates();
        try {
            runningGames = gameNames(RunningGameStore.getRunningGames());
        } catch {
            runningGames = new Set();
        }

        await Promise.all(ALL_STORES.map(s => s.load()));
        if (!running) return;

        setEngineActive(true);
        startReminders();
        tickTimer = setInterval(() => processInput({ source: "tick", now: new Date() }), 15_000);
    },

    stop() {
        running = false;
        setEngineActive(false);
        stopReminders();
        clearInterval(tickTimer);
        tickTimer = undefined;
        seenMessages.clear();
        lastVoice.clear();
        runningGames = new Set();
        closeAudio();
        Native?.stopFlash().catch(() => { });
        ALL_STORES.forEach(s => s.flush());
    }
});

export default plugin;
