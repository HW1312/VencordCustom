/*
 * MessageSelect – actions on the selected messages (quote, copy, forward, delete, image export)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyToClipboard } from "@utils/clipboard";
import { insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import type { Channel, Message } from "@vencord/discord-types";
import { ChannelStore, MessageActions, RestAPI, SelectedChannelStore, showToast } from "@webpack/common";

import { canDelete, clear, displayName, formatFullDate, getChannel, getSelectedMessages, messageDate, messagesToQuote, messagesToText, readableContent, remove, setBusy, state } from "./store";

export const logger = new Logger("MessageSelect");

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function nativeApi(): any {
    return (window as any).DiscordNative;
}

// ---------------------------------------------------------------- Quote & copy

export function quoteSelected() {
    const messages = getSelectedMessages();
    if (!messages.length) return;
    const guildId = getChannel()?.guild_id;

    if (SelectedChannelStore.getChannelId() !== state.channelId) {
        showToast("Open the channel to quote into its chat box", "failure");
        return;
    }
    insertTextIntoChatInputBox(messagesToQuote(messages, guildId));
    clear();
}

export async function copySelected() {
    const messages = getSelectedMessages();
    if (!messages.length) return;
    try {
        await copyToClipboard(messagesToText(messages, getChannel()?.guild_id));
        showToast(`Copied ${messages.length} message${messages.length === 1 ? "" : "s"}`, "success");
    } catch (e) {
        logger.error("Couldn't copy", e);
        showToast("Couldn't copy", "failure");
    }
}

// ---------------------------------------------------------------- Delete

/** Deletes the selected messages the user is allowed to delete, one after another */
export async function deleteSelected(messages: Message[], delay: number) {
    const channel = getChannel();
    const { channelId } = state;
    if (!channelId) return;
    const targets = messages.filter(m => canDelete(m, channel));
    if (!targets.length) return;

    const busy = { label: "Deleting", done: 0, total: targets.length, cancelled: false };
    setBusy(busy);
    let failed = 0;

    for (const m of targets) {
        if (busy.cancelled) break;
        let ok = await deleteOne(channelId, m.id);
        if (!ok && !busy.cancelled) {
            // Likely rate limited – wait and try once more
            await sleep(3000);
            ok = await deleteOne(channelId, m.id);
        }
        if (!ok) failed++;
        busy.done++;
        if (ok) remove(channelId, [m.id]);
        // Same object: Stop/Cancel set busy.cancelled on it
        setBusy(busy);
        if (busy.done < busy.total && !busy.cancelled) await sleep(delay);
    }

    const deleted = busy.done - failed;
    if (state.busy === busy) setBusy(null);
    if (failed) showToast(`Deleted ${deleted} of ${targets.length} messages, ${failed} failed`, "failure");
    else showToast(`Deleted ${deleted} message${deleted === 1 ? "" : "s"}`, "success");
    if (state.channelId === channelId && !state.ids.size) clear();
}

async function deleteOne(channelId: string, messageId: string) {
    try {
        await Promise.resolve(MessageActions.deleteMessage(channelId, messageId));
        return true;
    } catch (e) {
        logger.warn("deleteMessage failed, trying REST", e);
        try {
            await RestAPI.del({ url: `/channels/${channelId}/messages/${messageId}` });
            return true;
        } catch (e2: any) {
            // 404: already gone
            if (e2?.status === 404) return true;
            logger.error("Couldn't delete message", messageId, e2);
            return false;
        }
    }
}

// ---------------------------------------------------------------- Forward

export type ForwardMode = "native" | "text";

/**
 * Forwards via the public REST API: POST /channels/{id}/messages with a message_reference of type 1 (FORWARD).
 * That is exactly what Discord's own "Forward" button sends, but it only takes one message per request,
 * so the messages go out one by one. If a native forward fails (e.g. message type that can't be forwarded),
 * that message is sent as a quoted text instead.
 */
export async function forwardSelected(target: Channel, mode: ForwardMode, delay: number) {
    const messages = getSelectedMessages();
    const source = getChannel();
    if (!messages.length || !source) return;

    const busy = { label: "Forwarding", done: 0, total: mode === "native" ? messages.length : 1, cancelled: false };
    setBusy(busy);
    let fallbacks = 0;
    let failed = 0;

    try {
        if (mode === "text") {
            failed += await sendAsText(target, source, messages) ? 0 : 1;
            busy.done = 1;
        } else {
            for (const m of messages) {
                if (busy.cancelled) break;
                const ok = await forwardNative(target, source, m);
                if (!ok) {
                    fallbacks++;
                    if (!await sendAsText(target, source, [m])) failed++;
                }
                busy.done++;
                setBusy(busy);
                if (busy.done < busy.total && !busy.cancelled) await sleep(delay);
            }
        }
    } finally {
        if (state.busy === busy) setBusy(null);
    }

    const where = target.name ? `#${target.name}` : "the conversation";
    if (failed) showToast(`Forwarding to ${where}: ${failed} failed`, "failure");
    else if (fallbacks) showToast(`Forwarded to ${where} (${fallbacks} as text)`, "success");
    else showToast(`Forwarded to ${where}`, "success");
    clear();
}

async function forwardNative(target: Channel, source: Channel, m: Message) {
    try {
        await RestAPI.post({
            url: `/channels/${target.id}/messages`,
            body: {
                content: "",
                flags: 0,
                mobile_network_type: "unknown",
                nonce: makeNonce(),
                tts: false,
                message_reference: {
                    type: 1,
                    channel_id: source.id,
                    guild_id: source.guild_id ?? undefined,
                    message_id: m.id
                }
            }
        });
        return true;
    } catch (e) {
        logger.warn("Native forward failed for", m.id, e);
        return false;
    }
}

function makeNonce() {
    // Snowflake for "now" – same format Discord uses for nonces
    return String((BigInt(Date.now()) - 1420070400000n) << 22n);
}

/** Sends the messages as quote text with a header, split into chunks of max. 2000 characters */
async function sendAsText(target: Channel, source: Channel, messages: Message[]) {
    const guildId = source.guild_id;
    const where = source.name ? `#${source.name}` : "a DM";
    const lines: string[] = [`-# Forwarded from ${where}`];
    let lastAuthor: string | null = null;

    for (const m of messages) {
        if (m.author?.id !== lastAuthor) lines.push(`> **${displayName(m.author, guildId)}** • ${formatFullDate(messageDate(m))}`);
        lastAuthor = m.author?.id ?? null;
        const body = readableContent(m.content, guildId);
        for (const l of body.split("\n")) if (body.trim()) lines.push(`> ${l}`);
        for (const a of m.attachments ?? []) lines.push(`> ${a.url}`);
    }

    const chunks: string[] = [];
    let cur = "";
    for (const line of lines) {
        const piece = line.length > 1900 ? line.slice(0, 1900) + "…" : line;
        if (cur.length + piece.length + 1 > 2000) {
            chunks.push(cur);
            cur = "";
        }
        cur += (cur ? "\n" : "") + piece;
    }
    if (cur) chunks.push(cur);

    try {
        for (const [i, content] of chunks.entries()) {
            await Promise.resolve(sendMessage(target.id, { content }, false, { allowedMentions: { parse: [], replied_user: false } }));
            if (i < chunks.length - 1) await sleep(800);
        }
        return true;
    } catch (e) {
        logger.error("Couldn't send forwarded text", e);
        return false;
    }
}

export const getChannelById = (id: string) => ChannelStore.getChannel(id);

// ---------------------------------------------------------------- Image export

export async function copyPng(png: Blob) {
    try {
        const Item = (window as any).ClipboardItem;
        if (Item && navigator.clipboard?.write) {
            await navigator.clipboard.write([new Item({ "image/png": png })]);
        } else {
            throw new Error("ClipboardItem not available");
        }
        showToast("Image copied", "success");
        return;
    } catch (e) {
        logger.warn("navigator.clipboard.write failed, trying DiscordNative", e);
    }

    try {
        const clip = nativeApi()?.clipboard;
        if (typeof clip?.copyImage !== "function") throw new Error("No native clipboard");
        await clip.copyImage(new Uint8Array(await png.arrayBuffer()), "messages.png");
        showToast("Image copied", "success");
    } catch (e) {
        logger.error("Couldn't copy image", e);
        showToast("Couldn't copy image", "failure");
    }
}

export async function savePng(png: Blob, name: string) {
    try {
        const files = nativeApi()?.fileManager;
        if (typeof files?.saveWithDialog === "function") {
            await files.saveWithDialog(new Uint8Array(await png.arrayBuffer()), name);
            return;
        }
        const a = document.createElement("a");
        a.href = URL.createObjectURL(png);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            URL.revokeObjectURL(a.href);
            a.remove();
        }, 0);
    } catch (e) {
        logger.error("Couldn't save image", e);
        showToast("Couldn't save image", "failure");
    }
}
