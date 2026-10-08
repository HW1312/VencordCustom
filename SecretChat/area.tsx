/*
 * SecretChat – Icon in the server list (unread badge, opens the rooms window) and the cards under room
 * messages (join / let in)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { Message } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { ReadStateStore, Tooltip, UserStore, useStateFromStores } from "@webpack/common";
import type { ReactNode } from "react";

import { canLetIn, isAnswered, isJoining, joinRoom, letIn, roomMessages, userName } from "./rooms";
import { settings } from "./settings";
import { useStore } from "./store";
import { LockIcon } from "./ui";
import { toggleRoomsWindow } from "./window";

const cl = classNameFactory("vc-secretchat-");

// ---------------------------------------------------------------- Unread

/** Number of unread messages, -1 = unread but no count known, 0 = read */
export function unreadOf(channelId: string) {
    const n = Math.max(ReadStateStore.getMentionCount(channelId) ?? 0, ReadStateStore.getUnreadCount(channelId) ?? 0);
    if (n > 0) return n;
    return ReadStateStore.hasUnread(channelId) ? -1 : 0;
}

export function Badge({ count }: { count: number; }) {
    if (!count) return null;
    return count < 0
        ? <span className={cl("dot")} />
        : <span className={cl("badge")}>{count > 99 ? "99+" : count}</span>;
}

// ---------------------------------------------------------------- Server list icon

/** Unread messages in all rooms plus open invites. -1 = something unread but no count known */
function useRoomsBadge() {
    const s = useStore();
    const ids = Object.keys(s.rooms);
    const unread = useStateFromStores([ReadStateStore], () => {
        let total = 0, any = false;
        for (const id of ids) {
            const n = unreadOf(id);
            if (n > 0) total += n;
            else if (n < 0) any = true;
        }
        return total || (any ? -1 : 0);
    }, [ids.join(",")]);
    const invites = Object.keys(s.invites).length;
    return unread > 0 || invites ? Math.max(unread, 0) + invites : unread;
}

export function ServerListIcon() {
    const { showServerListIcon } = settings.use(["showServerListIcon"]);
    const count = useRoomsBadge();
    if (!showServerListIcon) return null;

    return (
        <div className={cl("sl")}>
            {count !== 0 && <span className={cl("sl-pill")} />}
            <Tooltip text="Secret rooms" position="right">
                {p => (
                    <button {...p} className={cl("sl-btn")} aria-label="Secret rooms" onClick={toggleRoomsWindow}>
                        <LockIcon width={24} height={24} />
                    </button>
                )}
            </Tooltip>
            {count > 0 && <span className={classes(cl("badge"), cl("sl-badge"))}>{count > 99 ? "99+" : count}</span>}
        </div>
    );
}

// ---------------------------------------------------------------- Title bar button

const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

function TitleBarButton() {
    const { showTitleBarButton } = settings.use(["showTitleBarButton"]);
    const count = useRoomsBadge();
    if (!showTitleBarButton) return null;

    return (
        <HeaderBarIcon
            className={classes(cl("tb"), count !== 0 && cl("tb-unread"))}
            onClick={toggleRoomsWindow}
            tooltip={count > 0 ? `Secret rooms · ${count} new` : "Secret rooms"}
            icon={() => <LockIcon width={20} height={20} className={cl("tb-icon")} />}
        />
    );
}

export function renderTitleBarButton() {
    return (
        <ErrorBoundary key="vc-secretchat-titlebar" noop>
            <TitleBarButton />
        </ErrorBoundary>
    );
}

// ---------------------------------------------------------------- Cards under room messages

export function RoomCard({ message }: { message: Message; }) {
    const s = useStore();
    const msg = roomMessages.get(message.id);
    if (!msg || msg.type === "key") return null;
    const me = UserStore.getCurrentUser()?.id;
    const room = s.rooms[msg.channelId];

    let text: string;
    let button: ReactNode = null;

    if (msg.type === "announce") {
        if (room?.keyId === msg.keyId) text = `Secret room “${room.name}”`;
        else if (isJoining(msg.channelId)) text = "Waiting for a member to let you in …";
        else if (msg.authorId === me) text = "Secret room";
        else {
            text = `${userName(msg.authorId)} made this chat a secret room`;
            button = <button className={classes(cl("btn"), cl("btn-primary"))} onClick={() => joinRoom(msg.channelId, msg.keyId!)}>Join</button>;
        }
    } else if (msg.authorId === me) {
        text = s.joins[msg.joinId!] ? "Waiting for a member to let you in …" : "You asked to join";
    } else if (isAnswered(msg.joinId!)) {
        text = `${userName(msg.authorId)} was let in`;
    } else if (canLetIn(msg)) {
        text = `${userName(msg.authorId)} wants to join`;
        button = <button className={classes(cl("btn"), cl("btn-primary"))} onClick={() => letIn(msg, true)}>Let in</button>;
    } else {
        text = `${userName(msg.authorId)} asked to join`;
    }

    return (
        <div className={cl("card")}>
            <LockIcon width={18} height={18} />
            <span className={cl("card-text")}>{text}</span>
            {button}
        </div>
    );
}
