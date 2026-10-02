/*
 * ChatPopout – call bar (collapsible list of the people in the call) and voice actions for the
 * right-click menu: volume, mute, server mute/deafen, move, disconnect
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classes } from "@utils/misc";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { GuildChannelStore, MediaEngineStore, PermissionsBits, PermissionStore, RestAPI, SelectedChannelStore, showToast, Toasts, UserStore, useState, useStateFromStores, VoiceStateStore } from "@webpack/common";

import { isInCall, openCallPopout, settings } from "./index";
import { MenuItem } from "./menu";
import { CALL_PATH, CHEVRON_PATH, cl, DEAF_PATH, displayName, Icon, log, MUTE_PATH, SPEAKER_PATH, tip, userAvatar } from "./shared";

const VoiceActions = findByPropsLazy("toggleSelfMute", "toggleSelfDeaf");
const ChannelActions = findByPropsLazy("selectVoiceChannel", "selectChannel");
const SpeakingStore = findStoreLazy("SpeakingStore");

const VOICE_TYPES = new Set([2, 13]);
const SCREEN_PATH = "M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6v2h3a1 1 0 1 1 0 2H7a1 1 0 1 1 0-2h3v-2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v10h16V6H4Z";

interface Person {
    id: string;
    selfMute: boolean;
    selfDeaf: boolean;
    serverMute: boolean;
    serverDeaf: boolean;
    live: boolean;
}

function useCallPeople(channelId: string): Person[] {
    // As a string so the store hook compares a stable value
    const key = useStateFromStores([VoiceStateStore], () => {
        const states = VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {};
        return Object.values(states as Record<string, any>)
            .map(s => `${s.userId}:${+!!s.selfMute}${+!!s.selfDeaf}${+!!s.mute}${+!!s.deaf}${+!!s.selfStream}`)
            .join(",");
    });
    if (!key) return [];
    return key.split(",").map(p => {
        const [id, f] = p.split(":");
        return { id, selfMute: f[0] === "1", selfDeaf: f[1] === "1", serverMute: f[2] === "1", serverDeaf: f[3] === "1", live: f[4] === "1" };
    });
}

// ---------------------------------------------------------------- List

function VoiceRow({ p, guildId }: { p: Person; guildId: string | null; }) {
    const speaking = useStateFromStores([SpeakingStore], () => !!SpeakingStore.isSpeaking?.(p.id));
    const localMute = useStateFromStores([MediaEngineStore], () => p.id !== UserStore.getCurrentUser()?.id && MediaEngineStore.isLocalMute(p.id));
    const deaf = p.selfDeaf || p.serverDeaf;
    const muted = p.selfMute || p.serverMute || localMute;

    return (
        <div className={cl("voice-row")} data-user-id={p.id}>
            <span className={classes(cl("voice-row-avatar"), speaking && cl("voice-speaking"))}>
                <img src={userAvatar(p.id, UserStore.getUser(p.id), 48)} alt="" />
            </span>
            <span className={cl("voice-row-name")}>{displayName(p.id, guildId)}</span>
            {p.live && <span className={classes(cl("voice-row-live"), cl("live-btn"))} data-stream-user={p.id} {...tip("Watch stream", "top", "end")}>LIVE</span>}
            {muted && !deaf && (
                <span className={classes(cl("voice-row-icon"), (p.serverMute || localMute) && cl("voice-row-icon-red"))} {...tip(p.serverMute ? "Server muted" : localMute ? "Muted by you" : "Muted", "top", "end")}>
                    <Icon path={MUTE_PATH} size={14} />
                </span>
            )}
            {deaf && (
                <span className={classes(cl("voice-row-icon"), p.serverDeaf && cl("voice-row-icon-red"))} {...tip(p.serverDeaf ? "Server deafened" : "Deafened", "top", "end")}>
                    <Icon path={DEAF_PATH} size={14} />
                </span>
            )}
        </div>
    );
}

export function VoiceBar({ channelId, guildId }: { channelId: string; guildId: string | null; }) {
    const people = useCallPeople(channelId);
    const inCall = useStateFromStores([SelectedChannelStore], () => isInCall(channelId));
    const { voiceListOpen: open } = settings.use(["voiceListOpen"]);

    if (!people.length) return null;
    const toggle = () => settings.store.voiceListOpen = !open;

    return (
        <div className={classes(cl("voice-wrap"), open && cl("voice-wrap-open"))}>
            <div className={cl("voice")}>
                <span className={cl("voice-dot")} />
                {!open && (
                    <div className={cl("voice-people")}>
                        {people.slice(0, 10).map(p => (
                            <span key={p.id} className={cl("voice-person")} data-user-id={p.id} {...tip(displayName(p.id, guildId) + (p.live ? " (live)" : ""), "bottom", "start")}>
                                <img src={userAvatar(p.id, UserStore.getUser(p.id), 48)} alt="" />
                                {(p.selfDeaf || p.serverDeaf || p.selfMute || p.serverMute) && (
                                    <span className={cl("voice-flag")}><Icon path={p.selfDeaf || p.serverDeaf ? DEAF_PATH : MUTE_PATH} size={10} /></span>
                                )}
                                {p.live && <span className={classes(cl("voice-live"), cl("live-btn"))} data-stream-user={p.id}>LIVE</span>}
                            </span>
                        ))}
                        {people.length > 10 && <span className={cl("voice-more")}>+{people.length - 10}</span>}
                    </div>
                )}
                <button className={cl("voice-toggle")} onClick={toggle} {...tip(open ? "Collapse list" : "Show everyone in the call", "bottom", "start")}>
                    {people.length === 1 ? "1 in call" : `${people.length} in call`}
                    <Icon path={CHEVRON_PATH} size={14} className={classes(cl("voice-chevron"), open && cl("voice-chevron-open"))} />
                </button>
                {inCall && (
                    <button className={cl("voice-btn")} onClick={() => openCallPopout(channelId)} {...tip("Discord's call window with cameras & streams", "bottom", "end")}>
                        <Icon path={CALL_PATH} size={14} /> Call Window
                    </button>
                )}
            </div>
            {open && (
                <div className={cl("voice-list")}>
                    {people.map(p => <VoiceRow key={p.id} p={p} guildId={guildId} />)}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------- Right-click: voice actions

export type AudioContext = "default" | "stream";

export function setUserVolume(userId: string, volume: number, context: AudioContext = "default") {
    try {
        VoiceActions.setLocalVolume(userId, volume, context);
    } catch (err) {
        log.error("Couldn't set volume", err);
    }
}

export function toggleUserMute(userId: string, context: AudioContext = "default") {
    try {
        VoiceActions.toggleLocalMute(userId, context);
    } catch (err) {
        log.error("Couldn't toggle mute", err);
    }
}

export function VolumeSlider({ userId, context = "default", label = "User Volume" }: { userId: string; context?: AudioContext; label?: string; }) {
    const [value, setValue] = useState(() => Math.round(MediaEngineStore.getLocalVolume(userId, context as any) ?? 100));
    return (
        <div className={cl("volume")}>
            <div className={cl("volume-head")}>
                <span>{label}</span>
                <span className={cl("volume-value")}>{value}%</span>
            </div>
            <input
                className={cl("volume-slider")}
                type="range"
                min={0}
                max={200}
                step={1}
                value={value}
                style={{ "--fill": `${value / 2}%` } as React.CSSProperties}
                onChange={e => {
                    const v = Number(e.currentTarget.value);
                    setValue(v);
                    setUserVolume(userId, v, context);
                }}
            />
        </div>
    );
}

function patchMember(guildId: string, userId: string, body: Record<string, unknown>, what: string) {
    RestAPI.patch({ url: `/guilds/${guildId}/members/${userId}`, body }).catch((e: any) => {
        log.error(`Couldn't ${what}`, e);
        showToast(e?.body?.message ? `Couldn't ${what}: ${e.body.message}` : `Couldn't ${what}`, Toasts.Type.FAILURE);
    });
}

/** Voice sections for the right-click menu – only for people in this channel's call */
export function voiceMenuSections(userId: string, channel: any, onWatch?: (userId: string) => void): MenuItem[][] {
    if (!channel) return [];
    const stateOf = () => (VoiceStateStore.getVoiceStatesForChannel(channel.id) ?? {})[userId] as any;
    if (!stateOf()) return [];

    const me = UserStore.getCurrentUser()?.id;
    const self = userId === me;
    const guildId: string | null = channel.guild_id ?? null;
    const sections: MenuItem[][] = [];

    if (onWatch && stateOf()?.selfStream) {
        sections.push([{ id: "watch", label: self ? "Preview Your Stream" : "Watch Stream", icon: SCREEN_PATH, action: () => onWatch(userId) }]);
    }

    sections.push(self ? [
        { id: "self-mute", label: "Mute", checked: () => MediaEngineStore.isSelfMute(), action: () => VoiceActions.toggleSelfMute() },
        { id: "self-deaf", label: "Deafen", checked: () => MediaEngineStore.isSelfDeaf(), action: () => VoiceActions.toggleSelfDeaf() }
    ] : [
        { id: "volume", label: "User Volume", render: () => <VolumeSlider userId={userId} /> },
        { id: "local-mute", label: "Mute", checked: () => MediaEngineStore.isLocalMute(userId), action: () => toggleUserMute(userId) }
    ]);

    const mod: MenuItem[] = [];
    if (guildId) {
        const can = (perm: bigint) => PermissionStore.can(perm, channel);
        if (can(PermissionsBits.MUTE_MEMBERS)) {
            mod.push({ id: "server-mute", label: "Server Mute", checked: () => !!stateOf()?.mute, action: () => patchMember(guildId, userId, { mute: !stateOf()?.mute }, "server mute") });
        }
        if (can(PermissionsBits.DEAFEN_MEMBERS)) {
            mod.push({ id: "server-deaf", label: "Server Deafen", checked: () => !!stateOf()?.deaf, action: () => patchMember(guildId, userId, { deaf: !stateOf()?.deaf }, "server deafen") });
        }
        if (can(PermissionsBits.MOVE_MEMBERS)) {
            mod.push({
                id: "move",
                label: "Move To",
                submenu: () => {
                    const all = (GuildChannelStore.getChannels(guildId)?.VOCAL ?? []).map((c: any) => c.channel)
                        .filter((c: any) => c && VOICE_TYPES.has(c.type) && c.id !== channel.id);
                    if (!all.length) return [{ id: "none", label: "No other voice channels", action: () => { } }];
                    return all.map((c: any) => {
                        const count = Object.keys(VoiceStateStore.getVoiceStatesForChannel(c.id) ?? {}).length;
                        return {
                            id: `move-${c.id}`,
                            label: count ? `${c.name} (${count})` : c.name,
                            icon: SPEAKER_PATH,
                            action: () => self
                                ? ChannelActions.selectVoiceChannel(c.id)
                                : patchMember(guildId, userId, { channel_id: c.id }, "move")
                        };
                    });
                }
            });
        }
        if (!self && can(PermissionsBits.MOVE_MEMBERS)) {
            mod.push({ id: "disconnect", label: "Disconnect", danger: true, action: () => patchMember(guildId, userId, { channel_id: null }, "disconnect") });
        }
    }
    if (self) mod.push({ id: "disconnect", label: "Disconnect", danger: true, action: () => ChannelActions.selectVoiceChannel(null) });
    if (mod.length) sections.push(mod);

    return sections;
}
