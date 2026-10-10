/*
 * SecretChat – The rooms window: a layer over Discord (not a separate window) with the rooms, invites and
 * "New room" on the left and the open room on the right (ChatPopout's chat, embedded). It is its own React
 * root instead of a Discord modal, because ChatPopout's menus / viewer are position: fixed and a modal's
 * transform would shift them.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { ChannelStore, createRoot, FluxDispatcher, PrivateChannelSortStore, ReadStateStore, RelationshipStore, Tooltip, useEffect, useMemo, useReducer, useRef, UserStore, useState, useStateFromStores } from "@webpack/common";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

import { Button, Empty, Group, Icon, ICONS, notify, RoundButton, Row, SearchField, State, TextField } from "../_ui";
import { ChatSidebarProps, ChatWindow } from "../ChatPopout/chat";
import { Badge, unreadOf } from "./area";
import { sendEncryptedFiles } from "./files";
import { handshakes, isSendGuarded } from "./messages";
import { NativeMessageList } from "./nativelist";
import { chatLabel, createRoom, deleteRoomForEveryone, isJoining, isOwnedGroup, joinRoom, pruneStale, reannounce, roomMessages, userName, windowView } from "./rooms";
import { settings } from "./settings";
import { dismissInvite, Invite, removeRoom, renameRoom, Room, useStore } from "./store";
import { LOCK_PATH, RenameField, SC_COLOR, UserAvatar } from "./ui";

const cl = classNameFactory("vc-secretchat-");

/** ChatPopout wants a window key (only used for popout window state, which this layer doesn't have) */
const WINDOW_KEY = "DISCORD_VC_SECRETCHAT";
/** Discord allows 10 people in a group DM – you plus 9 */
const MAX_MEMBERS = 9;

// ---------------------------------------------------------------- Which room the window shows

let selected = "";
const selectListeners = new Set<() => void>();

function select(channelId: string) {
    selected = channelId;
    selectListeners.forEach(l => l());
}

function useSelected() {
    const [, rerender] = useReducer((x: number) => x + 1, 0);
    useEffect(() => {
        selectListeners.add(rerender);
        return () => void selectListeners.delete(rerender);
    }, []);
    return selected;
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

/** Opens the rooms window over Discord (or switches the room if it's open already) */
export function openRoomsWindow(channelId?: string) {
    if (settings.store.emergency) {
        notify({ title: "Emergency stop is on", body: "Right-click the lock to turn it off", kind: "attention", app: "SecretChat" });
        return;
    }
    if (channelId) select(channelId);
    if (root) return;

    try {
        host = document.createElement("div");
        host.className = cl("layer-root");
        document.body.appendChild(host);
        root = createRoot(host);
        root.render(
            <ErrorBoundary noop>
                <RoomsLayer />
            </ErrorBoundary>
        );
    } catch (e) {
        closeRoomsWindow();
        notify({ title: "Couldn't open the SecretChat window", kind: "error", app: "SecretChat" });
    }
}

export function closeRoomsWindow() {
    root?.unmount();
    host?.remove();
    root = null;
    host = null;
}

export function toggleRoomsWindow() {
    if (root) closeRoomsWindow();
    else openRoomsWindow();
}

function RoomsLayer() {
    // Esc closes – unless something inside wants it (menu, viewer, reply / edit mode, a field with text)
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || e.defaultPrevented) return;
            // A Discord menu / popout / modal over the window gets the Esc first
            if (document.querySelector('[role="menu"], [role="dialog"]')) return;
            const t = e.target as HTMLElement | null;
            if (t?.closest?.(".vc-chatpopout-menu, .vc-chatpopout-viewer, .vc-chatpopout-profile")) return;
            if ((t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) && t.value) return;
            e.stopPropagation();
            closeRoomsWindow();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    return (
        <div className={cl("layer")} onMouseDown={e => { if (e.target === e.currentTarget) closeRoomsWindow(); }}>
            <div className={cl("layer-card")}>
                <RoomsWindow />
            </div>
        </div>
    );
}

/** Marks the room as read – the window is our own, so Discord doesn't do it */
function ack(channelId: string) {
    FluxDispatcher.dispatch({
        type: "BULK_ACK",
        context: "APP",
        channels: [{ channelId, messageId: ReadStateStore.lastMessageId(channelId), readStateType: 0 }]
    } as any);
}

// ---------------------------------------------------------------- Window

function RoomsWindow() {
    const s = useStore();
    const current = useSelected();
    // Nothing chosen yet → the first room
    const channelId = current && s.rooms[current] ? current : Object.values(s.rooms).sort(byName)[0]?.channelId ?? "";

    // Without the sendMessage wrap the chat input would send plain text – show no chat then
    if (!isSendGuarded()) {
        return (
            <div className={cl("win-empty")}>
                <Empty icon={LOCK_PATH} title="SecretChat couldn't secure sending here" hint="Write in Discord itself (lock in the chat bar)" />
            </div>
        );
    }

    return (
        <ChatWindow
            channelId={channelId}
            windowKey={WINDOW_KEY}
            sidebar={RoomSidebar}
            title="Secret rooms"
            className={cl("chatwin")}
            hideMessage={hideMessage}
            renderMessages={renderMessages}
            sendFiles={sendEncryptedFiles}
            onClose={closeRoomsWindow}
            emptyView={
                <div className={cl("win-empty")}>
                    <Empty icon={LOCK_PATH} title="No room open" hint="Pick a room on the left or create a new one" />
                </div>
            }
        />
    );
}

const byName = (a: Room, b: Room) => a.name.localeCompare(b.name);

/** Discord's own message components – avatars, embeds, link cards, its menus */
const renderMessages = (channel: any) => <NativeMessageList key={channel.id} channel={channel} hide={hideMessage} />;

/** Only real messages here: no key exchange (join / key / handshake) and no system messages (icon changed, …) */
function hideMessage(m: any) {
    if (roomMessages.has(m.id) || handshakes.has(m.id)) return true;
    return m.type !== 0 && m.type !== 19; // normal message, reply
}

// ---------------------------------------------------------------- Sidebar

function RoomSidebar({ current, onSelect }: ChatSidebarProps) {
    const s = useStore();
    const rootRef = useRef<HTMLDivElement>(null);
    const rooms = Object.values(s.rooms).sort(byName);
    const invites = Object.values(s.invites);
    useEffect(() => void pruneStale(), []);
    const [creating, setCreating] = useState(!rooms.length && !invites.length);

    const open = (channelId: string) => {
        select(channelId);
        onSelect(channelId);
    };

    // Read while the window is focused; tell the pings which room is in front
    const unread = useStateFromStores([ReadStateStore], () => current ? ReadStateStore.hasUnread(current) : false, [current]);
    useEffect(() => {
        const doc = rootRef.current?.ownerDocument ?? null;
        windowView.doc = doc;
        windowView.channelId = s.rooms[current] ? current : null;
        const readNow = () => {
            if (current && s.rooms[current] && doc?.hasFocus() && ReadStateStore.hasUnread(current)) ack(current);
        };
        readNow();
        const win = doc?.defaultView;
        win?.addEventListener("focus", readNow);
        return () => win?.removeEventListener("focus", readNow);
    }, [current, unread]);
    useEffect(() => () => {
        windowView.doc = null;
        windowView.channelId = null;
    }, []);

    return (
        <div ref={rootRef} className={cl("side")}>
            <div className={cl("side-head")}>
                <Icon path={LOCK_PATH} size={16} />
                <span>Secret rooms</span>
                <RoundButton
                    icon={creating ? ICONS.close : ICONS.plus}
                    label={creating ? "Cancel" : "New room"}
                    active={creating}
                    onClick={() => setCreating(!creating)}
                />
            </div>

            <div className={cl("side-list")}>
                {creating && <NewRoomPanel onDone={() => setCreating(false)} />}

                {!!invites.length && (
                    <>
                        <div className={cl("side-section")}>Invites</div>
                        {invites.map(i => <InviteItem key={i.channelId} invite={i} />)}
                    </>
                )}

                {!!rooms.length && <div className={cl("side-section")}>Rooms</div>}
                {rooms.map(r => <RoomItem key={r.channelId} room={r} active={r.channelId === current} onOpen={() => open(r.channelId)} />)}

                {!rooms.length && !invites.length && !creating && (
                    <Empty icon={LOCK_PATH} title="No secret rooms yet">
                        <Button small color={SC_COLOR} icon={ICONS.plus} onClick={() => setCreating(true)}>Create your first room</Button>
                    </Empty>
                )}
            </div>
        </div>
    );
}

const SEND_PATH = "M3.4 20.4 20.85 12.92a1 1 0 0 0 0-1.84L3.4 3.6a.99.99 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91Z";

/**
 * Small icon button of a room row: Discord tooltip, a hover animation per kind, a press effect – and with
 * doneLabel a short checkmark after the click.
 */
function ActionIcon({ kind, label, doneLabel, danger, active, onClick, children }: {
    kind: "send" | "edit" | "trash"; label: string; doneLabel?: string; danger?: boolean; active?: boolean; onClick(): void; children: ReactNode;
}) {
    const [done, setDone] = useState(false);
    useEffect(() => {
        if (!done) return;
        const t = setTimeout(() => setDone(false), 1400);
        return () => clearTimeout(t);
    }, [done]);

    return (
        <Tooltip text={done && doneLabel ? doneLabel : label}>
            {p => (
                <button
                    {...p}
                    aria-label={label}
                    className={classes(cl("act"), cl(`act-${kind}`), danger && cl("act-danger"), active && cl("act-active"), done && cl("act-done"))}
                    onClick={() => {
                        onClick();
                        if (doneLabel) setDone(true);
                    }}
                >
                    {done ? <Icon path={ICONS.check} size={14} /> : children}
                </button>
            )}
        </Tooltip>
    );
}

function RoomItem({ room, active, onOpen }: { room: Room; active: boolean; onOpen(): void; }) {
    const unread = useStateFromStores([ReadStateStore], () => unreadOf(room.channelId), [room.channelId]);
    const owned = useStateFromStores([ChannelStore], () => isOwnedGroup(room.channelId), [room.channelId]);
    const [editing, setEditing] = useState(false);
    // No Discord dialogs in this layer – the trash opens a small choice under the row
    const [confirming, setConfirming] = useState(false);
    const [deleting, setDeleting] = useState(false);

    const deleteGroup = async () => {
        setDeleting(true);
        await deleteRoomForEveryone(room.channelId);
        setDeleting(false);
    };

    return (
        <div className={cl("side-room-wrap")}>
            <div
                className={classes(cl("side-room"), active && cl("side-room-on"), unread !== 0 && !active && cl("side-room-unread"))}
                onClick={() => !editing && onOpen()}
            >
                <span className={cl("side-room-icon")}><Icon path={LOCK_PATH} size={14} /></span>
                {editing ? (
                    <RenameField initial={room.name} onDone={n => { if (n != null) renameRoom(room.channelId, n); setEditing(false); }} />
                ) : (
                    <span className={cl("side-room-text")}>
                        <span className={cl("side-room-name")}>{room.name}</span>
                        <span className={cl("side-room-sub")}>{chatLabel(room.channelId)}</span>
                    </span>
                )}

                <span className={cl("side-room-actions")} onClick={e => e.stopPropagation()}>
                    <ActionIcon
                        kind="send"
                        label="Send the invite again"
                        doneLabel="Invite sent"
                        onClick={() => reannounce(room.channelId)}
                    >
                        <Icon path={SEND_PATH} size={14} />
                    </ActionIcon>
                    <ActionIcon kind="edit" label="Rename" onClick={() => setEditing(true)}>
                        <Icon path={ICONS.edit} size={14} />
                    </ActionIcon>
                    <ActionIcon kind="trash" label={confirming ? "Close" : "Remove or delete"} danger active={confirming} onClick={() => setConfirming(!confirming)}>
                        <Icon path={ICONS.trash} size={14} />
                    </ActionIcon>
                </span>

                {!active && <Badge count={unread} />}
            </div>

            {confirming && (
                <div className={cl("side-confirm")}>
                    {owned && (
                        <Button small wide variant="destructive" disabled={deleting} onClick={deleteGroup}>
                            {deleting ? "Deleting …" : "Delete group for everyone"}
                        </Button>
                    )}
                    <Button small wide variant="gray" disabled={deleting} onClick={() => removeRoom(room.channelId)}>Only remove from list</Button>
                    <Button small wide variant="plain" disabled={deleting} onClick={() => setConfirming(false)}>Cancel</Button>
                    {owned && <span className={cl("hint")}>Deleting removes everyone, deletes the group with all messages and forgets the key.</span>}
                </div>
            )}
        </div>
    );
}

function InviteItem({ invite }: { invite: Invite; }) {
    useStore();
    const joining = isJoining(invite.channelId);
    const exists = useStateFromStores([ChannelStore], () => !!ChannelStore.getChannel(invite.channelId), [invite.channelId]);
    return (
        <div className={cl("side-invite")}>
            <div className={cl("side-invite-top")}>
                <UserAvatar userId={invite.from} />
                <span className={cl("side-invite-text")}>
                    <b>{userName(invite.from)}</b>
                    <span>{chatLabel(invite.channelId)}</span>
                </span>
                <ActionIcon kind="trash" label="Dismiss" danger onClick={() => dismissInvite(invite.channelId)}>
                    <Icon path={ICONS.close} size={14} />
                </ActionIcon>
            </div>
            {!exists
                ? <State tone="bad">This chat no longer exists</State>
                : joining
                    ? <State spinner>Waiting for a member …</State>
                    : <Button small wide color={SC_COLOR} onClick={() => joinRoom(invite.channelId, invite.keyId)}>Join</Button>}
        </div>
    );
}

/** Size of the group picture we upload – plenty for an icon and keeps the request small */
const ICON_SIZE = 256;

/** Image file → square PNG data URL (center crop), or null if it can't be read */
export function toIconDataUrl(file: File, ICON_SIZE = 256): Promise<string | null> {
    return new Promise(resolve => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            const side = Math.min(img.naturalWidth, img.naturalHeight);
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = ICON_SIZE;
            const ctx = canvas.getContext("2d");
            if (!ctx || !side) return resolve(null), URL.revokeObjectURL(url);
            ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, ICON_SIZE, ICON_SIZE);
            URL.revokeObjectURL(url);
            resolve(canvas.toDataURL("image/png"));
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
    });
}

const IMAGE_PATH = "M5 3a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5Zm3.5 4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM5 18l3.5-4.5 2.5 3 3.5-4.5L19 18H5Z";

function NewRoomPanel({ onDone }: { onDone(): void; }) {
    const [name, setName] = useState("");
    const [icon, setIcon] = useState<string | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState("");
    const [picked, setPicked] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);

    // Like Discord's DM list: people you wrote with last first, then everyone else A–Z
    const friends = useMemo(() => {
        const recent = new Map<string, number>();
        PrivateChannelSortStore.getPrivateChannelIds().forEach((channelId, i) => {
            const ch = ChannelStore.getChannel(channelId);
            const userId = ch?.isDM() ? ch.getRecipientId() : null;
            if (userId && !recent.has(userId)) recent.set(userId, i);
        });
        const rank = (id: string) => recent.get(id) ?? Infinity;
        return RelationshipStore.getFriendIDs()
            .map(id => ({ id, name: userName(id) as string }))
            .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
    }, []);
    const q = query.trim().toLowerCase();
    const shown = q ? friends.filter(f => f.name.toLowerCase().includes(q) || UserStore.getUser(f.id)?.username.includes(q)) : friends;

    const toggle = (id: string) => setPicked(p =>
        p.includes(id) ? p.filter(x => x !== id) : p.length >= MAX_MEMBERS ? p : [...p, id]);

    const canCreate = !!name.trim() && picked.length > 0 && !busy;
    const create = async () => {
        if (!canCreate) return;
        setBusy(true);
        try {
            const channelId = await createRoom(name, picked, icon);
            select(channelId);
            onDone();
        } catch (e) {
            notify({ title: "Could not create the group", body: "Discord may want a captcha – create it by hand and use the lock there", kind: "error", app: "SecretChat" });
            setBusy(false);
        }
    };

    return (
        <div className={cl("side-panel")}>
            <div className={cl("name-row")}>
                <Tooltip text={picked.length < 2
                    ? "A picture needs a group – pick at least 2 friends"
                    : icon ? "Change picture (right-click to remove)" : "Add a group picture (optional)"}>
                    {p => (
                        <button
                            {...p}
                            className={classes(cl("icon-pick"), icon && cl("icon-pick-set"), picked.length < 2 && cl("icon-pick-off"))}
                            aria-label="Group picture"
                            onClick={() => picked.length >= 2 && fileRef.current?.click()}
                            onContextMenu={e => { e.preventDefault(); setIcon(null); }}
                        >
                            {icon && picked.length >= 2
                                ? <img src={icon} alt="" />
                                : <Icon path={IMAGE_PATH} size={18} />}
                        </button>
                    )}
                </Tooltip>
                <TextField value={name} autoFocus placeholder="Room name" maxLength={64} onChange={setName} />
                <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    hidden
                    onChange={async e => {
                        const file = e.currentTarget.files?.[0];
                        e.currentTarget.value = "";
                        if (!file) return;
                        const data = await toIconDataUrl(file);
                        if (data) setIcon(data);
                        else notify({ title: "That image couldn't be read", kind: "error", app: "SecretChat" });
                    }}
                />
            </div>
            <SearchField value={query} placeholder="Search friends" onChange={setQuery} />
            <Group className={cl("pick-list")}>
                {shown.map(f => {
                    const on = picked.includes(f.id);
                    return (
                        <Row
                            key={f.id}
                            className={classes(cl("pick"), on && cl("pick-on"))}
                            onClick={() => toggle(f.id)}
                            leading={<UserAvatar userId={f.id} size={26} />}
                            title={f.name}
                            trailing={<span className={cl("box")}>{on && <Icon path={ICONS.check} size={12} />}</span>}
                        />
                    );
                })}
                {!shown.length && <Empty title="No friends found" />}
            </Group>
            <Button wide color={SC_COLOR} disabled={!canCreate} onClick={create}>
                {busy ? "Creating …" : picked.length ? `Create (${picked.length})` : "Pick friends"}
            </Button>
            <span className={cl("hint")}>Existing chat or server channel: open it in Discord and use the lock in the chat bar.</span>
        </div>
    );
}
