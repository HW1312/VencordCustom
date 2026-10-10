// SPDX-License-Identifier: GPL-3.0-or-later
import type { Track } from "./presence";

export function trackKey(track: Pick<Track, "title" | "artist" | "album">): string {
    return JSON.stringify([track.title, track.artist, track.album]);
}
function normalize(value: string): string {
    return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
export function safeCoverUrl(value: unknown): string | null {
    if (typeof value !== "string" || value.length > 1024) return null;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === "cdn-images.dzcdn.net"
            && !url.username && !url.password && !url.port
            && /^\/images\/cover\/[a-f0-9]{32}\//i.test(url.pathname) ? url.href : null;
    } catch { return null; }
}
// Preserve remix/version words; never guess from a similar artist or song name.
export function selectCover(track: Pick<Track, "title" | "artist" | "album" | "durationMs">, response: unknown): string | null {
    if (!response || typeof response !== "object") return null;
    const rows = (response as { data?: unknown }).data;
    if (!Array.isArray(rows)) return null;
    const artists = [track.artist, ...track.artist.split(/;| feat\.? | ft\.? /i)].map(normalize).filter(Boolean);
    const matches: { url: string; score: number }[] = [];
    for (const row of rows.slice(0, 25)) {
        if (!row || typeof row !== "object" || typeof row.title !== "string"
            || typeof row.artist?.name !== "string" || typeof row.album?.title !== "string") continue;
        if (normalize(row.title) !== normalize(track.title) || !artists.includes(normalize(row.artist.name))) continue;
        const delta = typeof row.duration === "number" && Number.isFinite(row.duration)
            ? Math.abs(row.duration * 1000 - track.durationMs) : Infinity;
        if (track.durationMs > 0 && delta > 8000) continue;
        const url = safeCoverUrl(row.album.cover_xl) || safeCoverUrl(row.album.cover_big);
        if (!url) continue;
        matches.push({ url, score: (normalize(row.album.title) === normalize(track.album) ? 100 : 0)
            - (Number.isFinite(delta) ? delta / 1000 : 0) });
    }
    return matches.sort((a, b) => b.score - a.score)[0]?.url ?? null;
}
