/*
 * LinkCards – Reddit: posts (score, comments), subreddits (members), users (karma)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ICONS } from "../icons";
import { api } from "../net";
import { CardView, formatCompact, formatNumber, hostIs, HttpError, NotFoundError, Provider, segments, Stat, Target, timeAgo, truncate } from "../types";

type RedditTarget = Target & { kind: "post" | "sub" | "user"; name: string; };

const POST_ID = /^[a-z0-9]{4,10}$/i;
const NAME = /^[\w-]{2,30}$/;

function match(url: URL): RedditTarget | null {
    const make = (kind: RedditTarget["kind"], name: string): RedditTarget | null =>
        (kind === "post" ? POST_ID : NAME).test(name) ? { kind, name, id: `${kind}:${name.toLowerCase()}`, url: url.href } : null;

    if (hostIs(url, "redd.it")) {
        const [id] = segments(url);
        return id ? make("post", id) : null;
    }
    if (!hostIs(url, "reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com", "np.reddit.com", "m.reddit.com", "sh.reddit.com")) return null;

    const parts = segments(url);
    const [a, b, c, d] = parts;

    if (a === "comments" && b) return make("post", b);
    if (a === "r" && b) {
        if (c === "comments" && d) return make("post", d);
        if (parts.length === 2) return make("sub", b);
        return null;
    }
    if ((a === "user" || a === "u") && b && (parts.length === 2 || c === "submitted" || c === "comments")) return make("user", b);
    return null;
}

type RedditData =
    | { kind: "post"; title: string; sub?: string; author: string; score?: number; ratio?: number; comments?: number; created?: number; text?: string; nsfw: boolean; spoiler: boolean; locked: boolean; removed: boolean; flair?: string | null; permalink: string; limited?: boolean; }
    | { kind: "sub"; name: string; title?: string; description?: string; members?: number | null; online?: number | null; created?: number; nsfw: boolean; }
    | { kind: "user"; name: string; karma?: number; postKarma?: number; commentKarma?: number; created?: number; suspended: boolean; };

async function fetchReddit(t: RedditTarget): Promise<RedditData> {
    if (t.kind === "post") {
        let d: any;
        try {
            d = await api(`https://www.reddit.com/by_id/t3_${t.name}.json?raw_json=1`);
        } catch (e) {
            // Reddit often blocks the JSON API without login – oEmbed still works (title + author only)
            if (e instanceof HttpError && e.status === 403) return fetchOembed(t);
            throw e;
        }
        const p = d?.data?.children?.[0]?.data;
        if (!p) throw new NotFoundError();
        return {
            kind: "post",
            title: p.title,
            sub: p.subreddit_name_prefixed,
            author: p.author,
            score: p.score,
            ratio: p.upvote_ratio,
            comments: p.num_comments,
            created: p.created_utc * 1000,
            text: p.selftext,
            nsfw: !!p.over_18,
            spoiler: !!p.spoiler,
            locked: !!p.locked,
            removed: !!p.removed_by_category,
            flair: p.link_flair_text,
            permalink: `https://www.reddit.com${p.permalink}`
        };
    }

    if (t.kind === "sub") {
        const d = await api(`https://www.reddit.com/r/${encodeURIComponent(t.name)}/about.json?raw_json=1`);
        const s = d?.kind === "t5" ? d.data : null;
        if (!s) throw new NotFoundError();
        return {
            kind: "sub",
            name: s.display_name_prefixed ?? `r/${s.display_name}`,
            title: s.title,
            description: s.public_description,
            members: s.subscribers,
            online: s.active_user_count ?? s.accounts_active,
            created: s.created_utc ? s.created_utc * 1000 : undefined,
            nsfw: !!s.over18
        };
    }

    const d = await api(`https://www.reddit.com/user/${encodeURIComponent(t.name)}/about.json?raw_json=1`);
    const u = d?.kind === "t2" ? d.data : null;
    if (!u) throw new NotFoundError();
    return {
        kind: "user",
        name: u.name,
        karma: u.total_karma,
        postKarma: u.link_karma,
        commentKarma: u.comment_karma,
        created: u.created_utc ? u.created_utc * 1000 : undefined,
        suspended: !!u.is_suspended
    };
}

async function fetchOembed(t: RedditTarget): Promise<RedditData> {
    const o = await api(`https://www.reddit.com/oembed?url=${encodeURIComponent(`https://www.reddit.com/comments/${t.name}/`)}`);
    if (!o?.title) throw new NotFoundError();
    const link = /href="(https:\/\/www\.reddit\.com\/r\/(\w+)\/comments\/[^"?]+)/.exec(o.html ?? "");
    return {
        kind: "post",
        title: o.title,
        sub: link ? `r/${link[2]}` : undefined,
        author: o.author_name,
        nsfw: false,
        spoiler: false,
        locked: false,
        removed: false,
        permalink: link?.[1] ?? `https://www.reddit.com/comments/${t.name}/`,
        limited: true
    };
}

function render(d: RedditData): CardView {
    const base = { color: "#ff4500", provider: "Reddit" };

    if (d.kind === "post") {
        const stats: Stat[] = [];
        if (d.score != null) stats.push({ icon: ICONS.upvote, value: formatCompact(d.score), title: `${formatNumber(d.score)} points` });
        if (d.comments != null) stats.push({ icon: ICONS.comment, value: formatCompact(d.comments), title: `${formatNumber(d.comments)} comments` });
        if (d.ratio != null) stats.push({ value: `${Math.round(d.ratio * 100)}% upvoted` });

        return {
            ...base,
            context: d.sub ?? "Post",
            icon: ICONS.comment,
            title: d.title,
            url: d.permalink,
            badge: d.removed ? "Removed" : d.nsfw ? "NSFW" : d.spoiler ? "Spoiler" : d.locked ? "Locked" : undefined,
            meta: [`u/${d.author}`, d.created && timeAgo(d.created), d.flair, d.limited && "stats blocked by Reddit"],
            // Do not show the text of NSFW / spoiler posts
            description: d.nsfw || d.spoiler ? undefined : truncate(d.text),
            stats
        };
    }

    if (d.kind === "sub") {
        const stats: Stat[] = [];
        if (d.members != null) stats.push({ icon: ICONS.people, value: `${formatCompact(d.members)} members`, title: `${formatNumber(d.members)} members` });
        if (d.online != null) stats.push({ dot: "#46d160", value: `${formatCompact(d.online)} online` });

        return {
            ...base,
            context: "Community",
            icon: ICONS.people,
            title: d.name,
            url: `https://www.reddit.com/${d.name}/`,
            badge: d.nsfw ? "NSFW" : undefined,
            meta: [d.title, d.created && `created ${new Date(d.created).getFullYear()}`],
            description: truncate(d.description),
            stats
        };
    }

    return {
        ...base,
        context: "User",
        icon: ICONS.person,
        title: `u/${d.name}`,
        url: `https://www.reddit.com/user/${d.name}/`,
        badge: d.suspended ? "Suspended" : undefined,
        meta: [d.created && `joined ${timeAgo(d.created)}`],
        stats: d.karma != null
            ? [{ icon: ICONS.upvote, value: `${formatCompact(d.karma)} karma`, title: `${formatNumber(d.postKarma)} post · ${formatNumber(d.commentKarma)} comment karma` }]
            : []
    };
}

export const reddit: Provider<RedditTarget, RedditData> = {
    id: "reddit",
    label: "Reddit",
    hint: "Posts: score and comments · subreddits: members · users: karma",
    ttl: 10 * 60_000,
    match,
    fetch: fetchReddit,
    render
};
