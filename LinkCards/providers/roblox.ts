/*
 * LinkCards – Roblox experiences: players online, visits, favorites, rating
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ICONS } from "../icons";
import { api } from "../net";
import { CardView, formatCompact, formatNumber, hostIs, NotFoundError, Provider, segments, Stat, Target, timeAgo, truncate } from "../types";

type GameTarget = Target & { placeId: string; };

function match(url: URL): GameTarget | null {
    if (!hostIs(url, "roblox.com", "www.roblox.com", "web.roblox.com")) return null;
    const parts = segments(url);
    // Optional language prefix: /de/games/123
    const i = parts[0] === "games" ? 0 : parts[1] === "games" ? 1 : -1;
    const placeId = i >= 0 ? parts[i + 1] : null;
    if (!placeId || !/^\d{1,15}$/.test(placeId)) return null;
    return { placeId, id: placeId, url: url.href };
}

interface GameData {
    name: string;
    description?: string | null;
    creator?: string | null;
    creatorVerified: boolean;
    genre?: string | null;
    playing?: number | null;
    visits?: number | null;
    favorites?: number | null;
    maxPlayers?: number | null;
    updated?: string | null;
    upVotes?: number | null;
    downVotes?: number | null;
}

async function fetchGame(t: GameTarget): Promise<GameData> {
    const u = await api(`https://apis.roblox.com/universes/v1/places/${t.placeId}/universe`);
    const universeId = u?.universeId;
    if (!universeId) throw new NotFoundError();

    const [games, votes] = await Promise.all([
        api(`https://games.roblox.com/v1/games?universeIds=${universeId}`),
        api(`https://games.roblox.com/v1/games/votes?universeIds=${universeId}`).catch(() => null)
    ]);

    const g = games?.data?.[0];
    if (!g) throw new NotFoundError();
    const v = votes?.data?.[0];

    return {
        name: g.name,
        description: g.description,
        creator: g.creator?.name,
        creatorVerified: !!g.creator?.hasVerifiedBadge,
        genre: g.genre && g.genre !== "All" ? g.genre : null,
        playing: g.playing,
        visits: g.visits,
        favorites: g.favoritedCount,
        maxPlayers: g.maxPlayers,
        updated: g.updated,
        upVotes: v?.upVotes,
        downVotes: v?.downVotes
    };
}

function render(d: GameData, t: GameTarget): CardView {
    const stats: Stat[] = [];
    if (d.playing != null) stats.push({ dot: "#00b06f", value: `${formatCompact(d.playing)} playing`, title: `${formatNumber(d.playing)} players online` });
    if (d.visits != null) stats.push({ icon: ICONS.eye, value: `${formatCompact(d.visits)} visits`, title: `${formatNumber(d.visits)} visits` });
    if (d.favorites != null) stats.push({ icon: ICONS.star, value: formatCompact(d.favorites), title: `${formatNumber(d.favorites)} favorites` });
    const votes = (d.upVotes ?? 0) + (d.downVotes ?? 0);
    if (votes > 0) stats.push({ icon: ICONS.thumb, value: `${Math.round(d.upVotes! / votes * 100)}%`, title: `${formatNumber(d.upVotes)} likes · ${formatNumber(d.downVotes)} dislikes` });

    return {
        color: "#335fff",
        provider: "Roblox",
        context: "Experience",
        icon: ICONS.game,
        title: d.name,
        url: `https://www.roblox.com/games/${t.placeId}`,
        meta: [
            d.creator && `by ${d.creator}${d.creatorVerified ? " ✓" : ""}`,
            d.genre,
            d.maxPlayers && `${d.maxPlayers} per server`,
            d.updated && `updated ${timeAgo(d.updated)}`
        ],
        description: truncate(d.description, 200),
        stats
    };
}

export const roblox: Provider<GameTarget, GameData> = {
    id: "roblox",
    label: "Roblox",
    hint: "Experiences: players online, visits, favorites, rating",
    ttl: 5 * 60_000,
    match,
    fetch: fetchGame,
    render
};
