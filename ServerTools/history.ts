/*
 * ServerTools – load a channel's message history
 * 100 messages per request, going backwards, up to a date or a maximum count.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { api, CancelToken } from "./queue";

export interface LiteMessage {
    id: string;
    authorId: string;
    authorName: string;
    bot: boolean;
    /** ms since epoch */
    timestamp: number;
}

export interface HistoryOptions {
    /** Only messages from this point in time (ms) */
    since?: number;
    /** Maximum number of messages */
    max: number;
    token?: CancelToken;
    onProgress?(loaded: number): void;
    onRateLimit?(seconds: number): void;
}

export interface HistoryResult {
    messages: LiteMessage[];
    /** true if loading stopped early because of the maximum count */
    truncated: boolean;
    requests: number;
}

export async function loadHistory(channelId: string, opts: HistoryOptions): Promise<HistoryResult> {
    const messages: LiteMessage[] = [];
    let before: string | undefined;
    let truncated = false;
    let requests = 0;

    while (true) {
        opts.token?.throwIfCancelled();

        const page = await api<any[]>("get", {
            url: `/channels/${channelId}/messages`,
            query: before ? { limit: 100, before } : { limit: 100 }
        }, { token: opts.token, onRateLimit: opts.onRateLimit });
        requests++;

        if (!Array.isArray(page) || page.length === 0) break;

        let reachedEnd = false;
        for (const m of page) {
            const timestamp = Date.parse(m.timestamp);
            if (opts.since != null && timestamp < opts.since) {
                reachedEnd = true;
                break;
            }
            messages.push({
                id: m.id,
                authorId: m.author?.id ?? "0",
                authorName: m.author?.global_name || m.author?.username || "Unknown",
                bot: !!m.author?.bot || m.webhook_id != null,
                timestamp
            });
            if (messages.length >= opts.max) {
                truncated = true;
                reachedEnd = true;
                break;
            }
        }

        opts.onProgress?.(messages.length);
        if (reachedEnd || page.length < 100) break;
        before = page[page.length - 1].id;
    }

    return { messages, truncated, requests };
}
