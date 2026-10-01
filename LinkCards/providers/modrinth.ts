/*
 * LinkCards – Modrinth: Minecraft mods, plugins, modpacks, ... (downloads, followers, versions)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ICONS } from "../icons";
import { api } from "../net";
import { CardView, formatCompact, formatNumber, hostIs, Provider, segments, Stat, Target, timeAgo } from "../types";

type ProjectTarget = Target & { slug: string; };

const TYPES = new Set(["mod", "plugin", "resourcepack", "datapack", "shader", "modpack", "project"]);

function match(url: URL): ProjectTarget | null {
    if (!hostIs(url, "modrinth.com", "www.modrinth.com")) return null;
    const [type, slug] = segments(url);
    if (!TYPES.has(type) || !slug || !/^[\w!@$()`.+,"\-']{3,64}$/.test(slug)) return null;
    return { slug, id: slug.toLowerCase(), url: url.href };
}

interface ProjectData {
    slug: string;
    title: string;
    type: string;
    description?: string | null;
    downloads: number;
    followers: number;
    updated?: string | null;
    gameVersion?: string | null;
    loaders: string[];
    license?: string | null;
}

async function fetchProject(t: ProjectTarget): Promise<ProjectData> {
    const d = await api(`https://api.modrinth.com/v2/project/${encodeURIComponent(t.slug)}`);
    const versions: string[] = d.game_versions ?? [];
    return {
        slug: d.slug,
        title: d.title,
        type: d.project_type,
        description: d.description,
        downloads: d.downloads ?? 0,
        followers: d.followers ?? 0,
        updated: d.updated,
        gameVersion: versions[versions.length - 1],
        loaders: d.loaders ?? [],
        license: d.license?.id
    };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function render(d: ProjectData): CardView {
    const stats: Stat[] = [
        { icon: ICONS.download, value: formatCompact(d.downloads), title: `${formatNumber(d.downloads)} downloads` },
        { icon: ICONS.heart, value: formatCompact(d.followers), title: `${formatNumber(d.followers)} followers` }
    ];
    if (d.gameVersion) stats.push({ icon: ICONS.tag, value: d.gameVersion, title: "Newest supported Minecraft version" });
    if (d.license) stats.push({ icon: ICONS.scale, value: d.license, title: "License" });

    return {
        color: "#1bd96a",
        provider: "Modrinth",
        context: cap(d.type ?? "Project"),
        icon: ICONS.package,
        title: d.title,
        url: `https://modrinth.com/${d.type ?? "project"}/${d.slug}`,
        meta: [d.loaders.map(cap).join(", "), d.updated && `updated ${timeAgo(d.updated)}`],
        description: d.description ?? undefined,
        stats
    };
}

export const modrinth: Provider<ProjectTarget, ProjectData> = {
    id: "modrinth",
    label: "Modrinth",
    hint: "Minecraft mods, plugins, modpacks: downloads, followers, versions",
    ttl: 60 * 60_000,
    match,
    fetch: fetchProject,
    render
};
