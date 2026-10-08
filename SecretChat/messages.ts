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
import { showToast, Toasts, UserStore } from "@webpack/common";

import { decryptEnvelope, deriveSharedKey, encryptMessage, newHandshakeKeyPair, parseMessage, randomBytes, RUNE_MARKER, toHex } from "./crypto";
import { onRoomMessage, processRoomMessage } from "./rooms";
import { addKey, channelKey, containsInviteCode, emit, getKey, getKeyBytes, isLoaded, KeyRecord, save, setChannelKey, state } from "./store";

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
 */
const HELLO_RE = /^🔑 SC1H\.(\d{15,21})\.([0-9a-f]{16})\.([A-Za-z0-9_-]{80,100})$/;
const ACK_RE = /^🔑 SC1A\.([0-9a-f]{16})\.([A-Za-z0-9_-]{80,100})$/;

export interface Handshake {
    type: "hello" | "ack";
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
    return null;
}

const myId = () => UserStore.getCurrentUser()?.id;
const userName = (id: string) => {
    const u = UserStore.getUser(id);
    return u ? (u as any).globalName || u.username : "Unknown user";
};

export async function startHandshake(user: User, channelId: string) {
    const hsid = toHex(randomBytes(8));
    const { publicKey, privateJwk } = await newHandshakeKeyPair();
    state.pending[hsid] = { to: user.id, channelId, privateJwk, created: Date.now() };
    await save();
    sendMessage(channelId, { content: `🔑 SC1H.${user.id}.${hsid}.${publicKey}` }, false);
    showToast(`Asked ${userName(user.id)} for an encrypted chat – waiting for them to accept`, Toasts.Type.MESSAGE);
}

async function finish(record: KeyRecord, isNew: boolean, channelId: string, partnerId: string) {
    await setChannelKey(channelId, record.id);
    retryLocked();
    showToast(
        `${isNew ? "Encrypted chat with" : "Already connected with"} ${userName(partnerId)} – safety code ${record.safety}`,
        Toasts.Type.SUCCESS
    );
}

export async function acceptHandshake(hs: Handshake) {
    const me = myId();
    if (!me || hs.to !== me || busy.has(hs.hsid) || state.handled.includes(hs.hsid)) return;
    busy.add(hs.hsid);
    try {
        const { publicKey, privateJwk } = await newHandshakeKeyPair();
        const key = await deriveSharedKey(privateJwk, hs.publicKey, me, hs.authorId);
        const { record, isNew } = await addKey(key, { name: userName(hs.authorId), kind: "private", partnerId: hs.authorId, source: "handshake" });
        state.handled.push(hs.hsid);
        sendMessage(hs.channelId, { content: `🔑 SC1A.${hs.hsid}.${publicKey}` }, false);
        await finish(record, isNew, hs.channelId, hs.authorId);
    } catch (e) {
        logger.error("Accepting the handshake failed", e);
        showToast("Could not accept the encrypted chat", Toasts.Type.FAILURE);
    } finally {
        busy.delete(hs.hsid);
        emit();
    }
}

export async function ignoreHandshake(hs: Handshake) {
    if (!state.handled.includes(hs.hsid)) state.handled.push(hs.hsid);
    await save();
}

/** Our hello was answered: derive the key with our saved half */
async function completeHandshake(hs: Handshake) {
    const pending = state.pending[hs.hsid];
    const me = myId();
    if (!pending || !me || pending.to !== hs.authorId || busy.has(hs.hsid)) return;
    busy.add(hs.hsid);
    try {
        const key = await deriveSharedKey(pending.privateJwk, hs.publicKey, me, hs.authorId);
        const { record, isNew } = await addKey(key, { name: userName(hs.authorId), kind: "private", partnerId: hs.authorId, source: "handshake" });
        delete state.pending[hs.hsid];
        state.handled.push(hs.hsid);
        await finish(record, isNew, pending.channelId, hs.authorId);
    } catch (e) {
        logger.error("Completing the handshake failed", e);
        showToast("Could not finish the encrypted chat setup", Toasts.Type.FAILURE);
    } finally {
        busy.delete(hs.hsid);
        emit();
    }
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
        if (result.plain != null) {
            m.content = result.plain;
            decrypted.set(m.id, result.keyId);
            locked.delete(m.id);
        } else {
            m.content = LOCKED_TEXT;
            locked.set(m.id, { channelId: m.channel_id, authorId, raw: content });
        }
        return;
    }

    if (processRoomMessage(m, live)) return;

    const parsed = parseHandshake(content);
    if (!parsed) return;
    const hs: Handshake = { ...parsed, authorId, channelId: m.channel_id };
    handshakes.set(m.id, hs);
    m.content = hs.type === "hello" ? "🔑 *Asked for an encrypted chat*" : "🔑 *Accepted the encrypted chat*";

    if (hs.type === "ack" && state.pending[hs.hsid]) {
        setTimeout(() => completeHandshake(hs), 0);
    } else if (live && hs.type === "hello" && hs.to === myId() && !state.handled.includes(hs.hsid)) {
        showToast(`${userName(authorId)} wants an encrypted chat with you – accept it under their message`, Toasts.Type.MESSAGE);
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
export function retryLocked() {
    for (const [id, { channelId, authorId, raw }] of locked) {
        const result = tryDecrypt(raw, authorId);
        if (result?.plain == null) continue;
        locked.delete(id);
        decrypted.set(id, result.keyId);
        updateMessage(channelId, id, { content: result.plain });
    }
}

// ---------------------------------------------------------------- Outgoing

/** Already encrypted, or a SecretChat protocol message – sent as it is */
const isPrepared = (content: string) => content.startsWith("🔑 SC1") || parseMessage(content) != null;

/** Content to send in this chat: the same, encrypted, or null = don't send it at all */
function outgoing(channelId: string, content: string): string | null {
    // The keyring loads a moment after start – never let an "on" chat slip out unencrypted
    if (!isLoaded()) {
        showToast("SecretChat is still loading its keys – try again in a second", Toasts.Type.FAILURE);
        return null;
    }
    const record = channelKey(channelId);
    if (!record) {
        if (containsInviteCode(content)) {
            showToast("That's a secret key code – only send it in an encrypted chat (turn SecretChat on here first)", Toasts.Type.FAILURE);
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
        showToast("Too long for one encrypted message (about 1,400 characters max) – split it up", Toasts.Type.FAILURE);
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
        showToast(`The key "${getKey(keyId)?.name ?? keyId}" was deleted – this message can't be edited anymore`, Toasts.Type.FAILURE);
        return null;
    }
    const encrypted = encryptMessage(keyId, key, me, content);
    if (encrypted.length > MAX_LENGTH) {
        showToast("Too long for one encrypted message (about 1,400 characters max)", Toasts.Type.FAILURE);
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
