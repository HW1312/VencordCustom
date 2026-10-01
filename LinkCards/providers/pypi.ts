/*
 * LinkCards – PyPI: latest version + date
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ICONS } from "../icons";
import { api } from "../net";
import { CardView, hostIs, Provider, segments, Stat, Target, timeAgo } from "../types";

type PyPITarget = Target & { name: string; };

function match(url: URL): PyPITarget | null {
    if (!hostIs(url, "pypi.org", "www.pypi.org")) return null;
    const [section, name] = segments(url);
    if (section !== "project" || !name || !/^[a-z0-9][\w.-]*$/i.test(name)) return null;
    // PEP 503: normalize names
    const normalized = name.toLowerCase().replace(/[-_.]+/g, "-");
    return { name: normalized, id: normalized, url: url.href };
}

interface PyPIData {
    name: string;
    version: string;
    summary?: string | null;
    license?: string | null;
    date?: string | null;
    requiresPython?: string | null;
    url: string;
}

async function fetchPyPI(t: PyPITarget): Promise<PyPIData> {
    const d = await api(`https://pypi.org/pypi/${encodeURIComponent(t.name)}/json`);
    const info = d.info ?? {};
    const license = info.license_expression || (info.license && info.license.length < 40 ? info.license : null);
    return {
        name: info.name,
        version: info.version,
        summary: info.summary,
        license,
        date: d.urls?.[0]?.upload_time_iso_8601 ?? null,
        requiresPython: info.requires_python,
        url: info.package_url ?? `https://pypi.org/project/${t.name}/`
    };
}

function render(d: PyPIData): CardView {
    const stats: Stat[] = [{ icon: ICONS.tag, value: `v${d.version}`, title: "Latest version" }];
    if (d.requiresPython) stats.push({ value: `Python ${d.requiresPython}`, title: "Required Python version" });
    if (d.license) stats.push({ icon: ICONS.scale, value: d.license, title: "License" });

    return {
        color: "#3775a9",
        provider: "PyPI",
        context: "Package",
        icon: ICONS.package,
        title: d.name,
        url: d.url,
        meta: [d.date && `published ${timeAgo(d.date)}`],
        description: d.summary ?? undefined,
        stats
    };
}

export const pypi: Provider<PyPITarget, PyPIData> = {
    id: "pypi",
    label: "PyPI",
    hint: "Latest version and date",
    ttl: 60 * 60_000,
    match,
    fetch: fetchPyPI,
    render
};
