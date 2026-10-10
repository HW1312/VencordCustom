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
    ChannelStore, GuildStore, Popout, PresenceStore, RelationshipStore, SelectedChannelStore, useMemo, useRef,
    UserStore, useState, useStateFromStores, VoiceStateStore
} from "@webpack/common";
import type { CSSProperties } from "react";

import { Avatar, Badge, Button, Empty, Glyph, Icon, IconButton, ICONS, Popover, RoundButton, Row, SearchField, Section, Sheet, ToggleRow } from "../_ui";
import {
    addFavorite, getDisplayName, getJoinBlocker, getMyVoiceChannelId, getVoiceInfo, joinVoice, moveFavorite,
    removeFavorite, settings, stopFollowing, toggleFollow
} from "./index";

const cl = classNameFactory("vc-frienddock-");
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');
const POPOUT_STYLE: CSSProperties = { maxHeight: "min(640px, calc(100vh - 72px))" };

// ---------------------------------------------------------------- Icons

const FRIENDS_PATH = "M13 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8.5 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM13 12c-4 0-7 2-7 5v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2c0-3-3-5-7-5ZM4.5 12C2 12 0 13.5 0 15.5V17a1 1 0 0 0 1 1h3v-1c0-1.9.8-3.6 2.2-4.8-.5-.1-1.1-.2-1.7-.2Z";
const SPEAKER_PATH = "M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM15.1 20.75c-.58.14-1.1-.33-1.1-.92v-.03c0-.5.37-.92.85-1.05a7 7 0 0 0 0-13.5A1.11 1.11 0 0 1 14 4.2v-.03c0-.6.52-1.06 1.1-.92a9 9 0 0 1 0 17.5Z";
const FOLLOW_PATH = "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 3a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z";
const UP_PATH = "M12 7l-6 6h12l-6-6Z";
const DOWN_PATH = "M12 17l6-6H6l6 6Z";
const SORT_PATH = "M3 18h6v-2H3v2ZM3 6v2h18V6H3Zm0 7h12v-2H3v2Z";
const HIDE_PATH = "M12 7a5 5 0 0 1 4.65 6.83l2.92 2.92A11.8 11.8 0 0 0 23 12c-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16A4.85 4.85 0 0 1 12 7ZM2 4.27l2.28 2.28.46.46A11.8 11.8 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27ZM7.53 9.8l1.55 1.55A2.82 2.82 0 0 0 9 12a3 3 0 0 0 3 3c.22 0 .44-.03.65-.08l1.55 1.55A5 5 0 0 1 7.53 9.8Zm4.31-.78 3.15 3.15.02-.16a3 3 0 0 0-3-3l-.17.01Z";

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

function FriendAvatar({ id, status }: { id: string; status: Status; }) {
    const user = useStateFromStores([UserStore], () => UserStore.getUser(id));
    return (
        <div className={cl("avatar")} onClick={() => openUserProfile(id)} title="Open profile">
            <Avatar size={36} src={user?.getAvatarURL(undefined, 64, false)} />
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
                    <Button small disabled={!info} title={blocker ?? "Join this voice channel"} onClick={() => { if (joinVoice(channelId)) onAction?.(); }}>
                        Join
                    </Button>
                )}
                {together && <Badge color="green">With you</Badge>}
                <Button
                    small
                    variant={isFollowing ? "filled" : "gray"}
                    color={isFollowing ? "teal" : undefined}
                    icon={FOLLOW_PATH}
                    title={isFollowing ? "Stop following" : "Follow: move along whenever they switch voice channels"}
                    onClick={() => toggleFollow(id)}
                >
                    {isFollowing ? "Following" : "Follow"}
                </Button>
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
        <Row
            align="top"
            className={classes(following === id && cl("row-following"), status === "offline" && cl("row-offline"))}
            leading={<FriendAvatar id={id} status={status} />}
            title={<span className={cl("name")} title="Open DM" onClick={() => { openPrivateChannel(id); onNavigate?.(); }}>{name}</span>}
            subtitle={activity ? <span title={activity}>{activity}</span> : undefined}
            trailing={<span className={cl("status-text")}>{STATUS_LABEL[status]}</span>}
        >
            <VoiceLine id={id} onAction={onNavigate} />
        </Row>
    );
}

// ---------------------------------------------------------------- Dock

function FollowBanner() {
    const { following } = settings.use(["following"]);
    const user = useStateFromStores([UserStore], () => following ? UserStore.getUser(following) : undefined, [following]);
    if (!following) return null;

    return (
        <Section>
            <Row
                leading={<Glyph path={FOLLOW_PATH} color="teal" />}
                title={<>Following <b>{getDisplayName(user, following)}</b> in voice</>}
                trailing={<Button small variant="gray" onClick={() => stopFollowing()}>Stop</Button>}
            />
        </Section>
    );
}

function Dock({ onNavigate }: { onNavigate?(): void; }) {
    const { favorites } = settings.use(["favorites"]);
    const ids = useDockIds();

    return (
        <>
            <FollowBanner />
            {ids.length > 0 && (
                <Section>
                    {ids.map(id => (
                        <ErrorBoundary noop key={id}>
                            <FriendRow id={id} onNavigate={onNavigate} />
                        </ErrorBoundary>
                    ))}
                </Section>
            )}
            {!favorites.length && (
                <Empty icon={FRIENDS_PATH} title="No favorites yet" hint="Right-click a friend and choose “Add to Friend Dock”, or add them in the settings." />
            )}
            {favorites.length > 0 && !ids.length && <Empty icon={FRIENDS_PATH} title="All your favorites are offline." />}
        </>
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
        <Section title="Options" footer="Following stops automatically when you switch or leave the voice channel yourself.">
            {OPTIONS.map(([key, label, icon, color]) => (
                <ToggleRow key={key} icon={icon} color={color} title={label} checked={s[key]} onChange={v => settings.store[key] = v} />
            ))}
        </Section>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(() => (
    <Sheet embedded header={{ title: "Friend Dock", subtitle: "Your favorite friends with live status and voice", icon: FRIENDS_PATH, iconColor: "teal" }}>
        <FavoriteManager />
        <Options />
    </Sheet>
), { noop: true });

// ---------------------------------------------------------------- Title bar

function PopoutPanel({ onClose }: { onClose(): void; }) {
    return (
        <Popover width={380} style={POPOUT_STYLE}>
            <Sheet
                header={{
                    title: "Friend Dock",
                    icon: FRIENDS_PATH,
                    iconColor: "teal",
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
