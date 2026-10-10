/*
 * SecretChat – Deletes our own key exchange messages (requests, answers, room joins) once they did their job, so
 * the chat isn't full of them. People without SecretChat would otherwise see long codes there.
 *
 * Who deletes what (everyone can only delete their own messages):
 * - the asking side deletes its request as soon as the answer (key or decline) arrived
 * - the answering side deletes its answer when it sees the request disappear – that means it was received
 * - anything of ours older than STALE is deleted when it shows up (the other side was offline too long, or the
 *   delete above was missed)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { RestAPI } from "@webpack/common";

import { settings } from "./settings";

const logger = new Logger("SecretChat");

export const STALE = 3 * 24 * 60 * 60 * 1000;

const removed = new Set<string>();

export interface MessageRef {
    id: string;
    channelId: string;
}

export const refOf = (m: any): MessageRef => ({ id: m.id, channelId: m.channel_id });

export const ageOf = (m: any) => m.timestamp ? Date.now() - new Date(m.timestamp).getTime() : 0;

export function removeMessage(ref: MessageRef | undefined) {
    if (!ref || !settings.store.cleanup || removed.has(ref.id)) return;
    removed.add(ref.id);
    // A moment later, so it doesn't happen while Discord is still handling the message
    setTimeout(() => {
        RestAPI.del({ url: `/channels/${ref.channelId}/messages/${ref.id}` })
            .catch(e => logger.warn("Could not delete a key exchange message", e));
    }, 300);
}
