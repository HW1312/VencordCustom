/*
 * SecretChat – Decrypts messages while Discord dispatches them (before any store, notification or render sees
 * them), encrypts on send / edit, and runs the key handshake.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageEditListener, MessageSendListener } from "@api/MessageEvents";
import { updateMessage } from "@api/MessageUpdater";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { User } from "@vencord/discord-types";
import { findByProps } from "@webpack";
import { ChannelStore, UserStore } from "@webpack/common";

import { notify } from "../_ui";
import { answerHandshake, completeHandshakeKey, decryptEnvelope, encodeText, encryptMessage, fromB64, HANDSHAKE_PUBLIC, newHandshakeKeyPair, open, parseMessage, randomBytes, RUNE_MARKER, seal, toB64, toHex } from "./crypto";
import { isFileText, takeFile } from "./files";
import { onRoomMessage, processRoomMessage } from "./rooms";
import { settings } from "./settings";
import { addKey, channelKey, containsInviteCode, deleteKey, emit, getKey, getKeyBytes, isLoaded, KeyRecord, save, setChannelKey, state } from "./store";

const logger = new Logger("SecretChat");

/** Discord's limit without Nitro. The encrypted text is ~4/3 of the original plus ~60 characters. */
const MAX_LENGTH = 2000;

export const LOCKED_TEXT = "🔒 *Encrypted message – you don't have the key*";

/** message id → key id, for the lock icon and for editing */
export const decrypted = new Map<string, string>();
/** Encrypted messages without a matching key – retried when a key is added */
const locked = new Map<string, { channelId: string; authorId: string; raw: string; }>();

// ---------------------------------------------------------------- Handshake messages

/**
 * hello: "🔑 SC1H.<to user id>.<handshake id>.<public key>"  – A asks B
 * ack:   "🔑 SC1A.<handshake id>.<public key>"              – B answers, both now derive the same key
 * no:    "🔑 SC1N.<handshake id>"                           – B declines, A stops waiting
 * The public key is "<ECDH>~<ML-KEM>" (hybrid, quantum-safe) or only "<ECDH>" from older versions.
 */
const HELLO_RE = new RegExp(String.raw`^🔑 SC1H\.(\d{15,21})\.([0-9a-f]{16})\.(${HANDSHAKE_PUBLIC})$`);
const ACK_RE = new RegExp(String.raw`^🔑 SC1A\.([0-9a-f]{16})\.(${HANDSHAKE_PUBLIC})$`);
const DECLINE_RE = /^🔑 SC1N\.([0-9a-f]{16})$/;

export interface Handshake {
    type: "hello" | "ack" | "decline";
    hsid: string;
    publicKey: string;
    /** hello only */
    to?: string;
    authorId: string;
    channelId: string;
}

/** message id → handshake, for the card under the message */
export const handshakes = new Map<string, Handshake>();
const busy = new Set<string>();

function parseHandshake(content: string): Omit<Handshake, "authorId" | "channelId"> | null {
    let m = HELLO_RE.exec(content);
    if (m) return { type: "hello", to: m[1], hsid: m[2], publicKey: m[3] };
    m = ACK_RE.exec(content);
    if (m) return { type: "ack", hsid: m[1], publicKey: m[2] };
    m = DECLINE_RE.exec(content);
    if (m) return { type: "decline", hsid: m[1], publicKey: "" };
    return null;
}

const myId = () => UserStore.getCurrentUser()?.id;
const userName = (id: string) => {
    const u = UserStore.getUser(id);
    return u ? (u as any).globalName || u.username : "Unknown user";
};

export async function startHandshake(user: User, channelId: string) {
    const hsid = toHex(randomBytes(8));
    const { publicKey, privateJwk, kemSeed } = await newHandshakeKeyPair();
    state.pending[hsid] = { to: user.id, channelId, privateJwk, kemSeed, created: Date.now() };
    await save();
    sendMessage(channelId, { content: `🔑 SC1H.${user.id}.${hsid}.${publicKey}` }, false);
    notify({ title: `Asked ${userName(user.id)} for an encrypted chat – waiting for them to accept`, kind: "info", app: "SecretChat" });
}

async function finish(record: KeyRecord, isNew: boolean, channelId: string, partnerId: string) {
    await setChannelKey(channelId, record.id);
    retryLocked();
    notify({ title: `${isNew ? "Encrypted chat with" : "Already connected with"} ${userName(partnerId)} – safety code ${record.safety}`, kind: "success", app: "SecretChat" });
}

export async function acceptHandshake(hs: Handshake) {
    const me = myId();
    if (!me || hs.to !== me || busy.has(hs.hsid) || state.handled.includes(hs.hsid)) return;
    busy.add(hs.hsid);
    try {
        const { publicKey, key, quantumSafe } = await answerHandshake(hs.publicKey, me, hs.authorId);
        const { record, isNew } = await addKey(key, { name: userName(hs.authorId), kind: "private", partnerId: hs.authorId, source: "handshake", quantumSafe });
        state.handled.push(hs.hsid);
        sendMessage(hs.channelId, { content: `🔑 SC1A.${hs.hsid}.${publicKey}` }, false);
        await finish(record, isNew, hs.channelId, hs.authorId);
    } catch (e) {
        logger.error("Accepting the handshake failed", e);
        notify({ title: "Could not accept the encrypted chat", kind: "error", app: "SecretChat" });
    } finally {
        busy.delete(hs.hsid);
        emit();
    }
}

/** Declines the request and tells the other side, so they stop waiting */
export async function declineHandshake(hs: Handshake) {
    if (state.handled.includes(hs.hsid)) return;
    state.handled.push(hs.hsid);
    if (!state.declined.includes(hs.hsid)) state.declined.push(hs.hsid);
    sendMessage(hs.channelId, { content: `🔑 SC1N.${hs.hsid}` }, false);
    await save();
}

/** The other side declined our request */
async function onDeclined(hs: Handshake, live: boolean) {
    const pending = state.pending[hs.hsid];
    const me = myId();
    // Only the person we asked can decline (or we ourselves on another PC)
    if (pending && pending.to !== hs.authorId) return;
    if (!pending && hs.authorId !== me) return;
    delete state.pending[hs.hsid];
    if (!state.declined.includes(hs.hsid)) state.declined.push(hs.hsid);
    if (!state.handled.includes(hs.hsid)) state.handled.push(hs.hsid);
    await save();
    if (live && pending) notify({ title: `${userName(hs.authorId)} declined the encrypted chat`, kind: "attention", app: "SecretChat" });
}

/** Our hello was answered: derive the key with our saved half */
async function completeHandshake(hs: Handshake) {
    const pending = state.pending[hs.hsid];
    const me = myId();
    if (!pending || !me || pending.to !== hs.authorId || busy.has(hs.hsid)) return;
    busy.add(hs.hsid);
    try {
        const { key, quantumSafe } = await completeHandshakeKey(pending, hs.publicKey, me, hs.authorId);
        const { record, isNew } = await addKey(key, { name: userName(hs.authorId), kind: "private", partnerId: hs.authorId, source: "handshake", quantumSafe });
        delete state.pending[hs.hsid];
        state.handled.push(hs.hsid);
        await finish(record, isNew, pending.channelId, hs.authorId);
    } catch (e) {
        logger.error("Completing the handshake failed", e);
        notify({ title: "Could not finish the encrypted chat setup", kind: "error", app: "SecretChat" });
    } finally {
        busy.delete(hs.hsid);
        emit();
    }
}

// ---------------------------------------------------------------- Deleting a 1:1 key for both

/**
 * "🔑 SC1D.<key id>.<proof>" – the proof is an empty ChaCha20-Poly1305 seal with the key itself, so only someone
 * who has the key can ask to delete it (Discord or anyone else can't make the partner lose their key).
 */
const DELETE_RE = /^🔑 SC1D\.([0-9a-f]{8})\.([A-Za-z0-9_-]{30,60})$/;
const deleteAad = (keyId: string, authorId: string) => encodeText(`SC1D|${keyId}|${authorId}`);

/** message id → the key delete it stands for, for the card under it */
export const keyDeletes = new Map<string, { keyId: string; authorId: string; }>();

/** Sends the delete request into the DM with the partner, then deletes the key here. False if there is no DM. */
export async function deleteKeyForBoth(record: KeyRecord) {
    const me = myId();
    const key = getKeyBytes(record.id);
    const channelId = record.partnerId && ChannelStore.getDMFromUserId(record.partnerId);
    if (!me || !key || !channelId) return false;
    const nonce = randomBytes(12);
    const proof = new Uint8Array(12 + 16);
    proof.set(nonce);
    proof.set(seal(key, nonce, new Uint8Array(0), deleteAad(record.id, me)), 12);
    sendMessage(channelId, { content: `🔑 SC1D.${record.id}.${toB64(proof)}` }, false);
    await deleteKey(record.id);
    return true;
}

function onDeleteRequest(keyId: string, proofText: string, authorId: string) {
    const record = getKey(keyId);
    const key = getKeyBytes(keyId);
    const me = myId();
    // Only 1:1 keys, and only from the partner (or yourself on another PC)
    if (!record || !key || record.kind !== "private" || (authorId !== record.partnerId && authorId !== me)) return;
    try {
        const proof = fromB64(proofText);
        if (proof.length !== 28 || !open(key, proof.subarray(0, 12), proof.subarray(12), deleteAad(keyId, authorId))) return;
    } catch {
        return;
    }
    setTimeout(async () => {
        if (!getKey(keyId)) return;
        await deleteKey(keyId);
        if (authorId !== me) notify({ title: `${userName(authorId)} deleted your encrypted chat key – start a new encrypted chat to talk securely again`, kind: "attention", app: "SecretChat" });
    }, 0);
}

// ---------------------------------------------------------------- Incoming

function tryDecrypt(content: string, authorId: string) {
    const env = parseMessage(content);
    if (!env) return undefined;
    const key = getKeyBytes(env.keyId);
    const plain = key ? decryptEnvelope(env, key, authorId) : null;
    return { keyId: env.keyId, plain };
}

/** Rewrites one raw message object in place. live = it just arrived (not loaded from history). */
function processMessage(m: any, live: boolean) {
    if (!m || typeof m !== "object") return;
    if (m.referenced_message) processMessage(m.referenced_message, false);

    const { content } = m;
    // Rune marker, or 🔒 / 🔑 (both start with this surrogate) – a cheap check for every message Discord handles
    if (typeof content !== "string") return;
    const first = content.charCodeAt(0);
    if (first !== 0xD83D && first !== RUNE_MARKER.charCodeAt(0)) return;
    const authorId: string | undefined = m.author?.id;
    if (!authorId) return;

    const result = tryDecrypt(content, authorId);
    if (result) {
        encryptedSeen.set(m.id, { channelId: m.channel_id, authorId, raw: content });
        // Emergency stop: show everything as it was sent (random characters) until it's turned off
        if (settings.store.emergency) return;
        if (result.plain != null) {
            // File message: the .bin goes out of the message, the decrypted file shows below it
            m.content = takeFile(m, result.plain, result.keyId) ?? result.plain;
            decrypted.set(m.id, result.keyId);
            locked.delete(m.id);
        } else {
            m.content = LOCKED_TEXT;
            locked.set(m.id, { channelId: m.channel_id, authorId, raw: content });
        }
        return;
    }

    if (processRoomMessage(m, live)) return;

    const del = DELETE_RE.exec(content);
    if (del) {
        keyDeletes.set(m.id, { keyId: del[1], authorId });
        m.content = "";
        onDeleteRequest(del[1], del[2], authorId);
        return;
    }

    const parsed = parseHandshake(content);
    if (!parsed) return;
    const hs: Handshake = { ...parsed, authorId, channelId: m.channel_id };
    handshakes.set(m.id, hs);
    // Only the card under the message shows it
    m.content = "";

    if (hs.type === "decline") {
        if (!state.declined.includes(hs.hsid)) setTimeout(() => onDeclined(hs, live), 0);
    } else if (hs.type === "ack" && state.pending[hs.hsid]) {
        setTimeout(() => completeHandshake(hs), 0);
    } else if (live && hs.type === "hello" && hs.to === myId() && !state.handled.includes(hs.hsid)) {
        notify({ title: `${userName(authorId)} wants an encrypted chat with you – accept it under their message`, kind: "info", app: "SecretChat" });
    }
}

/** Messages ChatPopout loads itself from the API (they don't go through the dispatcher) */
export function decryptLoaded(m: any) {
    processMessage(m, false);
}

/** Flux interceptor: runs before every store. Never blocks an action (always returns false). */
/** Our own request message was deleted → stop waiting for an answer */
function onDeleted(ids: string[]) {
    let changed = false;
    for (const id of ids) {
        const hs = handshakes.get(id);
        if (hs?.type === "hello" && state.pending[hs.hsid]) {
            delete state.pending[hs.hsid];
            changed = true;
        }
    }
    if (changed) setTimeout(save, 0);
}

export function intercept(action: any) {
    try {
        if (action.type === "MESSAGE_DELETE") onDeleted([action.id]);
        else if (action.type === "MESSAGE_DELETE_BULK" && Array.isArray(action.ids)) onDeleted(action.ids);
        if (action.message) {
            const live = action.type === "MESSAGE_CREATE" && !action.optimistic;
            processMessage(action.message, live);
            if (live) onRoomMessage(action.message);
        }
        const list = action.messages;
        if (Array.isArray(list)) {
            for (const m of list) {
                if (Array.isArray(m)) for (const n of m) processMessage(n, false); // search results are nested
                else processMessage(m, false);
            }
        }
    } catch (e) {
        logger.error("Failed to process", action.type, e);
    }
    return false;
}

/** After the keyring loaded: finish handshakes whose answer came in before */
export function retryHandshakes() {
    for (const hs of handshakes.values()) if (hs.type === "ack" && state.pending[hs.hsid]) completeHandshake(hs);
}

/** After a key was added: decrypt messages that were shown as locked */
/** Every encrypted message seen: message id → its sent (encrypted) text – to hide / show them again */
const encryptedSeen = new Map<string, { channelId: string; authorId: string; raw: string; }>();

/** Emergency stop on: every decrypted message goes back to its encrypted text. Off: decrypt them again. */
export function applyEmergency(on: boolean) {
    if (on) {
        for (const [id, e] of encryptedSeen) {
            if (!decrypted.has(id) && !locked.has(id)) continue;
            updateMessage(e.channelId, id, { content: e.raw });
        }
        decrypted.clear();
        locked.clear();
    } else {
        for (const [id, e] of encryptedSeen) {
            const result = tryDecrypt(e.raw, e.authorId);
            if (!result) continue;
            if (result.plain != null) {
                decrypted.set(id, result.keyId);
                updateMessage(e.channelId, id, { content: isFileText(result.plain) ? "" : result.plain });
            } else {
                locked.set(id, e);
                updateMessage(e.channelId, id, { content: LOCKED_TEXT });
            }
        }
    }
    emit();
}

export function retryLocked() {
    for (const [id, { channelId, authorId, raw }] of locked) {
        const result = tryDecrypt(raw, authorId);
        if (result?.plain == null) continue;
        locked.delete(id);
        decrypted.set(id, result.keyId);
        updateMessage(channelId, id, { content: isFileText(result.plain) ? "" : result.plain });
    }
}

// ---------------------------------------------------------------- Outgoing

/** Already encrypted, or a SecretChat protocol message – sent as it is */
const isPrepared = (content: string) => content.startsWith("🔑 SC1") || parseMessage(content) != null;

/** Content to send in this chat: the same, encrypted, or null = don't send it at all */
function outgoing(channelId: string, content: string): string | null {
    // The keyring loads a moment after start – never let an "on" chat slip out unencrypted
    if (!isLoaded()) {
        notify({ title: "SecretChat is still loading its keys – try again in a second", kind: "error", app: "SecretChat" });
        return null;
    }
    const record = channelKey(channelId);
    if (!record) {
        if (containsInviteCode(content)) {
            notify({ title: "That's a secret key code – only send it in an encrypted chat (turn SecretChat on here first)", kind: "error", app: "SecretChat" });
            return null;
        }
        return content;
    }
    if (!content.trim() || isPrepared(content)) return content;

    const me = myId();
    const key = getKeyBytes(record.id);
    if (!me || !key) return null;

    const encrypted = encryptMessage(record.id, key, me, content);
    if (encrypted.length > MAX_LENGTH) {
        notify({ title: "Too long for one encrypted message (about 1,400 characters max) – split it up", kind: "error", app: "SecretChat" });
        return null;
    }
    return encrypted;
}

/** Edits of an encrypted message are encrypted again with the same key. null = don't save the edit */
function outgoingEdit(messageId: string, content: string): string | null {
    const keyId = decrypted.get(messageId);
    if (!keyId || isPrepared(content)) return content;
    const key = getKeyBytes(keyId);
    const me = myId();
    if (!key || !me) {
        notify({ title: `The key "${getKey(keyId)?.name ?? keyId}" was deleted – this message can't be edited anymore`, kind: "error", app: "SecretChat" });
        return null;
    }
    const encrypted = encryptMessage(keyId, key, me, content);
    if (encrypted.length > MAX_LENGTH) {
        notify({ title: "Too long for one encrypted message (about 1,400 characters max)", kind: "error", app: "SecretChat" });
        return null;
    }
    return encrypted;
}

/** Discord's chat input */
export const onBeforeSend: MessageSendListener = (channelId, msg) => {
    const content = outgoing(channelId, msg.content);
    if (content == null) return { cancel: true };
    msg.content = content;
};

export const onBeforeEdit: MessageEditListener = (_channelId, messageId, msg) => {
    const content = outgoingEdit(messageId, msg.content);
    if (content == null) return { cancel: true };
    msg.content = content;
};

// Vencord's send / edit events only cover Discord's own chat input. Everything else (ChatPopout and the
// rooms window, other plugins) calls Discord's sendMessage / editMessage directly – so those are wrapped too.
// Content that is already encrypted passes unchanged, so nothing is encrypted twice.

let actions: any = null;
let originalSend: ((...args: any[]) => any) | null = null;
let originalEdit: ((...args: any[]) => any) | null = null;

const notSent = () => Promise.reject(new Error("SecretChat: not sent"));

export function wrapMessageActions() {
    if (actions) return;
    actions = findByProps("sendMessage", "editMessage");
    originalSend = actions.sendMessage;
    originalEdit = actions.editMessage;

    actions.sendMessage = function (this: any, channelId: string, message: any, ...rest: any[]) {
        if (typeof message?.content === "string") {
            const content = outgoing(channelId, message.content);
            if (content == null) return notSent();
            if (content !== message.content) message = { ...message, content };
        }
        return originalSend!.call(this, channelId, message, ...rest);
    };

    actions.editMessage = function (this: any, channelId: string, messageId: string, message: any, ...rest: any[]) {
        if (typeof message?.content === "string") {
            const content = outgoingEdit(messageId, message.content);
            if (content == null) return notSent();
            if (content !== message.content) message = { ...message, content };
        }
        return originalEdit!.call(this, channelId, messageId, message, ...rest);
    };
}

/** Sending outside Discord's chat input is only safe while the wrap is in place */
export const isSendGuarded = () => actions != null;

export function unwrapMessageActions() {
    if (!actions) return;
    actions.sendMessage = originalSend;
    actions.editMessage = originalEdit;
    actions = originalSend = originalEdit = null;
}
