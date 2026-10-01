/*
 * LinkCards – Wikipedia: article summary, last edit
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ICONS } from "../icons";
import { api } from "../net";
import { CardView, Provider, segments, Target, timeAgo, truncate } from "../types";

type ArticleTarget = Target & { lang: string; title: string; };

const HOST = /^([a-z][a-z-]{1,11})(?:\.m)?\.wikipedia\.org$/;
const NAMESPACE = /^(Special|Talk|User|User talk|Wikipedia|File|Template|Help|Category|Portal|Draft|Module|MediaWiki|Spezial|Diskussion|Benutzer|Datei|Vorlage|Hilfe|Kategorie):/i;

function match(url: URL): ArticleTarget | null {
    const host = HOST.exec(url.hostname.toLowerCase());
    if (!host) return null;
    const [section, ...rest] = segments(url);
    const title = rest.join("/").replace(/_/g, " ").trim();
    if (section !== "wiki" || !title || title.length > 255 || NAMESPACE.test(title)) return null;
    const lang = host[1];
    return { lang, title, id: `${lang}:${title}`, url: url.href };
}

interface ArticleData {
    title: string;
    description?: string | null;
    extract?: string | null;
    type?: string;
    edited?: string | null;
    url: string;
}

async function fetchArticle(t: ArticleTarget): Promise<ArticleData> {
    const d = await api(`https://${t.lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.title.replace(/ /g, "_"))}`);
    return {
        title: d.title,
        description: d.description,
        extract: d.extract,
        type: d.type,
        edited: d.timestamp,
        url: d.content_urls?.desktop?.page ?? t.url
    };
}

function render(d: ArticleData, t: ArticleTarget): CardView {
    return {
        color: "#a2a9b1",
        provider: "Wikipedia",
        context: t.lang.toUpperCase(),
        icon: ICONS.doc,
        title: d.title,
        url: d.url,
        badge: d.type === "disambiguation" ? "Disambiguation" : undefined,
        meta: [d.description, d.edited && `edited ${timeAgo(d.edited)}`],
        description: truncate(d.extract)
    };
}

export const wikipedia: Provider<ArticleTarget, ArticleData> = {
    id: "wikipedia",
    label: "Wikipedia",
    hint: "Article summary and last edit, all languages",
    ttl: 6 * 60 * 60_000,
    match,
    fetch: fetchArticle,
    render
};
