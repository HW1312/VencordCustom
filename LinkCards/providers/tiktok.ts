/*
 * LinkCards – TikTok: videos (views, likes, comments, shares) and profiles (followers) via tikwm,
 * falls back to TikTok's oEmbed (title + author only)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ICONS } from "../icons";
import { api } from "../net";
import { CardView, formatCompact, formatNumber, hostIs, HttpError, NotFoundError, Provider, segments, Stat, Target, timeAgo, truncate } from "../types";

type TikTokTarget = Target & { kind: "video" | "short" | "profile"; user?: string; videoId?: string; };

const USER = /^[\w.]{2,24}$/;

function match(url: URL): TikTokTarget | null {
    if (hostIs(url, "vm.tiktok.com", "vt.tiktok.com")) {
        // Short links can only be resolved by tikwm
        if (tikwmBlocked) return null;
        const [code] = segments(url);
        if (!code || !/^\w{5,15}$/.test(code)) return null;
        return { kind: "short", id: `short:${code}`, url: `https://${url.hostname}/${code}/` };
    }
    if (!hostIs(url, "tiktok.com", "www.tiktok.com", "m.tiktok.com")) return null;

    const parts = segments(url);
    const [at, section, videoId] = parts;
    if (!at?.startsWith("@")) return null;
    const user = at.slice(1);
    if (!USER.test(user)) return null;

    if ((section === "video" || section === "photo") && videoId && /^\d{10,25}$/.test(videoId))
        return { kind: "video", user, videoId, id: `video:${videoId}`, url: `https://www.tiktok.com/@${user}/video/${videoId}` };
    if (parts.length === 1) return { kind: "profile", user, id: `user:${user.toLowerCase()}`, url: `https://www.tiktok.com/@${user}` };
    return null;
}

type TikTokData =
    | { kind: "video"; title?: string; author?: string; handle?: string; url: string; created?: number | null; views?: number | null; likes?: number | null; comments?: number | null; shares?: number | null; limited?: boolean; }
    | { kind: "profile"; name: string; handle: string; bio?: string; verified: boolean; followers?: number; likes?: number; videos?: number; };

// tikwm allows one request per second without a key and sits behind Cloudflare,
// which may block us – then only oEmbed (no stats) is used for the rest of the session
let tikwmBlocked = false;
let queue = Promise.resolve();
function tikwm(path: string): Promise<any> {
    if (tikwmBlocked) return Promise.reject(new HttpError(403, "No access"));
    const run = queue.then(() => api(`https://www.tikwm.com/api/${path}`));
    queue = run.then(() => wait(1100), () => wait(1100));
    return run.then(res => {
        if (res?.code === 0 && res.data) return res.data;
        const msg = String(res?.msg ?? "TikTok error");
        if (/not ?found|invalid|private|removed/i.test(msg)) throw new NotFoundError();
        throw new HttpError(503, msg);
    }, e => {
        if (e instanceof HttpError && e.status === 403) tikwmBlocked = true;
        throw e;
    });
}
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const oembed = (url: string) => api(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);

async function fetchTikTok(t: TikTokTarget): Promise<TikTokData> {
    if (t.kind === "profile") {
        let d: any;
        try {
            d = await tikwm(`user/info?unique_id=${encodeURIComponent(t.user!)}`);
        } catch (e) {
            if (e instanceof NotFoundError) throw e;
            const o = await oembed(t.url);
            if (!o?.author_name) throw new NotFoundError();
            return { kind: "profile", name: o.author_name, handle: o.embed_product_id ?? t.user!, verified: false };
        }
        return {
            kind: "profile",
            name: d.user?.nickname || d.user?.uniqueId,
            handle: d.user?.uniqueId ?? t.user,
            bio: d.user?.signature,
            verified: !!d.user?.verified,
            followers: d.stats?.followerCount,
            likes: d.stats?.heartCount ?? d.stats?.heart,
            videos: d.stats?.videoCount
        };
    }

    try {
        const d = await tikwm(`?url=${encodeURIComponent(t.url)}`);
        const handle = d.author?.unique_id ?? t.user;
        return {
            kind: "video",
            title: d.title,
            author: d.author?.nickname,
            handle,
            url: handle && d.id ? `https://www.tiktok.com/@${handle}/video/${d.id}` : t.url,
            created: d.create_time ? d.create_time * 1000 : null,
            views: d.play_count,
            likes: d.digg_count,
            comments: d.comment_count,
            shares: d.share_count
        };
    } catch (e) {
        if (e instanceof NotFoundError) throw e;
        const o = await oembed(t.url);
        if (!o?.author_name) throw new NotFoundError();
        const handle = o.author_unique_id ?? t.user;
        const url = handle && o.embed_product_id ? `https://www.tiktok.com/@${handle}/video/${o.embed_product_id}` : t.url;
        return { kind: "video", title: o.title, author: o.author_name, handle, url, limited: true };
    }
}

function render(d: TikTokData): CardView {
    const base = { color: "#fe2c55", provider: "TikTok" };

    if (d.kind === "video") {
        const stats: Stat[] = [];
        const add = (icon: Stat["icon"], n: number | null | undefined, label: string) =>
            n != null && stats.push({ icon, value: formatCompact(n), title: `${formatNumber(n)} ${label}` });
        add(ICONS.eye, d.views, "views");
        add(ICONS.heart, d.likes, "likes");
        add(ICONS.comment, d.comments, "comments");
        add(ICONS.share, d.shares, "shares");

        return {
            ...base,
            context: "Video",
            icon: ICONS.play,
            title: d.author || (d.handle ? `@${d.handle}` : "TikTok video"),
            titleSuffix: d.author && d.handle ? `@${d.handle}` : undefined,
            url: d.url,
            meta: [d.created && timeAgo(d.created), d.limited && "stats unavailable"],
            description: truncate(d.title),
            stats
        };
    }

    const stats: Stat[] = [];
    if (d.followers != null) stats.push({ icon: ICONS.people, value: `${formatCompact(d.followers)} followers`, title: `${formatNumber(d.followers)} followers` });
    if (d.likes != null) stats.push({ icon: ICONS.heart, value: `${formatCompact(d.likes)} likes`, title: `${formatNumber(d.likes)} likes` });
    if (d.videos != null) stats.push({ icon: ICONS.video, value: `${formatCompact(d.videos)} videos` });

    return {
        ...base,
        context: "Profile",
        icon: ICONS.person,
        title: d.name,
        titleSuffix: `@${d.handle}`,
        url: `https://www.tiktok.com/@${d.handle}`,
        badge: d.verified ? "Verified" : undefined,
        description: truncate(d.bio),
        stats
    };
}

export const tiktok: Provider<TikTokTarget, TikTokData> = {
    id: "tiktok",
    label: "TikTok",
    hint: "Videos: views, likes, comments, shares · profiles: followers",
    ttl: 15 * 60_000,
    match,
    fetch: fetchTikTok,
    render
};
