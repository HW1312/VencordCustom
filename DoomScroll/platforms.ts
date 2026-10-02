/*
 * DoomScroll – supported feeds
 * Own file (not index.tsx) because ui.tsx reads it at load time - index.tsx imports ui.tsx first.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const PLATFORMS = {
    tiktok: { name: "TikTok", url: "https://www.tiktok.com/foryou" },
    shorts: { name: "YouTube Shorts", url: "https://www.youtube.com/shorts" },
    reels: { name: "Instagram Reels", url: "https://www.instagram.com/reels/" }
} as const;

export type PlatformId = keyof typeof PLATFORMS;
