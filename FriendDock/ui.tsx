/*
 * FriendDock – dock list, title bar button, popout & settings
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { plugins } from "@api/PluginManager";
import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { openPluginModal } from "@components/settings";
import { openPrivateChannel, openUserProfile } from "@utils/discord";
import { classes } from "@utils/misc";
import type { Activity } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import {
    ChannelStore, GuildStore, Popout, PresenceStore, React, RelationshipStore, SelectedChannelStore, Tooltip, useMemo, useRef,
    UserStore, useState, useStateFromStores, VoiceStateStore
} from "@webpack/common";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import { Avatar, Button, Empty, Icon, IconButton, ICONS, Popover, RoundButton, Row, SearchField, Section, Sheet, ToggleRow } from "../_ui";
import {
    addFavorite, getDisplayName, getJoinBlocker, getMyVoiceChannelId, getVoiceInfo, joinVoice, moveFavorite,
    removeFavorite, settings, stopFollowing, toggleFollow
} from "./index";

const cl = classNameFactory("vc-frienddock-");
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');
const POPOUT_STYLE: CSSProperties = { maxHeight: "min(640px, calc(100vh - 72px))" };

// ---------------------------------------------------------------- Icons

const FRIENDS_PATH = "M13 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8.5 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM13 12c-4 0-7 2-7 5v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2c0-3-3-5-7-5ZM4.5 12C2 12 0 13.5 0 15.5V17a1 1 0 0 0 1 1h3v-1c0-1.9.8-3.6 2.2-4.8-.5-.1-1.1-.2-1.7-.2Z";
const FOLLOW_PATH = "M12 2a1 1 0 0 1 1 1v1.07A8 8 0 0 1 19.93 11H21a1 1 0 1 1 0 2h-1.07A8 8 0 0 1 13 19.93V21a1 1 0 1 1-2 0v-1.07A8 8 0 0 1 4.07 13H3a1 1 0 1 1 0-2h1.07A8 8 0 0 1 11 4.07V3a1 1 0 0 1 1-1Zm0 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm0 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z";
const UP_PATH = "M12 7l-6 6h12l-6-6Z";
const DOWN_PATH = "M12 17l6-6H6l6 6Z";
const SORT_PATH = "M3 18h6v-2H3v2ZM3 6v2h18V6H3Zm0 7h12v-2H3v2Z";
const HIDE_PATH = "M12 7a5 5 0 0 1 4.65 6.83l2.92 2.92A11.8 11.8 0 0 0 23 12c-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16A4.85 4.85 0 0 1 12 7ZM2 4.27l2.28 2.28.46.46A11.8 11.8 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27ZM7.53 9.8l1.55 1.55A2.82 2.82 0 0 0 9 12a3 3 0 0 0 3 3c.22 0 .44-.03.65-.08l1.55 1.55A5 5 0 0 1 7.53 9.8Zm4.31-.78 3.15 3.15.02-.16a3 3 0 0 0-3-3l-.17.01Z";

/** Line icons (Lucide style) for the card actions – just the glyph, no button box */
const JoinIcon = () => (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />
    </svg>
);

/** Footprints – while following, the feet take turns stepping */
const FollowIcon = () => (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <g className="vc-frienddock-foot">
            <path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z" />
            <path d="M4 13h4" />
        </g>
        <g className="vc-frienddock-foot vc-frienddock-foot-2">
            <path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z" />
            <path d="M16 17h4" />
        </g>
    </svg>
);

/** Discord's tooltip around any element (instead of the browser's title tooltip); keeps the element's own onClick */
function Tip({ text, children }: { text: ReactNode; children: ReactElement<any>; }) {
    return (
        <Tooltip text={text}>
            {(tip: any) => React.cloneElement(children, {
                ...tip,
                onClick: (e: React.MouseEvent) => {
                    tip.onClick?.(e);
                    children.props.onClick?.(e);
                }
            })}
        </Tooltip>
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

// ---------------------------------------------------------------- Logo

/** Two friends in a teal squircle: the front one nods, the back one waves along; radar rings while following */
export function DockLogo({ size = 42, following }: { size?: number; following?: boolean; }) {
    return (
        <span className={classes(cl("logo"), following && cl("logo-following"))} style={{ width: size, height: size }}>
            <span className={cl("logo-ring")} />
            <span className={classes(cl("logo-ring"), cl("logo-ring-2"))} />
            <svg viewBox="0 0 32 32" aria-hidden>
                <g className={cl("logo-back")}>
                    <circle cx="11" cy="12.5" r="3.6" />
                    <path d="M4.5 24.5c0-4 2.9-6.6 6.5-6.6 1.5 0 2.9.4 4 1.2-1.9 1.5-3 3.6-3 5.4Z" />
                </g>
                <g className={cl("logo-front")}>
                    <circle cx="19.5" cy="12" r="4.4" />
                    <path d="M11.5 25.5c0-4.6 3.6-7.8 8-7.8s8 3.2 8 7.8Z" />
                </g>
            </svg>
        </span>
    );
}

// ---------------------------------------------------------------- Friend card

function FriendAvatar({ id, status, size = 42 }: { id: string; status: Status; size?: number; }) {
    const user = useStateFromStores([UserStore], () => UserStore.getUser(id));
    return (
        <Tip text={`Open profile · ${STATUS_LABEL[status]}`}>
            <div className={classes(cl("avatar"), cl(`avatar-${status}`))} onClick={() => openUserProfile(id)}>
                <Avatar size={size} src={user?.getAvatarURL(undefined, 96, false)} />
                <span className={classes(cl("dot"), cl(`dot-${status}`))} />
            </div>
        </Tip>
    );
}

/** Up to 4 avatars of the people in a voice channel */
function VoiceFaces({ channelId }: { channelId: string; }) {
    const ids = useStateFromStores([VoiceStateStore], () => Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {}).slice(0, 4).join(","), [channelId]);
    if (!ids) return null;
    return (
        <span className={cl("faces")}>
            {ids.split(",").map(uid => <img key={uid} src={UserStore.getUser(uid)?.getAvatarURL(undefined, 32, false)} alt="" />)}
        </span>
    );
}

/** Small animated equalizer – "someone's talking in here" */
const VoiceBars = () => <span className={cl("bars")}><i /><i /><i /></span>;

function VoiceChip({ channelId, together }: { channelId: string; together: boolean; }) {
    // Re-render when the channel's participants or names change
    useStateFromStores([VoiceStateStore, ChannelStore, GuildStore], () =>
        `${Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {}).length}:${ChannelStore.getChannel(channelId)?.name}`, [channelId]);
    const info = getVoiceInfo(channelId);

    return (
        <Tip text={info ? `${info.isPrivate ? info.place : "#" + info.channelName}${info.isPrivate ? "" : " · " + info.place} · ${info.count} in voice` : "In a voice channel you can't see"}>
        <div className={classes(cl("chip"), together && cl("chip-together"))}>
            <VoiceBars />
            <span className={cl("chip-text")}>
                <b>{info ? (info.isPrivate ? info.place : info.channelName) : "Hidden channel"}</b>
                {info && !info.isPrivate && <span className={cl("chip-place")}>{info.place}</span>}
            </span>
            {together ? <span className={cl("chip-with")}>With you</span> : <VoiceFaces channelId={channelId} />}
            {info && info.count > 4 && !together && <span className={cl("chip-more")}>+{info.count - 4}</span>}
        </div>
        </Tip>
    );
}

function FriendCard({ id, onNavigate }: { id: string; onNavigate?(): void; }) {
    const user = useStateFromStores([UserStore], () => UserStore.getUser(id));
    const nick = useStateFromStores([RelationshipStore], () => RelationshipStore.getNickname(id));
    const status = useStateFromStores([PresenceStore], () => getStatus(id));
    const activity = useStateFromStores([PresenceStore], () => getActivityText(PresenceStore.getActivities(id) ?? []));
    const channelId = useStateFromStores([VoiceStateStore], () => VoiceStateStore.getVoiceStateForUser(id)?.channelId ?? null);
    const myChannelId = useStateFromStores([SelectedChannelStore], getMyVoiceChannelId);
    const { following } = settings.use(["following"]);

    const name = nick || getDisplayName(user, id);
    const isFollowing = following === id;
    const together = channelId != null && channelId === myChannelId;
    const blocker = channelId && !together ? getJoinBlocker(channelId) : null;

    return (
        <div className={classes(cl("card"), isFollowing && cl("card-following"), status === "offline" && !channelId && cl("card-offline"))}>
            <FriendAvatar id={id} status={status} />
            <div className={cl("card-main")}>
                <div className={cl("card-top")}>
                    <Tip text="Open DM"><span className={cl("name")} onClick={() => { openPrivateChannel(id); onNavigate?.(); }}>{name}</span></Tip>
                    <span className={classes(cl("status"), cl(`status-${status}`))}>{STATUS_LABEL[status]}</span>
                </div>
                {activity && <Tip text={activity}><div className={cl("activity")}>{activity}</div></Tip>}
                {channelId && <VoiceChip channelId={channelId} together={together} />}
                {!channelId && isFollowing && <div className={cl("waiting")}>Waiting for them to join voice…</div>}
            </div>
            <div className={cl("card-actions")}>
                {channelId && !together && (
                    <Tip text={blocker ?? "Join their voice channel"}>
                        {/* aria-disabled instead of disabled: a disabled button gets no hover, so the reason wouldn't show */}
                        <button
                            className={classes(cl("act"), cl("act-join"))}
                            aria-disabled={!!blocker || !getVoiceInfo(channelId)}
                            onClick={() => { if (!blocker && getVoiceInfo(channelId) && joinVoice(channelId)) onNavigate?.(); }}
                        >
                            <JoinIcon />
                        </button>
                    </Tip>
                )}
                <Tip text={isFollowing ? "Stop following" : "Follow – go wherever they go in voice, until you stop it"}>
                    <button
                        className={classes(cl("act"), cl("act-follow"), isFollowing && cl("act-on"))}
                        onClick={() => toggleFollow(id)}
                    >
                        <FollowIcon />
                    </button>
                </Tip>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- Dock

function FollowBanner() {
    const { following } = settings.use(["following"]);
    const user = useStateFromStores([UserStore], () => following ? UserStore.getUser(following) : undefined, [following]);
    const channelId = useStateFromStores([VoiceStateStore], () => following ? VoiceStateStore.getVoiceStateForUser(following)?.channelId ?? null : null, [following]);
    if (!following) return null;

    const info = getVoiceInfo(channelId);
    return (
        <div className={cl("banner")}>
            <span className={cl("banner-avatar")}>
                <span className={cl("banner-pulse")} />
                <Avatar size={34} src={user?.getAvatarURL(undefined, 64, false)} />
            </span>
            <div className={cl("banner-text")}>
                <b>Following {getDisplayName(user, following)}</b>
                <span>{info ? `in ${info.isPrivate ? info.place : "#" + info.channelName}` : "Not in voice – you'll join when they do"}</span>
            </div>
            <Button small variant="gray" onClick={() => stopFollowing()}>Stop</Button>
        </div>
    );
}

type DockGroup = "voice" | "online" | "offline";
const GROUP_TITLE: Record<DockGroup, string> = { voice: "In voice", online: "Online", offline: "Offline" };

function useGroups(ids: string[]) {
    const key = useStateFromStores([PresenceStore, VoiceStateStore], () => ids.map(id =>
        VoiceStateStore.getVoiceStateForUser(id)?.channelId ? "voice" : getStatus(id) === "offline" ? "offline" : "online"
    ).join(","), [ids.join(",")]);
    const groups = key.split(",");
    return (["voice", "online", "offline"] as DockGroup[])
        .map(g => ({ group: g, ids: ids.filter((_, i) => groups[i] === g) }))
        .filter(g => g.ids.length);
}

function Dock({ onNavigate }: { onNavigate?(): void; }) {
    const { favorites, sortByStatus } = settings.use(["favorites", "sortByStatus"]);
    const ids = useDockIds();
    const groups = useGroups(ids);

    const list = (groupIds: string[]) => groupIds.map(id => (
        <ErrorBoundary noop key={id}>
            <FriendCard id={id} onNavigate={onNavigate} />
        </ErrorBoundary>
    ));

    return (
        <div className={cl("dock")}>
            <FollowBanner />
            {ids.length > 0 && (sortByStatus
                ? groups.map(({ group, ids: groupIds }) => (
                    <div key={group} className={cl("group")}>
                        <div className={cl("group-title")}>{GROUP_TITLE[group]}<span>{groupIds.length}</span></div>
                        {list(groupIds)}
                    </div>
                ))
                : <div className={cl("group")}>{list(ids)}</div>)}
            {!favorites.length && (
                <Empty icon={FRIENDS_PATH} title="No favorites yet" hint="Right-click a friend and choose “Add to Friend Dock”, or add them in the settings." />
            )}
            {favorites.length > 0 && !ids.length && <Empty icon={FRIENDS_PATH} title="All your favorites are offline." />}
        </div>
    );
}

/** "2 in voice · 5 online" under the title */
function useSummary() {
    const { favorites } = settings.use(["favorites"]);
    return useStateFromStores([PresenceStore, VoiceStateStore], () => {
        const voice = favorites.filter(id => VoiceStateStore.getVoiceStateForUser(id)?.channelId).length;
        const online = favorites.filter(id => getStatus(id) !== "offline").length;
        return [voice && `${voice} in voice`, `${online} online`].filter(Boolean).join(" · ");
    }, [favorites]);
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
        <>
            <SearchField placeholder="Add a friend… (type a name)" value={query} onChange={setQuery} />
            {query.trim() && (
                <Section>
                    {candidates.map(({ id, user }) => (
                        <Row
                            key={id}
                            leading={<Avatar src={user?.getAvatarURL(undefined, 32, false)} />}
                            title={getDisplayName(user, id)}
                            trailing={<Button small icon={ICONS.plus} onClick={() => { addFavorite(id); setQuery(""); }}>Add</Button>}
                        />
                    ))}
                    {!candidates.length && <Row dim title="No matching friends." />}
                </Section>
            )}

            <Section title="Favorites">
                {favorites.map((id, i) => {
                    const user = UserStore.getUser(id);
                    return (
                        <Row
                            key={id}
                            leading={<Avatar src={user?.getAvatarURL(undefined, 32, false)} />}
                            title={getDisplayName(user, id)}
                            trailing={
                                <div className={cl("manage-actions")}>
                                    <IconButton icon={UP_PATH} label="Move up" disabled={i === 0} onClick={() => moveFavorite(id, -1)} />
                                    <IconButton icon={DOWN_PATH} label="Move down" disabled={i === favorites.length - 1} onClick={() => moveFavorite(id, 1)} />
                                    <IconButton icon={ICONS.close} label="Remove" destructive onClick={() => removeFavorite(id)} />
                                </div>
                            }
                        />
                    );
                })}
                {!favorites.length && <Row dim title="No favorites yet. You can also right-click any user → “Add to Friend Dock”." />}
            </Section>
        </>
    );
}

const OPTIONS = [
    ["showTitleBarButton", "Show icon in the title bar", FRIENDS_PATH, "teal"],
    ["sortByStatus", "Sort by status (in voice first) instead of your own order", SORT_PATH, "blue"],
    ["hideOffline", "Hide offline friends", HIDE_PATH, "gray"],
    ["leaveWithFriend", "While following: leave voice when the friend leaves", FOLLOW_PATH, "orange"]
] as const;

function Options() {
    const s = settings.use(["showTitleBarButton", "sortByStatus", "hideOffline", "leaveWithFriend"]);
    return (
        <Section title="Options" footer="Following goes on until you press Stop: if you get moved away (e.g. by a “join to create” bot) you're brought back to your friend, if you leave voice yourself you join again when they switch channels.">
            {OPTIONS.map(([key, label, icon, color]) => (
                <ToggleRow key={key} icon={icon} color={color} title={label} checked={s[key]} onChange={v => settings.store[key] = v} />
            ))}
        </Section>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(() => (
    <Sheet embedded header={{ title: "Friend Dock", subtitle: "Your favorite friends with live status and voice", iconNode: <DockLogo /> }}>
        <FavoriteManager />
        <Options />
    </Sheet>
), { noop: true });

// ---------------------------------------------------------------- Title bar

function PopoutPanel({ onClose }: { onClose(): void; }) {
    const { following } = settings.use(["following"]);
    const summary = useSummary();
    return (
        <Popover width={380} style={POPOUT_STYLE}>
            <Sheet
                header={{
                    title: "Friend Dock",
                    subtitle: summary,
                    iconNode: <DockLogo following={!!following} />,
                    actions: <RoundButton icon={ICONS.gear} label="Settings" onClick={() => { onClose(); openPluginModal(plugins.FriendDock); }} />
                }}
            >
                <Dock onNavigate={onClose} />
            </Sheet>
        </Popover>
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
                    icon={() => <Icon path={FRIENDS_PATH} size={20} className="vc-ui-tb-icon" />}
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
