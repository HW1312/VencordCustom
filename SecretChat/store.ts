/*
 * SecretChat – Keyring and per-chat state, saved in Vencord's DataStore (IndexedDB, not in the settings file)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { useEffect, useReducer } from "@webpack/common";

import { fromB64, keyIdOf, safetyCode, toB64 } from "./crypto";

export interface KeyRecord {
    /** keyIdOf(key), sent with every message */
    id: string;
    name: string;
    /** private: made by a handshake, only you and partnerId have it. group: anyone with the code / password */
    kind: "private" | "group";
    partnerId?: string;
    source?: "handshake" | "random" | "password" | "code";
    key: string;
    safety: string;
    created: number;
}

export interface PendingHandshake {
    to: string;
    channelId: string;
    privateJwk: JsonWebKey;
    created: number;
}

interface State {
    keys: KeyRecord[];
    /** channel id → key id used for sending. Missing = encryption off */
    channels: Record<string, string>;
    /** channel id → key id that was on last, for the right-click toggle */
    lastUsed: Record<string, string>;
    /** handshake id → our half, until the other side answers */
    pending: Record<string, PendingHandshake>;
    /** handshake ids that were accepted / ignored / completed */
    handled: string[];
}

const STORE_KEY = "SecretChat_state";

export const state: State = { keys: [], channels: {}, lastUsed: {}, pending: {}, handled: [] };
const keyBytes = new Map<string, Uint8Array>();
let loaded = false;

const listeners = new Set<() => void>();

export function emit() {
    for (const l of listeners) l();
}

export function save() {
    emit();
    return DataStore.set(STORE_KEY, state);
}

export async function loadState() {
    const saved = await DataStore.get<Partial<State>>(STORE_KEY);
    Object.assign(state, { keys: [], channels: {}, lastUsed: {}, pending: {}, handled: [] }, saved ?? {});
    keyBytes.clear();
    for (const k of state.keys) keyBytes.set(k.id, fromB64(k.key));
    loaded = true;
    emit();
}

export const isLoaded = () => loaded;

/** Re-renders the component whenever keys or chat settings change */
export function useStore() {
    const [, rerender] = useReducer((x: number) => x + 1, 0);
    useEffect(() => {
        listeners.add(rerender);
        return () => void listeners.delete(rerender);
    }, []);
    return state;
}

export function onChange(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

// ---------------------------------------------------------------- Keys

export const getKey = (id: string) => state.keys.find(k => k.id === id);
export const getKeyBytes = (id: string) => keyBytes.get(id);

function uniqueName(name: string) {
    const taken = new Set(state.keys.map(k => k.name));
    if (!taken.has(name)) return name;
    let i = 2;
    while (taken.has(`${name} (${i})`)) i++;
    return `${name} (${i})`;
}

/** Adds a key. Returns the existing record (and isNew false) if the same key is already in the keyring. */
export async function addKey(key: Uint8Array, info: Pick<KeyRecord, "name" | "kind" | "partnerId" | "source">) {
    const id = await keyIdOf(key);
    const existing = getKey(id);
    if (existing) return { record: existing, isNew: false };

    const record: KeyRecord = {
        ...info,
        id,
        name: uniqueName(info.name.trim() || "Key"),
        key: toB64(key),
        safety: await safetyCode(key),
        created: Date.now()
    };
    state.keys.push(record);
    keyBytes.set(id, key);
    await save();
    return { record, isNew: true };
}

/** Old messages stay readable only while their key exists – so deleting is always the user's explicit choice */
export async function deleteKey(id: string) {
    state.keys = state.keys.filter(k => k.id !== id);
    keyBytes.delete(id);
    for (const [ch, k] of Object.entries(state.channels)) if (k === id) delete state.channels[ch];
    for (const [ch, k] of Object.entries(state.lastUsed)) if (k === id) delete state.lastUsed[ch];
    await save();
}

export async function renameKey(id: string, name: string) {
    const k = getKey(id);
    if (!k || !name.trim()) return;
    k.name = name.trim();
    await save();
}

// ---------------------------------------------------------------- Chats

export const channelKey = (channelId: string) => {
    const id = state.channels[channelId];
    return id && keyBytes.has(id) ? getKey(id) : undefined;
};

/** Drops our open requests to this user (e.g. the request message was deleted) */
export async function cancelPending(userId: string) {
    for (const [hsid, p] of Object.entries(state.pending)) if (p.to === userId) delete state.pending[hsid];
    await save();
}

export async function setChannelKey(channelId: string, keyId: string | null) {
    if (keyId) {
        state.channels[channelId] = keyId;
        state.lastUsed[channelId] = keyId;
    } else {
        delete state.channels[channelId];
    }
    await save();
}

/** Right-click on the chat bar button: off ↔ the key used last (or the only key) */
export async function toggleChannel(channelId: string) {
    if (state.channels[channelId]) return setChannelKey(channelId, null), null;
    const id = state.lastUsed[channelId] && keyBytes.has(state.lastUsed[channelId])
        ? state.lastUsed[channelId]
        : state.keys.length === 1 ? state.keys[0].id : null;
    if (id) await setChannelKey(channelId, id);
    return id;
}

// ---------------------------------------------------------------- Invite codes for group keys

/** "sckey1.<name>.<key>" – contains the key itself, so only send it in an encrypted chat or in person */
const CODE_RE = /sckey1\.([A-Za-z0-9_-]*)\.([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/;

export function inviteCode(record: KeyRecord) {
    return `sckey1.${toB64(new TextEncoder().encode(record.name))}.${record.key}`;
}

export function parseInviteCode(text: string) {
    const m = CODE_RE.exec(text);
    if (!m) return null;
    try {
        const key = fromB64(m[2]);
        if (key.length !== 32) return null;
        const name = new TextDecoder().decode(fromB64(m[1])).slice(0, 64);
        return { name, key };
    } catch {
        return null;
    }
}

export const containsInviteCode = (text: string) => CODE_RE.test(text);
