/*
 * LinkCards – npm: latest version, publish date, weekly downloads
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ICONS } from "../icons";
import { api } from "../net";
import { CardView, formatCompact, hostIs, Provider, segments, Stat, Target, timeAgo } from "../types";

type NpmTarget = Target & { name: string; };

const PART = /^[a-z0-9][\w.-]*$/i;

function match(url: URL): NpmTarget | null {
    if (!hostIs(url, "npmjs.com", "www.npmjs.com")) return null;
    const [section, a, b] = segments(url);
    if (section !== "package" || !a) return null;

    const name = a.startsWith("@") ? b && `${a}/${b}` : a;
    if (!name) return null;
    if (a.startsWith("@") ? !PART.test(a.slice(1)) || !PART.test(b!) : !PART.test(a)) return null;

    return { name, id: name.toLowerCase(), url: url.href };
}

interface NpmData {
    name: string;
    version: string;
    description?: string;
    license?: string;
    date?: string | null;
    downloads?: number | null;
    deprecated?: string | null;
}

const encodeName = (name: string) => name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);

async function fetchNpm(t: NpmTarget): Promise<NpmData> {
    const [latest, downloads, search] = await Promise.all([
        api(`https://registry.npmjs.org/${encodeName(t.name)}/latest`),
        api(`https://api.npmjs.org/downloads/point/last-week/${t.name}`, true).catch(() => null),
        // The search returns the publish date without the (sometimes huge) package document
        api(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(t.name)}&size=5`).catch(() => null)
    ]);

    const hit = (search?.objects ?? []).find((o: any) => o.package?.name === latest.name)?.package;

    return {
        name: latest.name,
        version: latest.version,
        description: latest.description,
        license: typeof latest.license === "string" ? latest.license : latest.license?.type,
        date: hit?.version === latest.version ? hit.date : null,
        downloads: downloads?.downloads ?? null,
        deprecated: typeof latest.deprecated === "string" ? latest.deprecated : null
    };
}

function render(d: NpmData): CardView {
    const stats: Stat[] = [{ icon: ICONS.tag, value: `v${d.version}`, title: "Latest version" }];
    if (d.downloads != null) stats.push({ icon: ICONS.download, value: `${formatCompact(d.downloads)} / week`, title: "Downloads last week" });
    if (d.license) stats.push({ icon: ICONS.scale, value: d.license, title: "License" });

    return {
        color: d.deprecated ? "#bf8700" : "#cb3837",
        provider: "npm",
        context: "Package",
        icon: ICONS.package,
        title: d.name,
        url: `https://www.npmjs.com/package/${d.name}`,
        badge: d.deprecated ? "Deprecated" : undefined,
        meta: [d.date && `published ${timeAgo(d.date)}`],
        description: d.deprecated || d.description,
        stats
    };
}

export const npm: Provider<NpmTarget, NpmData> = {
    id: "npm",
    label: "npm",
    hint: "Latest version, date and weekly downloads",
    ttl: 60 * 60_000,
    match,
    fetch: fetchNpm,
    render
};
