/*
 * LinkCards – Google: searches, Maps places, Docs/Sheets/Slides/Forms/Drive
 * Google has no public API without a key, so the card is built from the link alone (no request).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ICONS } from "../icons";
import { CardView, IconDef, Provider, segments, Target } from "../types";

type GoogleData =
    | { kind: "search"; query: string; type?: string | null; }
    | { kind: "maps"; place?: string | null; coords?: string | null; }
    | { kind: "file"; type: string; };

type GoogleTarget = Target & { data: GoogleData; };

const GOOGLE = /^(www\.)?google\.(com|[a-z]{2}|com?\.[a-z]{2})$/;
const MAPS = /^maps\.google\.(com|[a-z]{2}|com?\.[a-z]{2})$/;

const SEARCH_TYPES: Record<string, string> = { isch: "Images", vid: "Videos", nws: "News", shop: "Shopping", bks: "Books" };
const FILE_TYPES: Record<string, string> = {
    document: "Docs",
    spreadsheets: "Sheets",
    presentation: "Slides",
    forms: "Forms",
    drawings: "Drawings"
};

const plus = (s: string) => s.replace(/\+/g, " ");

function parse(url: URL): GoogleData | null {
    const host = url.hostname.toLowerCase();
    const parts = segments(url);

    if (host === "docs.google.com") {
        const type = FILE_TYPES[parts[0]];
        return type && parts.includes("d") ? { kind: "file", type } : null;
    }
    if (host === "drive.google.com") {
        if (parts[0] === "file" || parts[0] === "open") return { kind: "file", type: "Drive file" };
        if (parts[0] === "drive" && parts.includes("folders")) return { kind: "file", type: "Drive folder" };
        return null;
    }

    const isMaps = MAPS.test(host) || (GOOGLE.test(host) && parts[0] === "maps");
    if (isMaps) {
        const rest = MAPS.test(host) ? parts : parts.slice(1);
        const place = rest[0] === "place" || rest[0] === "search" ? rest[1] : url.searchParams.get("q");
        const coords = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(url.pathname);
        if (!place && !coords) return null;
        return {
            kind: "maps",
            place: place && !place.startsWith("@") ? plus(place) : null,
            coords: coords ? `${Number(coords[1]).toFixed(4)}, ${Number(coords[2]).toFixed(4)}` : null
        };
    }

    if (GOOGLE.test(host) && parts[0] === "search") {
        const query = url.searchParams.get("q")?.trim();
        if (!query) return null;
        return { kind: "search", query, type: SEARCH_TYPES[url.searchParams.get("tbm") ?? ""] ?? (url.searchParams.get("udm") === "2" ? "Images" : null) };
    }

    return null;
}

function match(url: URL): GoogleTarget | null {
    const data = parse(url);
    if (!data) return null;
    // Link without tracking parameters as key
    return { data, id: `${url.hostname}${url.pathname}?${url.searchParams.get("q") ?? ""}`, url: url.href };
}

function render(d: GoogleData, t: GoogleTarget): CardView {
    const view = (context: string, icon: IconDef, title: string, color: string, meta: CardView["meta"] = []): CardView =>
        ({ color, provider: "Google", context, icon, title, url: t.url, meta });

    switch (d.kind) {
        case "search":
            return view(d.type ? `${d.type} search` : "Search", ICONS.search, d.query, "#4285f4");
        case "maps":
            return view("Maps", ICONS.place, d.place ?? d.coords!, "#34a853", [d.place && d.coords]);
        case "file":
            return view(d.type, ICONS.doc, `Google ${d.type}`, d.type === "Sheets" ? "#0f9d58" : d.type === "Slides" ? "#f4b400" : "#4285f4", ["Shared file – open to view"]);
    }
}

export const google: Provider<GoogleTarget, GoogleData> = {
    id: "google",
    label: "Google",
    hint: "Searches, Maps places, Docs/Sheets/Slides/Drive (from the link, no live data)",
    static: true,
    ttl: 365 * 24 * 60 * 60_000,
    match,
    fetch: async t => t.data,
    render
};
