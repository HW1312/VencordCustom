/*
 * FriendDock – dock list, title bar button, popout & settings
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { plugins } from "@api/PluginManager";
import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { openPluginModal } from "@components/settings";
import { Switch } from "@components/Switch";
import { openPrivateChannel, openUserProfile } from "@utils/discord";
import { classes } from "@utils/misc";
import type { Activity } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import {
    ChannelStore, GuildStore, Popout, PresenceStore, RelationshipStore, SelectedChannelStore, useMemo, useRef,
    UserStore, useState, useStateFromStores, VoiceStateStore
} from "@webpack/common";

import {
    addFavorite, getDisplayName, getJoinBlocker, getMyVoiceChannelId, getVoiceInfo, joinVoice, moveFavorite,
    removeFavorite, settings, stopFollowing, toggleFollow
} from "./index";

const cl = classNameFactory("vc-frienddock-");
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

// ---------------------------------------------------------------- Icons

const FRIENDS_PATH = "M13 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8.5 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM13 12c-4 0-7 2-7 5v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2c0-3-3-5-7-5ZM4.5 12C2 12 0 13.5 0 15.5V17a1 1 0 0 0 1 1h3v-1c0-1.9.8-3.6 2.2-4.8-.5-.1-1.1-.2-1.7-.2Z";
const SPEAKER_PATH = "M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM15.1 20.75c-.58.14-1.1-.33-1.1-.92v-.03c0-.5.37-.92.85-1.05a7 7 0 0 0 0-13.5A1.11 1.11 0 0 1 14 4.2v-.03c0-.6.52-1.06 1.1-.92a9 9 0 0 1 0 17.5Z";
const FOLLOW_PATH = "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 3a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z";
const COG_PATH = "M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1L11 21h4l.4-2.9a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5-2.1-1.6ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z";
const UP_PATH = "M12 7l-6 6h12l-6-6Z";
const DOWN_PATH = "M12 17l6-6H6l6 6Z";
const CLOSE_PATH = "M18.4 4.2 12 10.6 5.6 4.2 4.2 5.6l6.4 6.4-6.4 6.4 1.4 1.4 6.4-6.4 6.4 6.4 1.4-1.4-6.4-6.4 6.4-6.4-1.4-1.4Z";

function Icon({ path, size = 20, className }: { path: string; size?: number; className?: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={classes(cl("icon"), className)}>
            <path fill="currentColor" d={path} />
        </svg>
    );
}

// ---------------------------------------------------------------- Status & activity

type Status = "online" | "idle" | "dnd" | "offline" | "streaming";

const STATUS_LABEL: Record<Status, string> = {
    online: "Online",
    idle: "Idle",
    dnd: "Do Not Disturb",
    offline: "Offline",
    streaming: "Streaming"
};

function getStatus(id: string): Status {
    const activities = PresenceStore.getActivities(id) ?? [];
    if (activities.some(a => a.type === 1)) return "streaming";
    const s = PresenceStore.getStatus(id) as string;
    return s === "online" || s === "idle" || s === "dnd" ? s : "offline";
}

/** One readable line about what the friend is doing (game/Spotify/stream first, custom status as fallback) */
function getActivityText(activities: Activity[]): string | null {
    const main = activities.find(a => a.type !== 4);
    if (main) {
        switch (main.type) {
            case 0: return `Playing ${main.name}`;
            case 1: return `Streaming ${main.details || main.name}`;
            case 2: return main.details
                ? `Listening to ${main.details}${main.state ? ` by ${main.state.replace(/;/g, ",")}` : ""}`
                : `Listening to ${main.name}`;
            case 3: return `Watching ${main.details || main.name}`;
            case 5: return `Competing in ${main.name}`;
            default: return main.name;
        }
    }
    const custom = activities.find(a => a.type === 4);
    if (custom) {
        const emoji = custom.emoji && !custom.emoji.id ? custom.emoji.name + " " : "";
        const text = (emoji + (custom.state ?? "")).trim();
        return text || null;
    }
    return null;
}

const STATUS_RANK: Record<Status, number> = { streaming: 1, online: 1, idle: 2, dnd: 3, offline: 4 };

function useDockIds(): string[] {
    const { favorites, sortByStatus, hideOffline } = settings.use(["favorites", "sortByStatus", "hideOffline"]);

    const key = useStateFromStores([PresenceStore, VoiceStateStore], () => {
        let ids = favorites;
        if (hideOffline) ids = ids.filter(id => getStatus(id) !== "offline" || VoiceStateStore.getVoiceStateForUser(id)?.channelId);
        if (sortByStatus) {
            const rank = (id: string) => VoiceStateStore.getVoiceStateForUser(id)?.channelId ? 0 : STATUS_RANK[getStatus(id)];
            ids = ids
                .map((id, i) => ({ id, i, r: rank(id) }))
                .sort((a, b) => a.r - b.r || a.i - b.i)
                .map(x => x.id);
        }
        return ids.join(",");
    }, [favorites, sortByStatus, hideOffline]);

    return key ? key.split(",") : [];
}

// ---------------------------------------------------------------- Friend row

function Avatar({ id, status }: { id: string; status: Status; }) {
    const user = useStateFromStores([UserStore], () => UserStore.getUser(id));
    return (
        <div className={cl("avatar")} onClick={() => openUserProfile(id)} title="Open profile">
            {user
                ? <img src={user.getAvatarURL(undefined, 64, false)} alt="" />
                : <div className={cl("avatar-fallback")} />}
            <span className={classes(cl("dot"), cl(`dot-${status}`))} title={STATUS_LABEL[status]} />
        </div>
    );
}

function VoiceLine({ id, onAction }: { id: string; onAction?(): void; }) {
    const channelId = useStateFromStores([VoiceStateStore], () => VoiceStateStore.getVoiceStateForUser(id)?.channelId ?? null);
    const myChannelId = useStateFromStores([SelectedChannelStore], getMyVoiceChannelId);
    // Re-render when the channel's participants or names change
    useStateFromStores([VoiceStateStore, ChannelStore, GuildStore], () =>
        channelId ? `${Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {}).length}:${ChannelStore.getChannel(channelId)?.name}` : "", [channelId]);
    const { following } = settings.use(["following"]);

    const isFollowing = following === id;
    const info = getVoiceInfo(channelId);
    const together = channelId != null && channelId === myChannelId;
    const blocker = channelId && !together ? getJoinBlocker(channelId) : null;

    return (
        <div className={cl("voice-row")}>
            {channelId
                ? (
                    <div className={classes(cl("voice"), together && cl("voice-together"))} title={info ? `${info.channelName} - ${info.place}` : "In a voice channel"}>
                        <Icon path={SPEAKER_PATH} size={14} />
                        <span className={cl("voice-text")}>
                            {info
                                ? <>
                                    <b>{info.isPrivate ? info.place : info.channelName}</b>
                                    {!info.isPrivate && <span className={cl("voice-place")}> · {info.place}</span>}
                                </>
                                : <b>In a voice channel you can't see</b>}
                        </span>
                        {info && info.count > 0 && <span className={cl("voice-count")}>{info.count}</span>}
                    </div>
                )
                : <div className={cl("voice-none")}>{isFollowing ? "Waiting for them to join voice…" : "Not in voice"}</div>}

            <div className={cl("voice-actions")}>
                {channelId && !together && (
                    <button
                        className={classes(cl("btn"), cl("btn-brand"))}
                        disabled={!info}
                        title={blocker ?? "Join this voice channel"}
                        onClick={() => { if (joinVoice(channelId)) onAction?.(); }}
                    >
                        Join
                    </button>
                )}
                {together && <span className={cl("together")}>With you</span>}
                <button
                    className={classes(cl("btn"), isFollowing && cl("btn-following"))}
                    title={isFollowing ? "Stop following" : "Follow: move along whenever they switch voice channels"}
                    onClick={() => toggleFollow(id)}
                >
                    <Icon path={FOLLOW_PATH} size={14} />
                    {isFollowing ? "Following" : "Follow"}
                </button>
            </div>
        </div>
    );
}

function FriendRow({ id, onNavigate }: { id: string; onNavigate?(): void; }) {
    const user = useStateFromStores([UserStore], () => UserStore.getUser(id));
    const nick = useStateFromStores([RelationshipStore], () => RelationshipStore.getNickname(id));
    const status = useStateFromStores([PresenceStore], () => getStatus(id));
    const activity = useStateFromStores([PresenceStore], () => getActivityText(PresenceStore.getActivities(id) ?? []));
    const { following } = settings.use(["following"]);

    const name = nick || getDisplayName(user, id);

    return (
        <div className={classes(cl("row"), following === id && cl("row-following"), status === "offline" && cl("row-offline"))}>
            <Avatar id={id} status={status} />
            <div className={cl("row-main")}>
                <div className={cl("row-head")}>
                    <span
                        className={cl("name")}
                        title="Open DM"
                        onClick={() => { openPrivateChannel(id); onNavigate?.(); }}
                    >
                        {name}
                    </span>
                    <span className={cl("status-text")}>{STATUS_LABEL[status]}</span>
                </div>
                {activity && <div className={cl("activity")} title={activity}>{activity}</div>}
                <VoiceLine id={id} onAction={onNavigate} />
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- Dock

function FollowBanner() {
    const { following } = settings.use(["following"]);
    const user = useStateFromStores([UserStore], () => following ? UserStore.getUser(following) : undefined, [following]);
    if (!following) return null;

    return (
        <div className={cl("banner")}>
            <Icon path={FOLLOW_PATH} size={16} />
            <span>Following <b>{getDisplayName(user, following)}</b> in voice</span>
            <button className={cl("btn")} onClick={() => stopFollowing()}>Stop</button>
        </div>
    );
}

function Dock({ onNavigate }: { onNavigate?(): void; }) {
    const { favorites } = settings.use(["favorites"]);
    const ids = useDockIds();

    return (
        <div className={cl("dock")}>
            <FollowBanner />
            {ids.map(id => (
                <ErrorBoundary noop key={id}>
                    <FriendRow id={id} onNavigate={onNavigate} />
                </ErrorBoundary>
            ))}
            {!favorites.length && (
                <div className={cl("empty")}>
                    No favorites yet. Right-click a friend and choose “Add to Friend Dock”, or add them in the settings.
                </div>
            )}
            {favorites.length > 0 && !ids.length && <div className={cl("empty")}>All your favorites are offline.</div>}
        </div>
    );
}

// ---------------------------------------------------------------- Settings

function FavoriteManager() {
    const { favorites } = settings.use(["favorites"]);
    const [query, setQuery] = useState("");

    const friendIds = useStateFromStores([RelationshipStore], () => RelationshipStore.getFriendIDs().join(","));
    const candidates = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        return friendIds.split(",")
            .filter(id => id && !favorites.includes(id))
            .map(id => ({ id, user: UserStore.getUser(id) }))
            .filter(({ id, user }) => {
                const name = getDisplayName(user, id).toLowerCase();
                return name.includes(q) || user?.username.toLowerCase().includes(q);
            })
            .slice(0, 8);
    }, [query, friendIds, favorites]);

    return (
        <div className={cl("manager")}>
            <div className={cl("section-title")}>Favorites</div>

            <input
                className={cl("search")}
                placeholder="Add a friend… (type a name)"
                value={query}
                onChange={e => setQuery(e.currentTarget.value)}
            />
            {candidates.map(({ id, user }) => (
                <div key={id} className={cl("manage-row")}>
                    {user && <img className={cl("mini-avatar")} src={user.getAvatarURL(undefined, 32, false)} alt="" />}
                    <span className={cl("manage-name")}>{getDisplayName(user, id)}</span>
                    <button className={classes(cl("btn"), cl("btn-brand"))} onClick={() => { addFavorite(id); setQuery(""); }}>Add</button>
                </div>
            ))}
            {query.trim() && !candidates.length && <div className={cl("muted")}>No matching friends.</div>}

            <div className={cl("manage-list")}>
                {favorites.map((id, i) => {
                    const user = UserStore.getUser(id);
                    return (
                        <div key={id} className={cl("manage-row")}>
                            {user && <img className={cl("mini-avatar")} src={user.getAvatarURL(undefined, 32, false)} alt="" />}
                            <span className={cl("manage-name")}>{getDisplayName(user, id)}</span>
                            <button className={cl("icon-btn")} title="Move up" disabled={i === 0} onClick={() => moveFavorite(id, -1)}>
                                <Icon path={UP_PATH} size={18} />
                            </button>
                            <button className={cl("icon-btn")} title="Move down" disabled={i === favorites.length - 1} onClick={() => moveFavorite(id, 1)}>
                                <Icon path={DOWN_PATH} size={18} />
                            </button>
                            <button className={classes(cl("icon-btn"), cl("icon-btn-danger"))} title="Remove" onClick={() => removeFavorite(id)}>
                                <Icon path={CLOSE_PATH} size={16} />
                            </button>
                        </div>
                    );
                })}
                {!favorites.length && <div className={cl("muted")}>No favorites yet. You can also right-click any user → “Add to Friend Dock”.</div>}
            </div>
        </div>
    );
}

function Option({ label, setting }: { label: string; setting: "showTitleBarButton" | "sortByStatus" | "hideOffline" | "leaveWithFriend"; }) {
    const value = settings.use([setting])[setting];
    return (
        <label className={cl("option")}>
            <span>{label}</span>
            <Switch checked={value} onChange={v => settings.store[setting] = v} />
        </label>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(() => (
    <div className={cl("settings")}>
        <FavoriteManager />
        <div className={cl("section-title")}>Options</div>
        <Option label="Show icon in the title bar" setting="showTitleBarButton" />
        <Option label="Sort by status (in voice first) instead of your own order" setting="sortByStatus" />
        <Option label="Hide offline friends" setting="hideOffline" />
        <Option label="While following: leave voice when the friend leaves" setting="leaveWithFriend" />
        <div className={cl("muted")}>
            Following stops automatically when you switch or leave the voice channel yourself.
        </div>
    </div>
), { noop: true });

// ---------------------------------------------------------------- Title bar

function PopoutPanel({ onClose }: { onClose(): void; }) {
    return (
        <div className={cl("popout")}>
            <div className={cl("header")}>
                <Icon path={FRIENDS_PATH} size={22} />
                <span className={cl("title")}>Friend Dock</span>
                <button
                    className={cl("icon-btn")}
                    title="Settings"
                    onClick={() => { onClose(); openPluginModal(plugins.FriendDock); }}
                >
                    <Icon path={COG_PATH} size={18} />
                </button>
            </div>
            <Dock onNavigate={onClose} />
        </div>
    );
}

function TitleBarButton() {
    const { showTitleBarButton, following } = settings.use(["showTitleBarButton", "following"]);
    const followedUser = useStateFromStores([UserStore], () => following ? UserStore.getUser(following) : undefined, [following]);
    const buttonRef = useRef(null);
    const [show, setShow] = useState(false);

    if (!showTitleBarButton) return null;

    const tooltip = following ? `Friend Dock - following ${getDisplayName(followedUser, following)}` : "Friend Dock";

    return (
        <Popout
            position="bottom"
            align="left"
            animation={Popout.Animation.NONE}
            shouldShow={show}
            onRequestClose={() => setShow(false)}
            targetElementRef={buttonRef}
            renderPopout={() => (
                <ErrorBoundary noop>
                    <PopoutPanel onClose={() => setShow(false)} />
                </ErrorBoundary>
            )}
        >
            {(_, { isShown }) => (
                <HeaderBarIcon
                    ref={buttonRef}
                    className={classes(cl("titlebtn"), following && cl("titlebtn-active"))}
                    onClick={() => setShow(v => !v)}
                    tooltip={isShown ? null : tooltip}
                    icon={() => <Icon path={FRIENDS_PATH} />}
                    selected={isShown}
                />
            )}
        </Popout>
    );
}

export function renderTitleBarButton() {
    return (
        <ErrorBoundary key="vc-frienddock-titlebar" noop>
            <TitleBarButton />
        </ErrorBoundary>
    );
}
