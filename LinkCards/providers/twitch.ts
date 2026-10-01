/*
 * LinkCards – Twitch channels: live status, viewers, title, category, followers
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ICONS } from "../icons";
import { api } from "../net";
import { CardView, duration, formatCompact, formatNumber, hostIs, HttpError, NotFoundError, Provider, segments, Stat, Target, timeAgo } from "../types";

type ChannelTarget = Target & { login: string; };

const LOGIN = /^[a-z0-9_]{3,25}$/i;
const TABS = new Set(["about", "videos", "schedule", "clips", "home"]);
const RESERVED = new Set([
    "directory", "videos", "settings", "p", "downloads", "jobs", "search", "subscriptions", "inventory", "wallet",
    "drops", "login", "signup", "turbo", "prime", "friends", "messages", "payments", "store", "team", "moderator", "popout"
]);

function match(url: URL): ChannelTarget | null {
    if (!hostIs(url, "twitch.tv", "www.twitch.tv", "m.twitch.tv")) return null;
    const parts = segments(url);
    const [login, tab] = parts;
    if (!login || parts.length > 2 || (tab && !TABS.has(tab))) return null;
    if (!LOGIN.test(login) || RESERVED.has(login.toLowerCase())) return null;
    return { login, id: login.toLowerCase(), url: url.href };
}

interface ChannelData {
    login: string;
    name: string;
    title?: string | null;
    category?: string | null;
    followers?: number | null;
    partner: boolean;
    live: boolean;
    viewers?: number | null;
    startedAt?: string | null;
    lastLive?: string | null;
}

const QUERY = `query($login: String!) {
    user(login: $login) {
        login
        displayName
        roles { isPartner }
        followers { totalCount }
        broadcastSettings { title game { displayName } }
        stream { viewersCount createdAt game { displayName } }
        lastBroadcast { startedAt }
    }
}`;

async function fetchChannel(t: ChannelTarget): Promise<ChannelData> {
    const res = await api("https://gql.twitch.tv/gql", false, { query: QUERY, variables: { login: t.login.toLowerCase() } });
    if (res?.errors?.length && !res.data) throw new HttpError(500, res.errors[0]?.message ?? "Twitch error");
    const u = res?.data?.user;
    if (!u) throw new NotFoundError();

    return {
        login: u.login,
        name: u.displayName || u.login,
        title: u.broadcastSettings?.title,
        category: u.stream?.game?.displayName ?? u.broadcastSettings?.game?.displayName,
        followers: u.followers?.totalCount,
        partner: !!u.roles?.isPartner,
        live: !!u.stream,
        viewers: u.stream?.viewersCount,
        startedAt: u.stream?.createdAt,
        lastLive: u.lastBroadcast?.startedAt
    };
}

function render(d: ChannelData): CardView {
    const stats: Stat[] = [];
    if (d.live && d.viewers != null) stats.push({ dot: "#eb0400", value: `${formatCompact(d.viewers)} watching`, title: `${formatNumber(d.viewers)} viewers` });
    if (d.live && d.startedAt) stats.push({ icon: ICONS.clock, value: duration(d.startedAt), title: `Live since ${new Date(d.startedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` });
    if (d.followers != null) stats.push({ icon: ICONS.people, value: `${formatCompact(d.followers)} followers`, title: `${formatNumber(d.followers)} followers` });

    return {
        color: d.live ? "#eb0400" : "#9146ff",
        provider: "Twitch",
        context: d.partner ? "Partner" : "Channel",
        icon: d.live ? ICONS.live : ICONS.video,
        title: d.name,
        url: `https://www.twitch.tv/${d.login}`,
        badge: d.live ? "LIVE" : "Offline",
        meta: [d.category, !d.live && d.lastLive && `last live ${timeAgo(d.lastLive)}`],
        description: d.title ?? undefined,
        stats
    };
}

export const twitch: Provider<ChannelTarget, ChannelData> = {
    id: "twitch",
    label: "Twitch",
    hint: "Channels: live status, viewers, title, category, followers",
    ttl: 3 * 60_000,
    match,
    fetch: fetchChannel,
    render
};
