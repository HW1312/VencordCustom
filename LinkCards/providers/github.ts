/*
 * LinkCards – GitHub: Issues, pull requests, repositories, releases (api.github.com)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ICONS } from "../icons";
import { api } from "../net";
import { CardView, formatCompact, hostIs, Provider, segments, Stat, Target, timeAgo } from "../types";

// ---------------------------------------------------------------- Detection

type GitHubTarget = Target & (
    | { kind: "repo"; owner: string; repo: string; }
    | { kind: "issue" | "pull"; owner: string; repo: string; number: number; }
    | { kind: "release"; owner: string; repo: string; tag: string | null; }
);

/** First path segments that are not users/organizations */
const RESERVED = new Set([
    "about", "apps", "blog", "collections", "contact", "customer-stories", "enterprise", "events", "explore",
    "features", "gist", "github", "issues", "login", "logout", "marketplace", "new", "notifications", "orgs",
    "organizations", "pricing", "pulls", "readme", "search", "security", "settings", "site", "sponsors",
    "team", "topics", "trending", "users"
]);

const NAME = /^[\w.-]+$/;

function match(url: URL): GitHubTarget | null {
    if (!hostIs(url, "github.com", "www.github.com")) return null;
    const [owner, rawRepo, section, a, b] = segments(url);
    if (!owner || !rawRepo || RESERVED.has(owner.toLowerCase())) return null;

    const repo = rawRepo.replace(/\.git$/, "");
    if (!NAME.test(owner) || !NAME.test(repo)) return null;

    const base = `${owner}/${repo}`.toLowerCase();

    if (!section) return { kind: "repo", owner, repo, id: base, url: url.href };

    if ((section === "issues" || section === "pull") && a && /^\d+$/.test(a)) {
        // Issues and PRs share numbering – /issues/<n> can also be a PR
        return { kind: section === "pull" ? "pull" : "issue", owner, repo, number: Number(a), id: `${base}#${a}`, url: url.href };
    }

    if (section === "releases") {
        if (a === "latest" && !b) return { kind: "release", owner, repo, tag: null, id: `${base}@latest`, url: url.href };
        if (a === "tag" && b) return { kind: "release", owner, repo, tag: b, id: `${base}@${b}`, url: url.href };
    }

    return null;
}

// ---------------------------------------------------------------- Loading

interface Label { name: string; color: string; }

interface IssueData {
    type: "issue" | "pull";
    number: number;
    title: string;
    state: "open" | "closed";
    stateReason?: string | null;
    draft?: boolean;
    merged?: boolean;
    author?: string;
    labels: Label[];
    comments: number;
    updatedAt: string;
    url: string;
    additions?: number;
    deletions?: number;
}

interface RepoData {
    type: "repo";
    fullName: string;
    description?: string | null;
    stars: number;
    forks: number;
    language?: string | null;
    openIssues: number;
    archived: boolean;
    pushedAt?: string;
    url: string;
    release?: { tag: string; publishedAt?: string; } | null;
}

interface ReleaseData {
    type: "release";
    tag: string;
    name?: string | null;
    author?: string;
    publishedAt?: string;
    prerelease: boolean;
    downloads: number;
    url: string;
}

type GitHubData = IssueData | RepoData | ReleaseData;

const repoPath = (t: { owner: string; repo: string; }) => `https://api.github.com/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.repo)}`;

const mapLabels = (labels: any[] | undefined): Label[] =>
    (labels ?? []).map(l => ({ name: String(l.name ?? ""), color: /^[0-9a-f]{6}$/i.test(l.color) ? `#${l.color}` : "#8b949e" })).filter(l => l.name);

async function fetchGitHub(t: GitHubTarget): Promise<GitHubData> {
    const base = repoPath(t);

    switch (t.kind) {
        case "repo": {
            const [r, rel] = await Promise.all([
                api(base),
                api(`${base}/releases/latest`, true).catch(() => null)
            ]);
            return {
                type: "repo",
                fullName: r.full_name,
                description: r.description,
                stars: r.stargazers_count,
                forks: r.forks_count,
                language: r.language,
                openIssues: r.open_issues_count,
                archived: !!r.archived,
                pushedAt: r.pushed_at,
                url: r.html_url,
                release: rel ? { tag: rel.tag_name, publishedAt: rel.published_at } : null
            };
        }

        case "issue":
        case "pull": {
            let i = t.kind === "pull" ? null : await api(`${base}/issues/${t.number}`);
            const isPull = t.kind === "pull" || !!i?.pull_request;
            const p = isPull ? await api(`${base}/pulls/${t.number}`) : null;
            i ??= p;
            return {
                type: isPull ? "pull" : "issue",
                number: i.number,
                title: i.title,
                state: i.state,
                stateReason: i.state_reason,
                draft: !!p?.draft,
                merged: !!p?.merged || !!p?.merged_at,
                author: i.user?.login,
                labels: mapLabels(i.labels),
                comments: i.comments ?? 0,
                updatedAt: i.updated_at,
                url: i.html_url,
                additions: p?.additions,
                deletions: p?.deletions
            };
        }

        case "release": {
            const r = await api(t.tag == null ? `${base}/releases/latest` : `${base}/releases/tags/${encodeURIComponent(t.tag)}`);
            return {
                type: "release",
                tag: r.tag_name,
                name: r.name,
                author: r.author?.login,
                publishedAt: r.published_at ?? r.created_at,
                prerelease: !!r.prerelease,
                downloads: (r.assets ?? []).reduce((n: number, a: any) => n + (a.download_count ?? 0), 0),
                url: r.html_url
            };
        }
    }
}

// ---------------------------------------------------------------- Rendering

const COLORS = {
    open: "#238636",
    done: "#8250df",
    closed: "#cf222e",
    gray: "#6e7781",
    accent: "#4493f8",
    pre: "#bf8700"
};

const LANGUAGE_COLORS: Record<string, string> = {
    "TypeScript": "#3178c6", "JavaScript": "#f1e05a", "Python": "#3572a5", "Rust": "#dea584", "Go": "#00add8",
    "Java": "#b07219", "Kotlin": "#a97bff", "C": "#555555", "C++": "#f34b7d", "C#": "#178600", "Ruby": "#701516",
    "PHP": "#4f5d95", "Swift": "#f05138", "Dart": "#00b4ab", "Lua": "#000080", "Shell": "#89e051", "HTML": "#e34c26",
    "CSS": "#663399", "Vue": "#41b883", "Svelte": "#ff3e00", "Zig": "#ec915c", "Nix": "#7e7eff", "Haskell": "#5e5086",
    "Elixir": "#6e4a7e", "Scala": "#c22d40", "Jupyter Notebook": "#da5b0b"
};

function issueState(d: IssueData) {
    if (d.type === "pull") {
        if (d.merged) return { color: COLORS.done, icon: ICONS.prMerged, badge: "Merged" };
        if (d.state === "closed") return { color: COLORS.closed, icon: ICONS.prClosed, badge: "Closed" };
        if (d.draft) return { color: COLORS.gray, icon: ICONS.prDraft, badge: "Draft" };
        return { color: COLORS.open, icon: ICONS.prOpen, badge: "Open" };
    }
    if (d.state === "open") return { color: COLORS.open, icon: ICONS.issueOpen, badge: "Open" };
    if (d.stateReason === "not_planned") return { color: COLORS.gray, icon: ICONS.issueSkipped, badge: "Not planned" };
    return { color: COLORS.done, icon: ICONS.issueClosed, badge: "Completed" };
}

function render(d: GitHubData, t: GitHubTarget): CardView {
    const context = `${t.owner}/${t.repo}`;

    switch (d.type) {
        case "issue":
        case "pull": {
            const s = issueState(d);
            const stats: Stat[] = [{ icon: ICONS.comment, value: String(d.comments), title: "Comments" }];
            if (d.additions != null && d.deletions != null) stats.push({ value: `+${d.additions} −${d.deletions}`, title: "Changed lines" });
            return {
                color: s.color,
                provider: "GitHub",
                context: `${context} · ${d.type === "pull" ? "Pull Request" : "Issue"}`,
                icon: s.icon,
                title: d.title,
                titleSuffix: `#${d.number}`,
                url: d.url,
                badge: s.badge,
                meta: [d.author && `by ${d.author}`, d.updatedAt && `updated ${timeAgo(d.updatedAt)}`],
                labels: d.labels.slice(0, 6),
                stats
            };
        }

        case "repo": {
            const stats: Stat[] = [
                { icon: ICONS.star, value: formatCompact(d.stars), title: "Stars" },
                { icon: ICONS.fork, value: formatCompact(d.forks), title: "Forks" },
                { icon: ICONS.issueOpen, value: formatCompact(d.openIssues), title: "Open issues & PRs" }
            ];
            if (d.language) stats.unshift({ dot: LANGUAGE_COLORS[d.language] ?? COLORS.gray, value: d.language, title: "Language" });
            if (d.release) stats.push({ icon: ICONS.tag, value: d.release.tag, title: `Latest release${d.release.publishedAt ? ` · ${timeAgo(d.release.publishedAt)}` : ""}` });
            return {
                color: d.archived ? COLORS.pre : COLORS.accent,
                provider: "GitHub",
                context: "Repository",
                icon: ICONS.repo,
                title: d.fullName,
                url: d.url,
                badge: d.archived ? "Archived" : undefined,
                meta: [d.pushedAt && `last push ${timeAgo(d.pushedAt)}`],
                description: d.description ?? undefined,
                stats
            };
        }

        case "release":
            return {
                color: d.prerelease ? COLORS.pre : COLORS.open,
                provider: "GitHub",
                context: `${context} · Release`,
                icon: ICONS.tag,
                title: d.name || d.tag,
                titleSuffix: d.name && d.name !== d.tag ? d.tag : undefined,
                url: d.url,
                badge: d.prerelease ? "Pre-Release" : t.kind === "release" && t.tag == null ? "Latest" : undefined,
                meta: [d.author && `by ${d.author}`, d.publishedAt && `published ${timeAgo(d.publishedAt)}`],
                stats: d.downloads ? [{ icon: ICONS.download, value: formatCompact(d.downloads), title: "Downloads (all files)" }] : undefined
            };
    }
}

export const github: Provider<GitHubTarget, GitHubData> = {
    id: "github",
    label: "GitHub",
    hint: "Issues, pull requests, repositories and releases",
    ttl: 5 * 60_000,
    match,
    fetch: fetchGitHub,
    render
};
