/*
 * LinkCards – X / Twitter: posts (likes, reposts, replies, views) and profiles (followers) via FxTwitter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ICONS } from "../icons";
import { api } from "../net";
import { CardView, formatCompact, formatNumber, hostIs, NotFoundError, Provider, segments, Stat, Target, timeAgo, truncate } from "../types";

type XTarget = Target & { kind: "post" | "profile"; user: string; postId?: string; };

const USER = /^\w{1,15}$/;
const POST_ID = /^\d{5,25}$/;
const RESERVED = new Set(["home", "explore", "search", "settings", "i", "messages", "notifications", "intent", "hashtag", "share", "compose", "login", "signup", "tos", "privacy", "jobs"]);

function match(url: URL): XTarget | null {
    if (!hostIs(url,
        "x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com", "mobile.x.com",
        "fxtwitter.com", "vxtwitter.com", "fixupx.com", "fixvx.com"
    )) return null;

    const parts = segments(url);
    // /i/web/status/123 or /i/status/123
    if (parts[0] === "i") {
        const postId = parts[parts.indexOf("status") + 1];
        if (parts.includes("status") && postId && POST_ID.test(postId)) return { kind: "post", user: "i", postId, id: `post:${postId}`, url: url.href };
        return null;
    }

    const [user, section, postId] = parts;
    if (!user || !USER.test(user) || RESERVED.has(user.toLowerCase())) return null;

    if (section === "status" && postId && POST_ID.test(postId)) return { kind: "post", user, postId, id: `post:${postId}`, url: url.href };
    if (parts.length === 1) return { kind: "profile", user, id: `user:${user.toLowerCase()}`, url: url.href };
    return null;
}

type XData =
    | { kind: "post"; author: string; handle: string; text: string; date?: number | null; likes?: number; reposts?: number; replies?: number; views?: number | null; media: number; }
    | { kind: "profile"; name: string; handle: string; bio?: string; followers?: number; following?: number; posts?: number; joined?: string | null; verified: boolean; };

async function fetchX(t: XTarget): Promise<XData> {
    if (t.kind === "post") {
        const d = await api(`https://api.fxtwitter.com/${encodeURIComponent(t.user)}/status/${t.postId}`);
        const tw = d?.tweet;
        if (!tw) throw new NotFoundError();
        return {
            kind: "post",
            author: tw.author?.name ?? tw.author?.screen_name,
            handle: tw.author?.screen_name,
            text: tw.text ?? "",
            date: tw.created_timestamp ? tw.created_timestamp * 1000 : null,
            likes: tw.likes,
            reposts: tw.retweets,
            replies: tw.replies,
            views: tw.views,
            media: (tw.media?.all ?? []).length
        };
    }

    const d = await api(`https://api.fxtwitter.com/${encodeURIComponent(t.user)}`);
    const u = d?.user;
    if (!u) throw new NotFoundError();
    return {
        kind: "profile",
        name: u.name,
        handle: u.screen_name,
        bio: u.description,
        followers: u.followers,
        following: u.following,
        posts: u.tweets,
        joined: u.joined,
        verified: !!u.verification?.verified
    };
}

const count = (icon: Stat["icon"], n: number | null | undefined, label: string): Stat[] =>
    n == null ? [] : [{ icon, value: formatCompact(n), title: `${formatNumber(n)} ${label}` }];

function render(d: XData, t: XTarget): CardView {
    if (d.kind === "post") {
        return {
            color: "#1d9bf0",
            provider: "X",
            context: "Post",
            icon: ICONS.comment,
            title: d.author,
            titleSuffix: `@${d.handle}`,
            url: `https://x.com/${d.handle}/status/${t.postId}`,
            meta: [d.date && timeAgo(d.date), d.media > 0 && `${d.media} media`],
            description: truncate(d.text) || undefined,
            stats: [
                ...count(ICONS.comment, d.replies, "replies"),
                ...count(ICONS.repost, d.reposts, "reposts"),
                ...count(ICONS.heart, d.likes, "likes"),
                ...count(ICONS.eye, d.views, "views")
            ]
        };
    }

    return {
        color: "#1d9bf0",
        provider: "X",
        context: "Profile",
        icon: ICONS.person,
        title: d.name,
        titleSuffix: `@${d.handle}`,
        url: `https://x.com/${d.handle}`,
        badge: d.verified ? "Verified" : undefined,
        meta: [d.joined && `joined ${new Date(d.joined).getFullYear() || ""}`],
        description: truncate(d.bio),
        stats: [
            ...d.followers != null ? [{ icon: ICONS.people, value: `${formatCompact(d.followers)} followers`, title: `${formatNumber(d.followers)} followers` }] : [],
            ...d.following != null ? [{ value: `${formatCompact(d.following)} following` }] : [],
            ...d.posts != null ? [{ icon: ICONS.comment, value: `${formatCompact(d.posts)} posts` }] : []
        ]
    };
}

export const twitter: Provider<XTarget, XData> = {
    id: "twitter",
    label: "X / Twitter",
    hint: "Posts: likes, reposts, replies, views · profiles: followers",
    ttl: 10 * 60_000,
    match,
    fetch: fetchX,
    render
};
