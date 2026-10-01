/*
 * LinkCards – crates.io: latest version + date
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ICONS } from "../icons";
import { api } from "../net";
import { CardView, formatCompact, hostIs, Provider, segments, Stat, Target, timeAgo } from "../types";

type CrateTarget = Target & { name: string; };

function match(url: URL): CrateTarget | null {
    if (!hostIs(url, "crates.io", "www.crates.io")) return null;
    const [section, name] = segments(url);
    if (section !== "crates" || !name || !/^[a-z0-9][\w-]*$/i.test(name)) return null;
    return { name, id: name.toLowerCase(), url: url.href };
}

interface CrateData {
    name: string;
    version: string;
    description?: string | null;
    date?: string | null;
    downloads: number;
    recentDownloads?: number | null;
    license?: string | null;
}

async function fetchCrate(t: CrateTarget): Promise<CrateData> {
    const d = await api(`https://crates.io/api/v1/crates/${encodeURIComponent(t.name)}`);
    const c = d.crate ?? {};
    const version: string = c.max_stable_version || c.newest_version || c.max_version;
    const v = (d.versions ?? []).find((x: any) => x.num === version);
    return {
        name: c.name,
        version,
        description: c.description,
        date: v?.created_at ?? c.updated_at,
        downloads: c.downloads ?? 0,
        recentDownloads: c.recent_downloads,
        license: v?.license
    };
}

function render(d: CrateData): CardView {
    const stats: Stat[] = [
        { icon: ICONS.tag, value: `v${d.version}`, title: "Latest version" },
        { icon: ICONS.download, value: formatCompact(d.downloads), title: d.recentDownloads != null ? `Total · ${formatCompact(d.recentDownloads)} in the last 90 days` : "Total downloads" }
    ];
    if (d.license) stats.push({ icon: ICONS.scale, value: d.license, title: "License" });

    return {
        color: "#e6b34a",
        provider: "crates.io",
        context: "Crate",
        icon: ICONS.package,
        title: d.name,
        url: `https://crates.io/crates/${d.name}`,
        meta: [d.date && `published ${timeAgo(d.date)}`],
        description: d.description ?? undefined,
        stats
    };
}

export const crates: Provider<CrateTarget, CrateData> = {
    id: "crates",
    label: "crates.io",
    hint: "Latest version, date and downloads",
    ttl: 60 * 60_000,
    match,
    fetch: fetchCrate,
    render
};
