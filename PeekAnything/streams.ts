/*
 * PeekAnything – watching Go Live streams for a peek
 * Starts watching via Discord's own STREAM_WATCH (allowMultiple, no focus change), keeps the connection a little
 * after the peek so the next one is instant, and never closes a stream you were already watching yourself.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByPropsLazy } from "@webpack";
import {
    ApplicationStreamingStore, ApplicationStreamPreviewStore, ChannelRTCStore, FluxDispatcher, MediaEngineStore, RestAPI, SelectedChannelStore
} from "@webpack/common";

import { logger, settings } from "./index";

const VoiceActions = findByPropsLazy("toggleSelfMute", "toggleSelfDeaf");

export interface StreamRef {
    userId: string;
    channelId: string;
    guildId: string | null;
    streamKey: string;
}

interface Watch {
    ref: StreamRef;
    /** Peeks currently showing this stream */
    users: number;
    closeTimer?: ReturnType<typeof setTimeout>;
    /** We muted the stream audio and have to undo it */
    mutedByUs: boolean;
}

/** Streams that were started by a peek – everything else belongs to the user */
const watches = new Map<string, Watch>();

export const inVoiceChannel = (channelId: string) => SelectedChannelStore.getVoiceChannelId() === channelId;

function isStreamMuted(userId: string) {
    try {
        return MediaEngineStore.isLocalMute(userId, "stream" as any);
    } catch {
        return false;
    }
}

export function toggleStreamMute(userId: string) {
    try {
        VoiceActions.toggleLocalMute(userId, "stream");
    } catch (e) {
        logger.error("Couldn't toggle stream audio", e);
    }
}

/** Starts watching (if possible and not already watched by the user). Call releaseStream when the peek ends. */
export function acquireStream(ref: StreamRef) {
    const known = watches.get(ref.streamKey);
    if (known) {
        clearTimeout(known.closeTimer);
        known.closeTimer = undefined;
        known.users++;
        return;
    }
    // Only possible while connected to that call (Discord's rule)
    if (!inVoiceChannel(ref.channelId)) return;
    // The user already watches it – leave it completely alone
    if (ApplicationStreamingStore.getActiveStreamForStreamKey(ref.streamKey)) return;

    const watch: Watch = { ref, users: 1, mutedByUs: false };
    try {
        FluxDispatcher.dispatch({ type: "STREAM_WATCH", streamKey: ref.streamKey, allowMultiple: true } as any);
    } catch (e) {
        logger.error("Couldn't watch stream", e);
        return;
    }
    if (settings.store.muteStream && !isStreamMuted(ref.userId)) {
        toggleStreamMute(ref.userId);
        watch.mutedByUs = true;
    }
    watches.set(ref.streamKey, watch);
}

export function releaseStream(streamKey: string) {
    const watch = watches.get(streamKey);
    if (!watch) return;
    watch.users = Math.max(0, watch.users - 1);
    if (watch.users) return;
    clearTimeout(watch.closeTimer);
    const keep = Math.max(0, Number(settings.store.keepStreamSeconds) || 0) * 1000;
    watch.closeTimer = setTimeout(() => closeWatch(watch), keep);
}

function closeWatch(watch: Watch) {
    const { ref } = watch;
    watches.delete(ref.streamKey);
    clearTimeout(watch.closeTimer);

    if (watch.mutedByUs && isStreamMuted(ref.userId)) toggleStreamMute(ref.userId);

    // Meanwhile opened in the call view by the user: it is theirs now
    if (ChannelRTCStore.getSelectedParticipantId(ref.channelId) === ref.streamKey) return;
    try {
        FluxDispatcher.dispatch({ type: "STREAM_CLOSE", streamKey: ref.streamKey } as any);
    } catch (e) {
        logger.error("Couldn't close stream", e);
    }
}

export function closeAllStreams() {
    for (const watch of [...watches.values()]) closeWatch(watch);
}

/** True if the stream is connected because of a peek (so its audio state is ours to show) */
export const isPeekStream = (streamKey: string) => watches.has(streamKey);

// ---------------------------------------------------------------- Preview thumbnail

/** Same request Discord makes when you hover a stream; the result lands in ApplicationStreamPreviewStore */
export async function fetchPreview(ref: StreamRef) {
    try {
        if (!ApplicationStreamPreviewStore.shouldFetchPreview(ref.guildId, ref.channelId, ref.userId)) return;
    } catch {
        return;
    }
    FluxDispatcher.dispatch({ type: "STREAM_PREVIEW_FETCH_START", streamKey: ref.streamKey } as any);
    try {
        const { body } = await RestAPI.get({ url: `/streams/${ref.streamKey}/preview`, query: { version: Date.now() } });
        FluxDispatcher.dispatch({ type: "STREAM_PREVIEW_FETCH_SUCCESS", streamKey: ref.streamKey, previewURL: body?.url ?? null } as any);
    } catch (e: any) {
        const retryAfter = e?.status === 429 && e?.body?.retry_after ? e.body.retry_after * 1000 : undefined;
        FluxDispatcher.dispatch({ type: "STREAM_PREVIEW_FETCH_FAIL", streamKey: ref.streamKey, retryAfter } as any);
    }
}
