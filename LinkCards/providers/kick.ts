/*
 * LinkCards – Kick channels: live status, viewers, title, category, followers
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ICONS } from "../icons";
import { api } from "../net";
import { CardView, duration, formatCompact, formatNumber, hostIs, NotFoundError, Provider, segments, Stat, Target, truncate } from "../types";

type ChannelTarget = Target & { slug: string; };

const SLUG = /^[\w-]{3,25}$/;
const RESERVED = new Set([
    "categories", "browse", "following", "search", "terms-of-service", "privacy-policy", "community-guidelines",
    "dashboard", "settings", "video", "videos", "clips", "login", "signup", "category", "subscriptions", "faq"
]);

function match(url: URL): ChannelTarget | null {
    if (!hostIs(url, "kick.com", "www.kick.com")) return null;
    const parts = segments(url);
    const [slug] = parts;
    if (parts.length !== 1 || !SLUG.test(slug) || RESERVED.has(slug.toLowerCase())) return null;
    return { slug, id: slug.toLowerCase(), url: url.href };
}

interface ChannelData {
    slug: string;
    name: string;
    bio?: string | null;
    verified: boolean;
    followers?: number | null;
    live: boolean;
    title?: string | null;
    category?: string | null;
    viewers?: number | null;
    startedAt?: string | null;
}

async function fetchChannel(t: ChannelTarget): Promise<ChannelData> {
    const d = await api(`https://kick.com/api/v2/channels/${encodeURIComponent(t.slug.toLowerCase())}`);
    if (!d?.slug) throw new NotFoundError();
    const ls = d.livestream;
    const live = !!ls && ls.is_live !== false;

    return {
        slug: d.slug,
        name: d.user?.username ?? d.slug,
        bio: d.user?.bio,
        verified: !!d.verified,
        followers: d.followers_count ?? d.followersCount,
        live,
        title: live ? ls.session_title : null,
        category: live ? ls.categories?.[0]?.name : d.recent_categories?.[0]?.name,
        viewers: live ? ls.viewer_count : null,
        startedAt: live ? parseUtc(ls.start_time || ls.created_at) : null
    };
}

/** Kick sends "2024-01-01 12:00:00" without a time zone – that is UTC */
function parseUtc(raw: unknown): string | null {
    if (typeof raw !== "string" || !raw) return null;
    const iso = raw.replace(" ", "T");
    return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?$/.test(iso) ? `${iso}Z` : iso;
}

function render(d: ChannelData): CardView {
    const stats: Stat[] = [];
    if (d.live && d.viewers != null) stats.push({ dot: "#53fc18", value: `${formatCompact(d.viewers)} watching`, title: `${formatNumber(d.viewers)} viewers` });
    if (d.live && d.startedAt) stats.push({ icon: ICONS.clock, value: duration(d.startedAt), title: "Live for" });
    if (d.followers != null) stats.push({ icon: ICONS.people, value: `${formatCompact(d.followers)} followers`, title: `${formatNumber(d.followers)} followers` });

    return {
        color: d.live ? "#53fc18" : "#3a8f1e",
        provider: "Kick",
        context: d.verified ? "Verified channel" : "Channel",
        icon: d.live ? ICONS.live : ICONS.video,
        title: d.name,
        url: `https://kick.com/${d.slug}`,
        badge: d.live ? "LIVE" : "Offline",
        meta: [d.category],
        description: d.live ? d.title ?? undefined : truncate(d.bio),
        stats
    };
}

export const kick: Provider<ChannelTarget, ChannelData> = {
    id: "kick",
    label: "Kick",
    hint: "Channels: live status, viewers, title, category, followers",
    ttl: 3 * 60_000,
    match,
    fetch: fetchChannel,
    render
};
