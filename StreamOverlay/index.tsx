/*
 * StreamOverlay – Vencord Userplugin
 * Local OBS overlay for voice channels (who is there, who is speaking, chat) – a nicer replacement for Discord StreamKit.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { ChannelStore, GuildMemberStore, GuildStore, MessageStore, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";

import { Background, DEFAULT_PORT, DEFAULTS, Effect, Layout, OverlayConfig, Shape } from "./config";
import type { ServerStatus } from "./native";
import { SettingsPanel } from "./ui";

const logger = new Logger("StreamOverlay");

export const Native = (VencordNative as any)?.pluginHelpers?.StreamOverlay as PluginNative<typeof import("./native")> | undefined;

/** Only for the initial state – afterwards the SPEAKING events count */
const SpeakingStore = findStoreLazy("SpeakingStore");

let running = false;

// ---------------------------------------------------------------- Settings

const push = () => schedulePush();

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    serverEnabled: { type: OptionType.BOOLEAN, description: "Server enabled", default: true, hidden: true, onChange: () => syncServer() },
    port: { type: OptionType.NUMBER, description: "Port", default: DEFAULT_PORT, hidden: true, onChange: () => syncServer() },

    layout: { type: OptionType.STRING, description: "Layout", default: DEFAULTS.layout as Layout, hidden: true, onChange: push },
    showUsers: { type: OptionType.BOOLEAN, description: "Show participants", default: DEFAULTS.showUsers, hidden: true, onChange: push },
    showNames: { type: OptionType.BOOLEAN, description: "Show names", default: DEFAULTS.showNames, hidden: true, onChange: push },
    onlySpeaking: { type: OptionType.BOOLEAN, description: "Only speaking", default: DEFAULTS.onlySpeaking, hidden: true, onChange: push },
    hideMuted: { type: OptionType.BOOLEAN, description: "Hide muted", default: DEFAULTS.hideMuted, hidden: true, onChange: push },
    avatarSize: { type: OptionType.NUMBER, description: "Avatar size", default: DEFAULTS.avatarSize, hidden: true, onChange: push },
    shape: { type: OptionType.STRING, description: "Avatar shape", default: DEFAULTS.shape as Shape, hidden: true, onChange: push },
    effect: { type: OptionType.STRING, description: "Speaking effect", default: DEFAULTS.effect as Effect, hidden: true, onChange: push },
    accent: { type: OptionType.STRING, description: "Accent color", default: DEFAULTS.accent, hidden: true, onChange: push },
    fontSize: { type: OptionType.NUMBER, description: "Font size", default: DEFAULTS.fontSize, hidden: true, onChange: push },
    background: { type: OptionType.STRING, description: "Background", default: DEFAULTS.background as Background, hidden: true, onChange: push },
    showIcons: { type: OptionType.BOOLEAN, description: "Mute/deafen icons", default: DEFAULTS.showIcons, hidden: true, onChange: push },
    showHeader: { type: OptionType.BOOLEAN, description: "Channel name", default: DEFAULTS.showHeader, hidden: true, onChange: push },
    animated: { type: OptionType.BOOLEAN, description: "Animated avatars", default: DEFAULTS.animated, hidden: true, onChange: push },
    chat: { type: OptionType.BOOLEAN, description: "Show chat", default: DEFAULTS.chat, hidden: true, onChange: push },
    chatMax: { type: OptionType.NUMBER, description: "Max. messages", default: DEFAULTS.chatMax, hidden: true, onChange: push },
    chatFade: { type: OptionType.NUMBER, description: "Fade out after (s)", default: DEFAULTS.chatFade, hidden: true, onChange: push }
});

export function getConfig(): OverlayConfig {
    const s = settings.store;
    return {
        layout: s.layout as Layout, showUsers: s.showUsers, showNames: s.showNames, onlySpeaking: s.onlySpeaking, hideMuted: s.hideMuted,
        avatarSize: s.avatarSize, shape: s.shape as Shape, effect: s.effect as Effect, accent: s.accent, fontSize: s.fontSize, background: s.background as Background,
        showIcons: s.showIcons, showHeader: s.showHeader, animated: s.animated, chat: s.chat, chatMax: s.chatMax, chatFade: s.chatFade
    };
}

// ---------------------------------------------------------------- Server status (for the UI)

export let serverStatus: ServerStatus & { pluginActive: boolean; } = { running: false, port: 0, clients: 0, error: null, pluginActive: false };
const statusListeners = new Set<() => void>();

export function onStatusChange(fn: () => void) {
    statusListeners.add(fn);
    return () => void statusListeners.delete(fn);
}

function setStatus(s: Partial<typeof serverStatus>) {
    serverStatus = { ...serverStatus, ...s };
    statusListeners.forEach(fn => fn());
}

export async function refreshStatus() {
    if (!Native) return;
    try {
        setStatus(await Native.serverStatus());
    } catch { }
}

let syncing: Promise<void> = Promise.resolve();

/** Sync the server with the settings (sequentially so start/stop do not overtake each other) */
export function syncServer() {
    syncing = syncing.then(async () => {
        if (!Native) {
            setStatus({ running: false, error: "Only available in the Discord desktop app (needs the Electron main process)." });
            return;
        }
        try {
            if (running && settings.store.serverEnabled) {
                const status = await Native.startServer(Number(settings.store.port) || DEFAULT_PORT);
                setStatus(status);
                if (status.running) pushNow();
                else if (status.error) logger.warn(status.error);
            } else {
                setStatus(await Native.stopServer());
            }
        } catch (e) {
            logger.error("Server control failed", e);
            setStatus({ error: String(e) });
        }
    });
    return syncing;
}

// ---------------------------------------------------------------- Voice channel state

interface Part {
    t: "text" | "emoji";
    v: string;
    url?: string;
}

interface ChatMessage {
    id: string;
    author: string;
    authorId: string;
    avatar: string;
    color?: string;
    parts: Part[];
    ts: number;
}

const MAX_BUFFER = 50;

const speaking = new Set<string>();
let channelId: string | null = null;
let messages: ChatMessage[] = [];

function defaultAvatar(userId: string) {
    let index = 0;
    try {
        index = Number((BigInt(userId) >> 22n) % 6n);
    } catch { }
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/** Discord returns local asset paths for default avatars – OBS does not know those */
function absoluteAvatar(url: string | null | undefined, userId: string) {
    return url && /^https:\/\//.test(url) ? url : defaultAvatar(userId);
}

function avatarUrls(user: any, userId: string, guildId: string | null) {
    const size = Math.min(256, Math.max(64, Math.ceil(settings.store.avatarSize * 2 / 32) * 32));
    let stat: string | undefined;
    let anim: string | undefined;
    try {
        stat = user?.getAvatarURL?.(guildId, size, false);
        anim = user?.getAvatarURL?.(guildId, size, true);
    } catch { }
    const avatar = absoluteAvatar(stat, userId);
    const animated = absoluteAvatar(anim, userId);
    return { avatar, avatarAnimated: animated !== avatar ? animated : undefined };
}

function displayName(userId: string, guildId: string | null, fallback?: any) {
    const user: any = UserStore.getUser(userId) ?? fallback;
    const nick = guildId ? GuildMemberStore.getNick(guildId, userId) : null;
    return nick || user?.globalName || user?.global_name || user?.username || "Unknown";
}

// ---------------------------------------------------------------- Chat messages

/** Message text → plain-text parts with custom emojis as images */
function parseContent(content: string, guildId: string | null): Part[] {
    let text = content
        .replace(/<@!?(\d+)>/g, (_, id) => "@" + displayName(id, guildId))
        .replace(/<#(\d+)>/g, (_, id) => "#" + (ChannelStore.getChannel(id)?.name ?? "channel"))
        .replace(/<@&(\d+)>/g, "@Role")
        .replace(/<t:(\d+)(?::[a-zA-Z])?>/g, (_, t) => new Date(Number(t) * 1000).toLocaleString())
        .replace(/\|\|([\s\S]+?)\|\|/g, "▮▮▮")
        .replace(/```[a-z]*\n?([\s\S]*?)```/g, "$1")
        .replace(/(\*\*|__|~~|`)(.+?)\1/g, "$2")
        .replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$)/g, "$1$2")
        .replace(/^(#{1,3}|-#|>) /gm, "");

    if (text.length > 400) text = text.slice(0, 400) + "…";

    const parts: Part[] = [];
    const re = /<(a?):(\w+):(\d+)>/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        if (m.index > last) parts.push({ t: "text", v: text.slice(last, m.index) });
        parts.push({ t: "emoji", v: m[2], url: `https://cdn.discordapp.com/emojis/${m[3]}.${m[1] ? "gif" : "webp"}?size=64&quality=lossless` });
        last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ t: "text", v: text.slice(last) });
    return parts;
}

/** Normalizes both MessageRecords (store) and raw gateway messages (Flux) */
function toChatMessage(msg: any, guildId: string | null): ChatMessage | null {
    if (!msg?.id || !msg.author) return null;
    // Only normal messages and replies, no system messages
    if (msg.type != null && msg.type !== 0 && msg.type !== 19) return null;

    const authorId = msg.author.id;
    const user = UserStore.getUser(authorId) ?? msg.author;
    let parts = parseContent(msg.content ?? "", guildId);

    if (!parts.some(p => p.t === "emoji" || p.v.trim())) {
        const hasFiles = (msg.attachments?.length ?? 0) > 0;
        const hasSticker = (msg.stickerItems ?? msg.sticker_items ?? []).length > 0;
        if (hasFiles) parts = [{ t: "text", v: "📎 Attachment" }];
        else if (hasSticker) parts = [{ t: "text", v: "Sticker" }];
        else if ((msg.embeds?.length ?? 0) > 0) parts = [{ t: "text", v: "🔗 Link" }];
        else return null;
    }

    const member: any = guildId ? GuildMemberStore.getMember(guildId, authorId) : null;
    const ts = Number(new Date(msg.timestamp ?? Date.now()));

    return {
        id: msg.id,
        authorId,
        author: displayName(authorId, guildId, msg.author),
        avatar: avatarUrls(user, authorId, guildId).avatar,
        color: member?.colorString || undefined,
        parts,
        ts: Number.isFinite(ts) ? ts : Date.now()
    };
}

function guildOf(cid: string | null) {
    return cid ? ChannelStore.getChannel(cid)?.guild_id ?? null : null;
}

function seedMessages(cid: string) {
    const guildId = guildOf(cid);
    const cached: any[] = (MessageStore.getMessages(cid) as any)?._array ?? [];
    return cached.slice(-MAX_BUFFER).map(m => toChatMessage(m, guildId)).filter(Boolean) as ChatMessage[];
}

function seedSpeaking(cid: string) {
    speaking.clear();
    try {
        for (const userId of Object.keys(VoiceStateStore.getVoiceStatesForChannel(cid) ?? {})) {
            if (SpeakingStore?.isSpeaking?.(userId)) speaking.add(userId);
        }
    } catch { }
}

// ---------------------------------------------------------------- Build & send state

function buildState() {
    const cid = SelectedChannelStore.getVoiceChannelId() ?? null;
    if (cid !== channelId) {
        channelId = cid;
        messages = cid ? seedMessages(cid) : [];
        if (cid) seedSpeaking(cid);
        else speaking.clear();
    }

    const config = getConfig();
    if (!cid) return { config, channel: null, users: [], messages: [] };

    const channel: any = ChannelStore.getChannel(cid);
    const guildId: string | null = channel?.guild_id ?? null;
    const guild = guildId ? GuildStore.getGuild(guildId) : null;

    const states = VoiceStateStore.getVoiceStatesForChannel(cid) ?? {};
    const users = Object.values(states).map((vs: any) => {
        const user: any = UserStore.getUser(vs.userId);
        return {
            id: vs.userId,
            name: displayName(vs.userId, guildId),
            ...avatarUrls(user, vs.userId, guildId),
            speaking: speaking.has(vs.userId),
            selfMute: !!vs.selfMute,
            selfDeaf: !!vs.selfDeaf,
            mute: !!(vs.mute || vs.suppress),
            deaf: !!vs.deaf,
            stream: !!vs.selfStream,
            video: !!vs.selfVideo
        };
    }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    let channelName: string = channel?.name || "";
    if (!channelName && channel?.recipients?.length) {
        channelName = channel.recipients.map((id: string) => displayName(id, null)).join(", ");
    }

    return {
        config,
        channel: { id: cid, name: channelName || "Call", guild: guild?.name ?? null },
        users,
        messages: config.chat ? messages : []
    };
}

let pushTimer: ReturnType<typeof setTimeout> | undefined;

export function pushNow() {
    clearTimeout(pushTimer);
    pushTimer = undefined;
    if (!running || !Native || !serverStatus.running) return;
    try {
        Native.pushState(JSON.stringify(buildState()));
    } catch (e) {
        logger.error("State could not be sent", e);
    }
}

function schedulePush() {
    if (pushTimer) return;
    pushTimer = setTimeout(pushNow, 50);
}

// ---------------------------------------------------------------- Flux

function onSpeaking({ userId, speakingFlags, speaking: legacy, context }: { userId: string; speakingFlags?: number; speaking?: boolean; context?: string; }) {
    if (context && context !== "default") return;
    const now = speakingFlags != null ? speakingFlags !== 0 : !!legacy;
    if (speaking.has(userId) === now) return;
    if (now) speaking.add(userId);
    else speaking.delete(userId);
    // Only relevant if the person is in our channel – then send immediately
    if (channelId && VoiceStateStore.getVoiceStateForChannel(channelId, userId)) pushNow();
}

function onVoiceStateUpdates({ voiceStates }: { voiceStates: { userId: string; channelId?: string | null; }[]; }) {
    for (const vs of voiceStates ?? []) {
        if (vs.channelId !== channelId) speaking.delete(vs.userId);
    }
    schedulePush();
}

function onMessageCreate({ channelId: cid, message, optimistic }: { channelId: string; message: any; optimistic?: boolean; }) {
    if (optimistic || !channelId || cid !== channelId) return;
    if (messages.some(m => m.id === message?.id)) return;
    const msg = toChatMessage(message, guildOf(cid));
    if (!msg) return;
    messages.push(msg);
    if (messages.length > MAX_BUFFER) messages.splice(0, messages.length - MAX_BUFFER);
    if (settings.store.chat) schedulePush();
}

function onMessageUpdate({ message }: { message: any; }) {
    if (!channelId || message?.channel_id !== channelId || message.content == null) return;
    const i = messages.findIndex(m => m.id === message.id);
    if (i === -1) return;
    messages[i] = { ...messages[i], parts: parseContent(message.content, guildOf(channelId)) };
    if (settings.store.chat) schedulePush();
}

function onMessageDelete({ id, ids, channelId: cid }: { id?: string; ids?: string[]; channelId: string; }) {
    if (!channelId || cid !== channelId) return;
    const gone = new Set(ids ?? (id ? [id] : []));
    const before = messages.length;
    messages = messages.filter(m => !gone.has(m.id));
    if (messages.length !== before && settings.store.chat) schedulePush();
}

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "StreamOverlay",
    description: "OBS overlay for voice channels: participants, who is speaking and chat as a browser source – a nicer replacement for Discord StreamKit",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Voice", "Utility"],
    settings,

    flux: {
        SPEAKING: onSpeaking,
        VOICE_STATE_UPDATES: onVoiceStateUpdates,
        VOICE_CHANNEL_SELECT: schedulePush,
        MESSAGE_CREATE: onMessageCreate,
        MESSAGE_UPDATE: onMessageUpdate,
        MESSAGE_DELETE: onMessageDelete,
        MESSAGE_DELETE_BULK: onMessageDelete
    },

    start() {
        running = true;
        channelId = null;
        setStatus({ pluginActive: true });
        syncServer();
    },

    stop() {
        running = false;
        clearTimeout(pushTimer);
        pushTimer = undefined;
        speaking.clear();
        messages = [];
        channelId = null;
        setStatus({ pluginActive: false });
        syncServer();
    }
});
