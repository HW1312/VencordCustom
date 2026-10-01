/*
 * LinkCards – Steam-Store: price, discount, reviews (store.steampowered.com)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ICONS } from "../icons";
import { settings } from "../index";
import { api } from "../net";
import { CardView, formatNumber, hostIs, NotFoundError, Provider, segments, Stat, Target } from "../types";

type SteamTarget = Target & { appId: string; cc: string; };

export const steamCountry = () => {
    const cc = settings.store.steamCountry?.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(cc ?? "") ? cc! : "DE";
};

function match(url: URL): SteamTarget | null {
    if (!hostIs(url, "store.steampowered.com")) return null;
    const [section, appId] = segments(url);
    if (section !== "app" || !appId || !/^\d{1,10}$/.test(appId)) return null;
    const cc = steamCountry();
    return { appId, cc, id: `${appId}:${cc}`, url: url.href };
}

interface SteamData {
    name: string;
    url: string;
    free: boolean;
    price?: { final: string; initial: string; discount: number; } | null;
    comingSoon: boolean;
    releaseDate?: string;
    developer?: string;
    review?: { desc: string; score: number; positive: number; total: number; } | null;
}

async function fetchSteam(t: SteamTarget): Promise<SteamData> {
    const [details, reviews] = await Promise.all([
        api(`https://store.steampowered.com/api/appdetails?appids=${t.appId}&cc=${t.cc}&l=english`),
        api(`https://store.steampowered.com/appreviews/${t.appId}?json=1&language=all&purchase_type=all&num_per_page=0&filter=summary`).catch(() => null)
    ]);

    const entry = details?.[t.appId];
    if (!entry?.success || !entry.data) throw new NotFoundError();
    const d = entry.data;
    const p = d.price_overview;
    const q = reviews?.query_summary;

    return {
        name: d.name,
        url: `https://store.steampowered.com/app/${t.appId}/`,
        free: !!d.is_free,
        price: p ? { final: p.final_formatted, initial: p.initial_formatted, discount: p.discount_percent ?? 0 } : null,
        comingSoon: !!d.release_date?.coming_soon,
        releaseDate: d.release_date?.date,
        developer: d.developers?.[0],
        review: q && q.total_reviews > 0
            ? { desc: q.review_score_desc, score: q.review_score, positive: q.total_positive, total: q.total_reviews }
            : null
    };
}

// ---------------------------------------------------------------- Rendering

const REVIEW_LABELS: Record<string, string> = {
    "Overwhelmingly Positive": "Overwhelmingly Positive",
    "Very Positive": "Very Positive",
    "Positive": "Positive",
    "Mostly Positive": "Mostly Positive",
    "Mixed": "Mixed",
    "Mostly Negative": "Mostly Negative",
    "Negative": "Negative",
    "Very Negative": "Very Negative",
    "Overwhelmingly Negative": "Overwhelmingly Negative"
};

function render(d: SteamData, t: SteamTarget): CardView {
    const stats: Stat[] = [];
    if (d.review) {
        const pct = Math.round(d.review.positive / d.review.total * 100);
        stats.push({
            icon: ICONS.thumb,
            value: `${REVIEW_LABELS[d.review.desc] ?? d.review.desc} · ${pct}%`,
            title: `${formatNumber(d.review.total)} Reviews`
        });
    }

    const discount = d.price?.discount ?? 0;
    let price: CardView["price"];
    if (d.price) price = { final: d.price.final, initial: discount > 0 ? d.price.initial : undefined, discount: discount || undefined };
    else if (d.free) price = { final: "Free" };

    return {
        color: discount > 0 ? "#5c7e10" : "#1a9fff",
        provider: "Steam",
        context: `Store · ${t.cc}`,
        icon: ICONS.game,
        title: d.name,
        url: d.url,
        badge: discount > 0 ? "On sale" : d.comingSoon ? "Coming soon" : undefined,
        meta: [
            d.developer,
            d.releaseDate && (d.comingSoon ? `releases ${d.releaseDate}` : `released ${d.releaseDate}`),
            !d.price && !d.free && !d.comingSoon && "not for sale"
        ],
        price,
        stats
    };
}

export const steam: Provider<SteamTarget, SteamData> = {
    id: "steam",
    label: "Steam",
    hint: "Price, discount and reviews from store pages",
    ttl: 30 * 60_000,
    match,
    fetch: fetchSteam,
    render
};
