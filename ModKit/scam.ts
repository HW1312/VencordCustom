/*
 * ModKit – lightweight scam link detector: Discord/Steam lookalikes, free-Nitro bait, punycode
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// ---------------------------------------------------------------- Domains

/** Official Discord/Steam domains */
const OFFICIAL_DOMAINS = [
    "discord.com", "discord.gg", "discord.new", "discord.gift", "discord.gifts", "discordapp.com", "discordapp.net",
    "discord.media", "discordstatus.com", "discord.co", "discord.dev", "discord.design", "discord.store",
    "discordmerch.com", "dis.gd", "discord.tools", "discordsays.com", "discordcdn.com",
    "steampowered.com", "steamcommunity.com", "steamstatic.com", "steamgames.com", "steamusercontent.com",
    "steamchina.com", "steam-chat.com", "steamdeck.com", "steamserver.net", "s.team", "valvesoftware.com"
];

/** Known harmless sites with similar names */
const KNOWN_SAFE_DOMAINS = [
    ...OFFICIAL_DOMAINS,
    "discord.js.org", "discordjs.dev", "discordjs.guide", "discord-api-types.dev", "discordnet.dev", "discordpy.readthedocs.io",
    "discord.me", "disboard.org", "discordbotlist.com", "discords.com", "discordservers.com", "discordlist.gg",
    "discord.bots.gg", "discordtemplates.me", "discordhome.com", "discordlookup.com", "discohook.org", "discogs.com",
    "betterdiscord.app", "vencord.dev", "top.gg", "steamdb.info", "steamcharts.com", "steamspy.com", "steamgriddb.com",
    "steamladder.com", "steamrep.com", "steamid.io", "tenor.com", "giphy.com", "youtube.com", "youtu.be"
];

const matchesDomain = (host: string, list: string[]) => list.some(d => host === d || host.endsWith("." + d));

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;
const BRAND_RE = /discord|steamcommunity|steampowered|steamcommunlty/;
const SCAM_WORDS_RE = /nitro|gift|free|claim|airdrop|verify|login|promo|reward|drop/;
const BAIT_RE = /free\s*nitro|nitro\s*(for\s*)?free|gratis[\s-]*nitro|nitro\s*gratis|steam\s*gift|\$\s?\d+\s*(steam|gift)|airdrop|nitro\s*(giveaway|drop)/i;

const LOOKALIKE_TARGETS: [string, number][] = [["discord", 1], ["discordapp", 2], ["steamcommunity", 2], ["steampowered", 2]];

// ---------------------------------------------------------------- Helpers

/** Edit distance; swapped adjacent letters count as 1 error */
function editDistance(a: string, b: string) {
    const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
                d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
    }
    return d[a.length][b.length];
}

/** Translate substitute characters back (d1sc0rd, dlscord, discorcl, stearn …) */
function skeleton(s: string) {
    return s
        .replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d")
        .replace(/0/g, "o").replace(/1/g, "l").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t")
        .replace(/[^a-z]/g, "");
}

/** Additionally "l" -> "i" (dlscord, steamcommunlty) */
const skeletonI = (s: string) => skeleton(s).replace(/l/g, "i");

// ---------------------------------------------------------------- Detection

export interface ScamHit {
    host: string;
    reason: string;
}

function analyzeHost(host: string): string | null {
    if (matchesDomain(host, KNOWN_SAFE_DOMAINS)) return null;

    if (host.split(".").some(l => l.startsWith("xn--")))
        return "Punycode domain (special characters that look like regular letters)";

    if (BRAND_RE.test(skeleton(host)) && SCAM_WORDS_RE.test(host))
        return "Impersonates Discord/Steam (Nitro/gift/login ...)";

    // Brand name as main domain on a foreign TLD (steamcommunity.ru, discord.xyz)
    const labels = host.split(".");
    const sld = labels.length >= 2 ? labels[labels.length - 2] : "";
    if (LOOKALIKE_TARGETS.some(([t]) => t === sld))
        return `Official name "${sld}" on a foreign domain`;

    for (const label of host.split(/[.-]/)) {
        if (label.length < 5) continue;
        const variants = [skeleton(label), skeletonI(label)];
        for (const [target, maxDist] of LOOKALIKE_TARGETS) {
            const targetI = target.replace(/l/g, "i");
            if (label === target) continue;
            if (variants.some(v => v === target || v === targetI || (Math.abs(v.length - target.length) <= maxDist && editDistance(v, target) <= maxDist)))
                return `Imitation of "${target}"`;
        }
    }
    return null;
}

const cache = new Map<string, ScamHit | null>();

/** Checks text + embeds of a message. The result is cached per message/version. */
export function detectScam(message: any): ScamHit | null {
    const content: string = message?.content ?? "";
    const embedUrls: string[] = (message?.embeds ?? []).map((e: any) => e?.url).filter(Boolean);
    if (!content && !embedUrls.length) return null;

    const key = `${message.id}:${content.length}:${content.slice(0, 64)}:${embedUrls.length}`;
    if (cache.has(key)) return cache.get(key)!;

    const hit = analyze(content, embedUrls);
    if (cache.size > 2000) cache.clear();
    cache.set(key, hit);
    return hit;
}

function analyze(content: string, embedUrls: string[]): ScamHit | null {
    const urls = [...(content.match(URL_RE) ?? []), ...embedUrls];
    const hosts: string[] = [];
    for (const u of urls) {
        try {
            hosts.push(new URL(u).hostname.toLowerCase().replace(/\.$/, ""));
        } catch { }
    }

    for (const host of hosts) {
        const reason = analyzeHost(host);
        if (reason) return { host, reason };
    }

    // Classic bait text + any non-official link
    const external = hosts.find(h => !matchesDomain(h, OFFICIAL_DOMAINS));
    if (external && BAIT_RE.test(content))
        return { host: external, reason: "Typical \"Free Nitro\"/gift bait with a link" };

    return null;
}

export function clearScamCache() {
    cache.clear();
}
