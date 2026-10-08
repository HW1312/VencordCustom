/*
 * SecretChat – Icon in the server list (unread badge, opens the rooms window) and the cards under room
 * messages (join / let in)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Settings } from "@api/Settings";
import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { Message } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { ContextMenuApi, Menu, ReadStateStore, showToast, Toasts, Tooltip, UserStore, useStateFromStores } from "@webpack/common";
import type { ReactNode } from "react";

import { hitTest } from "../ToolbarManager/dom";
import { openItemMenu } from "../ToolbarManager/ui";
import { applyEmergency } from "./messages";
import { canLetIn, isAnswered, isJoining, joinRoom, letIn, roomMessages, userName } from "./rooms";
import { settings } from "./settings";
import { useStore } from "./store";
import { LockIcon } from "./ui";
import { closeRoomsWindow, openRoomsWindow, toggleRoomsWindow, toIconDataUrl } from "./window";

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

// ---------------------------------------------------------------- Emergency stop

/** On: every message is shown encrypted again, the rooms window closes and pings show no text – until it's off */
export function toggleEmergency() {
    const on = !settings.store.emergency;
    settings.store.emergency = on;
    applyEmergency(on);
    if (on) closeRoomsWindow();
    showToast(on ? "Emergency stop on – all messages are encrypted again" : "Emergency stop off – messages are readable again", on ? Toasts.Type.MESSAGE : Toasts.Type.SUCCESS);
}

/**
 * Right-click on the lock (title bar / server list). Caught on window in the capture phase – before
 * ToolbarManager's listener on document, which would show its own menu for title bar icons.
 */
export function onLockContextMenu(e: MouseEvent) {
    const target = e.target as Element | null;
    // The title bar button may not pass our class on – our own icon inside it is always there
    if (!target?.closest?.(`.${cl("tb")}, .${cl("tb-icon")}, .${cl("tb-wrap")}, .${cl("sl-btn")}`)) return;
    e.preventDefault();
    e.stopPropagation();
    openLockMenu(e);
}

/** Lets you pick a picture for the server list icon, so it looks like any server */
function pickServerListPicture() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif";
    input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const data = await toIconDataUrl(file, 128);
        if (data) settings.store.serverListPicture = data;
        else showToast("That image couldn't be read", Toasts.Type.FAILURE);
    };
    input.click();
}

function openLockMenu(e: MouseEvent) {
    const on = !!settings.store.emergency;
    // Keep ToolbarManager's options (hide / move) reachable
    const toolbarHit = Settings.plugins.ToolbarManager?.enabled ? hitTest(e.target) : null;
    ContextMenuApi.openContextMenu(e as any, () => (
        <Menu.Menu navId="vc-secretchat-lock" onClose={ContextMenuApi.closeContextMenu} aria-label="SecretChat">
            <Menu.MenuItem
                id="vc-secretchat-emergency"
                label={on ? "Turn off emergency stop" : "Emergency stop"}
                subtext={on ? "Make messages readable again" : "Show every message encrypted again"}
                color={on ? undefined : "danger"}
                action={toggleEmergency}
            />
            {!on && <Menu.MenuItem id="vc-secretchat-open" label="Open secret rooms" action={() => openRoomsWindow()} />}
            {(e.target as Element)?.closest?.(`.${cl("sl-btn")}`) && (
                <>
                    <Menu.MenuSeparator />
                    <Menu.MenuItem id="vc-secretchat-picture" label="Change picture…" subtext="Make the icon look like any server" action={pickServerListPicture} />
                    {settings.store.serverListPicture && (
                        <Menu.MenuItem id="vc-secretchat-picture-reset" label="Reset picture" action={() => { settings.store.serverListPicture = ""; }} />
                    )}
                </>
            )}
            {toolbarHit && <Menu.MenuSeparator />}
            {toolbarHit && (
                <Menu.MenuItem
                    id="vc-secretchat-toolbar"
                    label="Toolbar options…"
                    action={() => setTimeout(() => openItemMenu(e, toolbarHit), 0)}
                />
            )}
        </Menu.Menu>
    ));
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
    const { showServerListIcon, emergency, serverListName, serverListPicture } = settings.use(["showServerListIcon", "emergency", "serverListName", "serverListPicture"]);
    const count = useRoomsBadge();
    if (!showServerListIcon) return null;

    return (
        <div className={cl("sl")}>
            {count !== 0 && <span className={cl("sl-pill")} />}
            <Tooltip text={emergency ? `${serverListName || "Secret rooms"} – emergency stop is on (right-click)` : serverListName || "Secret rooms"} position="right">
                {p => (
                    <button
                        {...p}
                        className={classes(cl("sl-btn"), serverListPicture && cl("sl-btn-picture"), emergency && cl("sl-btn-stop"))}
                        aria-label={serverListName || "Secret rooms"}
                        onClick={toggleRoomsWindow}
                    >
                        {serverListPicture && !emergency
                            ? <img src={serverListPicture} alt="" />
                            : <LockIcon width={24} height={24} />}
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
    const { showTitleBarButton, emergency } = settings.use(["showTitleBarButton", "emergency"]);
    const count = useRoomsBadge();
    if (!showTitleBarButton) return null;

    return (
        <div className={cl("tb-wrap")}>
            <HeaderBarIcon
                className={classes(cl("tb"), count !== 0 && !emergency && cl("tb-unread"), emergency && cl("tb-stop"))}
                onClick={toggleRoomsWindow}
                tooltip={emergency ? "SecretChat – emergency stop is on (right-click)" : count > 0 ? `Secret rooms · ${count} new` : "Secret rooms"}
                icon={() => <LockIcon width={20} height={20} className={cl("tb-icon")} />}
            />
        </div>
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
