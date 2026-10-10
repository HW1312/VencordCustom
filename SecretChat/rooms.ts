/*
 * SecretChat – Secret rooms: chats that are always encrypted, listed in their own area (server list icon), with
 * their own pings instead of Discord's. The room key is handed to new members with a hybrid key exchange in the chat
 * (ECDH P-256 + ML-KEM-768, see crypto.ts):
 *
 * announce: "🔑 SC1R.<key id>"                                         – this chat is a room with that key
 * join:     "🔑 SC1J.<key id>.<join id>.<public key>"                  – someone without the key asks for it
 * key:      "🔑 SC1K.<join id>.<to user id>.<public key>.<sealed key>" – a member answers (key + room name, sealed)
 *
 * In DMs / group DMs any member online answers automatically (being in the chat is the permission).
 * In server channels anyone who can read the channel could ask, so a member has to click "Let in".
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { findByPropsLazy } from "@webpack";
import { ChannelActionCreators, ChannelStore, GuildStore, PrivateChannelSortStore, RestAPI, SelectedChannelStore, SelfPresenceStore, UserStore } from "@webpack/common";

import { notify } from "../_ui";
import { answerHandshake, completeHandshakeKey, decodeText, encodeText, fromB64, HANDSHAKE_PUBLIC, keyIdOf, newHandshakeKeyPair, open, randomBytes, seal, toB64, toHex } from "./crypto";
import { decrypted, LOCKED_TEXT, retryLocked } from "./messages";
import { settings } from "./settings";
import { addInvite, addKey, addRoom, deleteKey, dropRoom, emit, getKey, getKeyBytes, isDismissed, save, state } from "./store";
import { openRoomsWindow } from "./window";

const logger = new Logger("SecretChat");

const SoundActions = findByPropsLazy("playNotificationSound", "showNotification");

const ANNOUNCE_RE = /^🔑 SC1R\.([0-9a-f]{8})$/;
const JOIN_RE = new RegExp(String.raw`^🔑 SC1J\.([0-9a-f]{8})\.([0-9a-f]{16})\.(${HANDSHAKE_PUBLIC})$`);
const KEY_RE = new RegExp(String.raw`^🔑 SC1K\.([0-9a-f]{16})\.(\d{15,21})\.(${HANDSHAKE_PUBLIC})\.([A-Za-z0-9_-]{60,600})$`);

/** The room name travels with the key – kept short so the key message stays under Discord's 2000 characters */
function shortName(name: string) {
    while (encodeText(name).length > 120) name = name.slice(0, -1);
    return name;
}

/** Join requests older than this are not answered automatically when they show up in the history */
const AUTO_ANSWER_MAX_AGE = 3 * 24 * 60 * 60 * 1000;

export interface RoomMessage {
    type: "announce" | "join" | "key";
    authorId: string;
    channelId: string;
    timestamp: number;
    keyId?: string;
    joinId?: string;
    to?: string;
    publicKey?: string;
    sealed?: string;
}

/** message id → room protocol message, for the card under it */
export const roomMessages = new Map<string, RoomMessage>();
/** Join ids that already got a key – nobody else needs to answer them */
const answered = new Set<string>();
const busy = new Set<string>();

const myId = () => UserStore.getCurrentUser()?.id;

export const userName = (id?: string) => {
    const u = id ? UserStore.getUser(id) : null;
    return u ? (u as any).globalName || u.username : "Someone";
};

/** "Max, Tim" for group DMs, "Max" for DMs, "#general · Server" for server channels */
export function chatLabel(channelId: string) {
    const ch = ChannelStore.getChannel(channelId);
    if (!ch) return "Unknown chat";
    if (ch.isDM()) return userName(ch.getRecipientId());
    if (ch.isGroupDM()) return ch.name || (ch.recipients ?? []).map(id => userName(id)).join(", ") || "Group";
    const guild = ch.guild_id ? GuildStore.getGuild(ch.guild_id) : null;
    return `#${ch.name}${guild ? ` · ${guild.name}` : ""}`;
}

const isPrivateChat = (channelId: string) => ChannelStore.getChannel(channelId)?.isPrivate() ?? false;

function concat(...parts: Uint8Array[]) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

const keyAad = (joinId: string, to: string) => encodeText(`SC1K|${joinId}|${to}`);

// ---------------------------------------------------------------- Incoming (called from the flux interceptor)

function parse(content: string): Omit<RoomMessage, "authorId" | "channelId" | "timestamp"> | null {
    let m = ANNOUNCE_RE.exec(content);
    if (m) return { type: "announce", keyId: m[1] };
    m = JOIN_RE.exec(content);
    if (m) return { type: "join", keyId: m[1], joinId: m[2], publicKey: m[3] };
    m = KEY_RE.exec(content);
    if (m) return { type: "key", joinId: m[1], to: m[2], publicKey: m[3], sealed: m[4] };
    return null;
}

/** Rewrites a room protocol message in place. Returns false if it isn't one. */
export function processRoomMessage(m: any, live: boolean) {
    const parsed = parse(m.content);
    if (!parsed) return false;

    const msg: RoomMessage = {
        ...parsed,
        authorId: m.author.id,
        channelId: m.channel_id,
        timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now()
    };
    roomMessages.set(m.id, msg);
    // Only the card under the message shows it
    const me = myId();

    switch (msg.type) {
        case "announce": {
            m.content = "";
            const room = state.rooms[msg.channelId];
            if (room?.keyId === msg.keyId) break;
            if (getKeyBytes(msg.keyId!)) {
                // We have the key already (another PC, or it was shared as a code) → just list the room.
                // Not if the chat is a room with another key already: an older announce must not switch it back.
                if (!room && !state.left.includes(msg.channelId)) {
                    setTimeout(() => addRoom(msg.channelId, msg.keyId!, getKey(msg.keyId!)?.name ?? "Secret room"), 0);
                }
            } else if (
                msg.authorId !== me && !state.invites[msg.channelId] && !isDismissed(msg.channelId, msg.keyId!)
                // From the history (e.g. it was sent before you had SecretChat): only if the chat isn't a room yet
                && (live || !room)
            ) {
                setTimeout(() => onInvited(msg, live), 0);
            }
            break;
        }
        case "join": {
            m.content = "";
            if (msg.authorId === me || answered.has(msg.joinId!)) break;
            const fresh = live || Date.now() - msg.timestamp < AUTO_ANSWER_MAX_AGE;
            if (fresh && canLetIn(msg) && isPrivateChat(msg.channelId)) setTimeout(() => letIn(msg, false), 0);
            break;
        }
        case "key": {
            answered.add(msg.joinId!);
            m.content = "";
            if (msg.to === me && state.joins[msg.joinId!]) setTimeout(() => completeJoin(msg), 0);
            break;
        }
    }
    return true;
}

/** After the keyring loaded: finish joins and list rooms whose messages came in before it was ready */
export function retryRooms() {
    const me = myId();
    for (const msg of roomMessages.values()) {
        if (msg.type === "key" && msg.to === me && state.joins[msg.joinId!]) completeJoin(msg);
        else if (msg.type === "announce" && !state.rooms[msg.channelId] && !state.left.includes(msg.channelId) && getKeyBytes(msg.keyId!)) {
            addRoom(msg.channelId, msg.keyId!, getKey(msg.keyId!)?.name ?? "Secret room");
        }
    }
}

/** We are a member of this room and can hand out its key */
export const canLetIn = (msg: RoomMessage) =>
    msg.type === "join" && state.rooms[msg.channelId]?.keyId === msg.keyId && !!getKeyBytes(msg.keyId!);

export const isAnswered = (joinId: string) => answered.has(joinId);

// ---------------------------------------------------------------- Key exchange

/** A member answers a join request with the room key, sealed for the person asking */
export async function letIn(msg: RoomMessage, manual: boolean) {
    const me = myId();
    const joinId = msg.joinId!;
    if (!me || busy.has(joinId) || answered.has(joinId) || !canLetIn(msg)) return;
    busy.add(joinId);
    try {
        // Several members may be online – wait a moment so usually only one of them answers
        if (!manual) {
            await new Promise(r => setTimeout(r, 400 + Math.random() * 2500));
            if (answered.has(joinId)) return;
        }
        const key = getKeyBytes(msg.keyId!)!;
        const name = shortName(state.rooms[msg.channelId]?.name ?? "Secret room");
        const { publicKey, key: shared } = await answerHandshake(msg.publicKey!, me, msg.authorId);
        const nonce = randomBytes(12);
        const sealed = seal(shared, nonce, concat(key, encodeText(name)), keyAad(joinId, msg.authorId));
        answered.add(joinId);
        sendMessage(msg.channelId, { content: `🔑 SC1K.${joinId}.${msg.authorId}.${publicKey}.${toB64(concat(nonce, sealed))}` }, false);
        if (manual) notify({ title: `Let ${userName(msg.authorId)} in`, kind: "success", app: "SecretChat" });
    } catch (e) {
        logger.error("Letting someone into the room failed", e);
        if (manual) notify({ title: "Could not hand out the room key", kind: "error", app: "SecretChat" });
    } finally {
        busy.delete(joinId);
        emit();
    }
}

/** We asked to join and a member answered: unseal the room key with our saved half */
async function completeJoin(msg: RoomMessage) {
    const me = myId();
    const joinId = msg.joinId!;
    const pending = state.joins[joinId];
    if (!me || !pending || busy.has(joinId)) return;
    busy.add(joinId);
    try {
        const { key: shared, quantumSafe } = await completeHandshakeKey(pending, msg.publicKey!, me, msg.authorId);
        const raw = fromB64(msg.sealed!);
        const plain = open(shared, raw.subarray(0, 12), raw.subarray(12), keyAad(joinId, me));
        if (!plain || plain.length < 32) throw new Error("Could not unseal the room key");
        const key = plain.slice(0, 32);
        // The key must be the one the room was announced with – nobody can slip in their own
        if (await keyIdOf(key) !== pending.keyId) throw new Error("Got a different key than the room uses");
        let name = "Secret room";
        try { name = decodeText(plain.subarray(32)) || name; } catch { }

        const { record } = await addKey(key, { name, kind: "group", source: "room", quantumSafe });
        delete state.joins[joinId];
        await addRoom(pending.channelId, record.id, name);
        retryLocked();
        notify({ title: `You joined the secret room “${name}”`, kind: "success", app: "SecretChat" });
    } catch (e) {
        logger.error("Joining the room failed", e);
        notify({ title: "Could not join the secret room", kind: "error", app: "SecretChat" });
    } finally {
        busy.delete(joinId);
        emit();
    }
}

export async function joinRoom(channelId: string, keyId: string) {
    if (!ChannelStore.getChannel(channelId)) {
        // The group was deleted (or you were removed) while the invite waited
        await dropRoom(channelId, false);
        notify({ title: "This chat doesn't exist anymore", kind: "error", app: "SecretChat" });
        return;
    }
    if (Object.values(state.joins).some(j => j.channelId === channelId && j.keyId === keyId)) return;
    const joinId = toHex(randomBytes(8));
    const { publicKey, privateJwk, kemSeed } = await newHandshakeKeyPair();
    state.joins[joinId] = { channelId, keyId, privateJwk, kemSeed, created: Date.now() };
    await save();
    sendMessage(channelId, { content: `🔑 SC1J.${keyId}.${joinId}.${publicKey}` }, false);
    notify({ title: isPrivateChat(channelId) ? "Asked to join – a member who is online lets you in automatically" : "Asked to join – a member has to let you in", kind: "info", app: "SecretChat" });
}

export const isJoining = (channelId: string) => Object.values(state.joins).some(j => j.channelId === channelId);

// ---------------------------------------------------------------- Creating rooms

function announce(channelId: string, keyId: string) {
    sendMessage(channelId, { content: `🔑 SC1R.${keyId}` }, false);
}

/** Posts the room announce again – for people who missed it (it never arrived, or they got SecretChat later) */
export function reannounce(channelId: string) {
    const room = state.rooms[channelId];
    if (!room) return;
    announce(channelId, room.keyId);
}

/** A group DM you created – you can delete it for everyone */
export function isOwnedGroup(channelId: string) {
    const ch = ChannelStore.getChannel(channelId);
    return !!ch?.isGroupDM() && ch.ownerId === myId();
}

/** Removes everyone from the group, leaves it (an empty group is deleted by Discord) and forgets room and key */
export async function deleteRoomForEveryone(channelId: string) {
    const ch = ChannelStore.getChannel(channelId);
    const me = myId();
    if (!ch || !me || !isOwnedGroup(channelId)) return;
    try {
        for (const userId of ch.recipients ?? []) {
            if (userId === me) continue;
            await RestAPI.del({ url: `/channels/${channelId}/recipients/${userId}` });
            await new Promise(r => setTimeout(r, 300));
        }
        await RestAPI.del({ url: `/channels/${channelId}` });
        await dropRoom(channelId, true);
        notify({ title: "Group deleted", kind: "success", app: "SecretChat" });
    } catch (e) {
        logger.error("Deleting the group failed", e);
        notify({ title: "Could not delete the group completely – try again", kind: "error", app: "SecretChat" });
    }
}

/**
 * Cleans up what belongs to chats that don't exist anymore (deleted or left while Discord was closed): their
 * invites, their rooms and the room keys nothing uses anymore. Keys you made yourself (new key, code, password)
 * stay. Runs when a SecretChat window opens – by then Discord has loaded its chats.
 */
export async function pruneStale() {
    // Chats not loaded yet → everything would look deleted
    if (!PrivateChannelSortStore.getPrivateChannelIds().length) return;
    const exists = (channelId: string) => !!ChannelStore.getChannel(channelId);

    for (const channelId of Object.keys(state.invites)) if (!exists(channelId)) await dropRoom(channelId, false);
    for (const channelId of Object.keys(state.rooms)) if (!exists(channelId)) await dropRoom(channelId, true);

    const used = (keyId: string) =>
        Object.entries(state.channels).some(([ch, k]) => k === keyId && exists(ch))
        || Object.values(state.rooms).some(r => r.keyId === keyId)
        || Object.values(state.invites).some(i => i.keyId === keyId);
    for (const k of [...state.keys]) {
        if (k.source === "room" && !used(k.id)) await deleteKey(k.id);
    }
}

/** CHANNEL_DELETE: a group or channel of a room is gone (or you were removed) → forget it. Closing a DM is not that. */
export function onChannelDelete(e: any) {
    const ch = e?.channel;
    if (!ch?.id || ch.type === 1) return;
    if (state.rooms[ch.id] || state.invites[ch.id]) dropRoom(ch.id, true);
}

/** Makes an existing chat a room – with the group key that is on there, or a new one */
export async function makeRoom(channelId: string, name: string, keyId?: string) {
    let id = keyId && getKeyBytes(keyId) ? keyId : null;
    if (!id) {
        const { record } = await addKey(randomBytes(32), { name, kind: "group", source: "room" });
        id = record.id;
    }
    await addRoom(channelId, id, name);
    announce(channelId, id);
}

/** Creates a new group DM with these friends (a DM for one friend) and makes it a room */
export async function createRoom(name: string, userIds: string[], icon?: string | null) {
    const channelId: string = await (ChannelActionCreators as any).ensurePrivateChannel(userIds);
    await makeRoom(channelId, name);
    // Only group DMs have a name and picture (one friend = a normal DM). Discord sees both, so the group gets a
    // random name there – the real room name only travels encrypted (with the key) and shows in SecretChat.
    if (ChannelStore.getChannel(channelId)?.isGroupDM()) {
        try {
            await RestAPI.patch({ url: `/channels/${channelId}`, body: { name: randomGroupName(), ...(icon ? { icon } : {}) } });
        } catch (e) {
            logger.error("Setting the group name / picture failed", e);
            notify({ title: "Room created, but its Discord name / picture couldn't be set", kind: "error", app: "SecretChat" });
        }
    }
    return channelId;
}

/** Meaningless group name for Discord, e.g. "k7Qm2xPa9R" */
function randomGroupName() {
    const chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from(randomBytes(10), b => chars[b % chars.length]).join("");
}

/** Rooms open in the SecretChat window */
export function openRoom(channelId: string) {
    openRoomsWindow(channelId);
}

/** The room shown in the SecretChat window and that window's document (to skip pings while you read it) */
export const windowView: { channelId: string | null; doc: Document | null; } = { channelId: null, doc: null };

// ---------------------------------------------------------------- Pings

function playPing() {
    try {
        SoundActions.playNotificationSound("message1", 0.4);
    } catch (e) {
        logger.warn("Could not play the ping sound", e);
    }
}

function avatarOf(userId: string) {
    return (UserStore.getUser(userId) as any)?.getAvatarURL?.(undefined, 128);
}

function shouldPing(channelId: string) {
    if (!settings.store.roomPings) return false;
    if (SelfPresenceStore?.getStatus?.() === "dnd") return false;
    if (windowView.channelId === channelId && windowView.doc?.hasFocus()) return false;
    return !(document.hasFocus() && SelectedChannelStore.getChannelId() === channelId);
}

async function onInvited(msg: RoomMessage, ping: boolean) {
    if (state.invites[msg.channelId]) return;
    await addInvite({ channelId: msg.channelId, keyId: msg.keyId!, from: msg.authorId, created: Date.now() });
    if (!ping || !settings.store.roomPings) return;
    playPing();
    showNotification({
        title: "🔒 Secret room invite",
        body: `${userName(msg.authorId)} made “${chatLabel(msg.channelId)}” a secret room – open SecretChat to join`,
        icon: avatarOf(msg.authorId),
        noPersist: true,
        onClick: () => openRoom(msg.channelId)
    });
}

/** Called for every live MESSAGE_CREATE after it was decrypted */
export function onRoomMessage(m: any) {
    const room = state.rooms[m?.channel_id];
    const authorId = m?.author?.id;
    // Protocol messages (join / key) don't ping – invites have their own notification
    if (!room || !authorId || authorId === myId() || roomMessages.has(m.id)) return;
    if (!shouldPing(room.channelId)) return;

    if (settings.store.emergency) {
        // No text while the emergency stop is on
        playPing();
        showNotification({ title: "🔒 SecretChat", body: "New message", noPersist: true });
        return;
    }
    const content = String(m.content ?? "");
    const plain = content.replace(/\s+/g, " ").trim();
    const text = content === LOCKED_TEXT ? "Encrypted message"
        : !plain || decrypted.has(m.id) ? plain
            : `(not encrypted) ${plain}`;
    playPing();
    showNotification({
        title: `🔒 ${room.name}`,
        body: `${userName(authorId)}: ${text.length > 180 ? text.slice(0, 180) + "…" : text || "Sent an attachment"}`,
        icon: avatarOf(authorId),
        // The log would keep the plain text on disk
        noPersist: true,
        onClick: () => openRoom(room.channelId)
    });
}

/** Discord's own notification check – rooms only ping through SecretChat */
export function isRoomMessage(message: any) {
    return !!message?.channel_id && !!state.rooms[message.channel_id];
}
