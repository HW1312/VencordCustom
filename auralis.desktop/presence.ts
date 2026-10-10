// SPDX-License-Identifier: GPL-3.0-or-later
// Explicit allowlist: no account IDs, tokens, profile URLs or session IDs.
export interface Track {
    title: string;
    artist: string;
    album: string;
    playing: boolean;
    positionMs: number;
    durationMs: number;
    observedAt: number;
}

export interface PresenceOptions {
    applicationId: string;
    showProgress: boolean;
    searchButton: boolean;
    coverAsset?: string;
}

export function decodeTrack(value: unknown, now = Date.now()): Track | null {
    if (!value || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
    if (typeof v.title !== "string" || !v.title.trim() || typeof v.artist !== "string"
        || typeof v.album !== "string" || typeof v.playing !== "boolean"
        || !finite(v.positionMs) || !finite(v.durationMs) || !finite(v.observedAt)
        || v.durationMs < 0 || v.positionMs < 0
        || now - v.observedAt > 15000 || v.observedAt > now + 5000) return null;
    return {
        title: v.title.trim().slice(0, 128),
        artist: v.artist.trim().slice(0, 128),
        album: v.album.trim().slice(0, 128),
        playing: v.playing,
        positionMs: v.durationMs > 0 ? Math.min(v.positionMs, v.durationMs) : v.positionMs,
        durationMs: v.durationMs,
        observedAt: v.observedAt
    };
}

export function createPresence(track: Track | null, options: PresenceOptions, now = Date.now()) {
    if (!track?.playing || !/^\d{17,20}$/.test(options.applicationId)
        || now - track.observedAt > 15000) return null;
    const position = track.positionMs + Math.max(0, now - track.observedAt);
    const start = Math.floor((now - Math.min(position, track.durationMs || position)) / 1000) * 1000;
    return {
        application_id: options.applicationId,
        name: "Spotify",
        type: 2,
        flags: 0,
        details: track.title,
        state: track.artist || "Unknown artist",
        ...(options.coverAsset ? {
            assets: { large_image: options.coverAsset, large_text: track.album || track.title }
        } : {}),
        ...(options.showProgress && track.durationMs > 0 ? {
            timestamps: { start, end: start + track.durationMs }
        } : {}),
        ...(options.searchButton ? {
            buttons: ["Search on Spotify"],
            metadata: { button_urls: [`https://open.spotify.com/search/${encodeURIComponent(`${track.title} ${track.artist}`)}`] }
        } : {})
    };
}
