/*
 * LinkCards – Bluesky: posts (likes, reposts, replies) and profiles (followers)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ICONS } from "../icons";
import { api } from "../net";
import { CardView, formatCompact, formatNumber, hostIs, NotFoundError, Provider, segments, Stat, Target, timeAgo, truncate } from "../types";

type BskyTarget = Target & { kind: "post" | "profile"; actor: string; rkey?: string; };

const ACTOR = /^(did:[a-z]+:[\w.:%-]+|[a-z0-9.-]{3,253})$/i;
const RKEY = /^[\w.~:-]{1,512}$/;

function match(url: URL): BskyTarget | null {
    if (!hostIs(url, "bsky.app", "www.bsky.app")) return null;
    const parts = segments(url);
    const [section, actor, post, rkey] = parts;
    if (section !== "profile" || !actor || !ACTOR.test(actor)) return null;

    if (post === "post" && rkey && RKEY.test(rkey)) return { kind: "post", actor, rkey, id: `post:${actor.toLowerCase()}/${rkey}`, url: url.href };
    if (parts.length === 2) return { kind: "profile", actor, id: `user:${actor.toLowerCase()}`, url: url.href };
    return null;
}

type BskyData =
    | { kind: "post"; author: string; handle: string; text: string; created?: string; likes?: number; reposts?: number; replies?: number; quotes?: number; }
    | { kind: "profile"; name: string; handle: string; bio?: string; followers?: number; follows?: number; posts?: number; };

const XRPC = "https://public.api.bsky.app/xrpc/";

async function fetchBsky(t: BskyTarget): Promise<BskyData> {
    if (t.kind === "post") {
        const uri = `at://${t.actor}/app.bsky.feed.post/${t.rkey}`;
        const d = await api(`${XRPC}app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0&parentHeight=0`)
            .catch(e => Promise.reject(e?.status === 400 ? new NotFoundError() : e));
        const p = d?.thread?.post;
        if (!p) throw new NotFoundError();
        return {
            kind: "post",
            author: p.author?.displayName || p.author?.handle,
            handle: p.author?.handle,
            text: p.record?.text ?? "",
            created: p.record?.createdAt,
            likes: p.likeCount,
            reposts: p.repostCount,
            replies: p.replyCount,
            quotes: p.quoteCount
        };
    }

    const p = await api(`${XRPC}app.bsky.actor.getProfile?actor=${encodeURIComponent(t.actor)}`)
        .catch(e => Promise.reject(e?.status === 400 ? new NotFoundError() : e));
    if (!p?.handle) throw new NotFoundError();
    return {
        kind: "profile",
        name: p.displayName || p.handle,
        handle: p.handle,
        bio: p.description,
        followers: p.followersCount,
        follows: p.followsCount,
        posts: p.postsCount
    };
}

function render(d: BskyData, t: BskyTarget): CardView {
    const base = { color: "#0085ff", provider: "Bluesky" };
    const stats: Stat[] = [];
    const add = (icon: Stat["icon"], n: number | null | undefined, label: string, withLabel = false) =>
        n != null && stats.push({ icon, value: withLabel ? `${formatCompact(n)} ${label}` : formatCompact(n), title: `${formatNumber(n)} ${label}` });

    if (d.kind === "post") {
        add(ICONS.comment, d.replies, "replies");
        add(ICONS.repost, (d.reposts ?? 0) + (d.quotes ?? 0), "reposts & quotes");
        add(ICONS.heart, d.likes, "likes");
        return {
            ...base,
            context: "Post",
            icon: ICONS.comment,
            title: d.author,
            titleSuffix: `@${d.handle}`,
            url: `https://bsky.app/profile/${d.handle}/post/${t.rkey}`,
            meta: [d.created && timeAgo(d.created)],
            description: truncate(d.text) || undefined,
            stats
        };
    }

    add(ICONS.people, d.followers, "followers", true);
    add(undefined, d.follows, "following", true);
    add(ICONS.comment, d.posts, "posts", true);
    return {
        ...base,
        context: "Profile",
        icon: ICONS.person,
        title: d.name,
        titleSuffix: `@${d.handle}`,
        url: `https://bsky.app/profile/${d.handle}`,
        description: truncate(d.bio),
        stats
    };
}

export const bluesky: Provider<BskyTarget, BskyData> = {
    id: "bluesky",
    label: "Bluesky",
    hint: "Posts: likes, reposts, replies · profiles: followers",
    ttl: 10 * 60_000,
    match,
    fetch: fetchBsky,
    render
};
