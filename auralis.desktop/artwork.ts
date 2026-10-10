// SPDX-License-Identifier: GPL-3.0-or-later
import type { Track } from "./presence";

export function trackKey(track: Pick<Track, "title" | "artist" | "album">): string {
    return JSON.stringify([track.title, track.artist, track.album]);
}

// Only covers Auralis uploaded itself: Litterbox file links (random 6-char name, jpg/png), HTTPS, no credentials or port.
export function safeCoverUrl(value: unknown): string | null {
    if (typeof value !== "string" || value.length > 256) return null;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === "litter.catbox.moe"
            && !url.username && !url.password && !url.port && !url.search && !url.hash
            && /^\/[a-z0-9]{4,16}\.(?:jpg|png)$/i.test(url.pathname) ? url.href : null;
    } catch { return null; }
}
