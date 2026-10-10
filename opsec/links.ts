/*
 * OpSec – Links: strip tracking parameters & detect dangerous links
 * (IP loggers, Discord/Steam phishing lookalikes, short links, punycode, online blocklist)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// ---------------------------------------------------------------- Tracking parameters

/** Remove everywhere */
const GLOBAL_PARAMS = [
    /^utm_/, /^fbclid$/, /^gclid$/, /^gclsrc$/, /^dclid$/, /^gbraid$/, /^wbraid$/, /^msclkid$/, /^yclid$/,
    /^ttclid$/, /^twclid$/, /^li_fat_id$/, /^igshid$/, /^igsh$/, /^mc_cid$/, /^mc_eid$/, /^_hsenc$/, /^_hsmi$/,
    /^hsCtaTracking$/, /^mkt_tok$/, /^epik$/, /^vero_id$/, /^oly_enc_id$/, /^oly_anon_id$/, /^rb_clickid$/,
    /^s_cid$/, /^_openstat$/, /^wickedid$/, /^ref_src$/, /^ref_url$/, /^__twitter_impression$/, /^_ga$/, /^_gl$/
];

/** Only on specific sites (where the parameters are certainly pure tracking) */
const SITE_PARAMS: [RegExp, RegExp[]][] = [
    [/(^|\.)(youtube\.com|youtu\.be)$/, [/^si$/, /^pp$/, /^feature$/]],
    [/(^|\.)spotify\.com$/, [/^si$/, /^nd$/, /^dlsi$/, /^context$/]],
    [/(^|\.)(twitter\.com|x\.com)$/, [/^s$/, /^t$/]],
    [/(^|\.)instagram\.com$/, [/^img_index$/]],
    [/(^|\.)tiktok\.com$/, [/^_r$/, /^_t$/, /^is_from_webapp$/, /^sender_device$/, /^sender_web_id$/, /^share_/, /^tt_from$/, /^u_code$/, /^user_id$/, /^checksum$/]],
    [/(^|\.)reddit\.com$/, [/^share_id$/, /^rdt$/, /^\$deep_link$/, /^correlation_id$/, /^ref_campaign$/, /^ref_source$/, /^context$/]],
    [/(^|\.)amazon\.[a-z.]+$/, [/^pf_rd_/, /^pd_rd_/, /^ref_?$/, /^_encoding$/, /^psc$/, /^qid$/, /^sr$/, /^crid$/, /^sprefix$/, /^content-id$/, /^dib$/, /^dib_tag$/, /^linkCode$/, /^tag$/]],
    [/(^|\.)aliexpress\.[a-z.]+$/, [/^spm$/, /^scm$/, /^algo_/, /^aff_/, /^sk$/, /^gps-id$/, /^pdp_/]],
    [/(^|\.)linkedin\.com$/, [/^trk$/, /^trackingId$/, /^lipi$/, /^midToken$/, /^midSig$/, /^refId$/]],
    [/(^|\.)facebook\.com$/, [/^mibextid$/, /^rdid$/, /^sfnsn$/]]
];

const URL_REGEX = /https?:\/\/[^\s<>"'`]+/g;

/** Removes tracking parameters. Returns the unchanged URL if there is nothing to remove. */
export function cleanUrl(raw: string): string {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return raw;
    }
    if (!url.search) return raw;

    const host = url.hostname.toLowerCase();
    const siteRules = SITE_PARAMS.filter(([h]) => h.test(host)).flatMap(([, p]) => p);

    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
        if (GLOBAL_PARAMS.some(r => r.test(key)) || siteRules.some(r => r.test(key))) {
            url.searchParams.delete(key);
            changed = true;
        }
    }
    if (!changed) return raw;

    // Drop the trailing "?" if no parameters are left
    if (![...url.searchParams.keys()].length) url.search = "";
    return url.toString();
}

/** Clean all links in a text (for outgoing messages) */
export function cleanText(text: string): string {
    return text.replace(URL_REGEX, match => {
        // Trailing punctuation usually isn't part of the link
        const trail = /[).,!?:;\]]+$/.exec(match)?.[0] ?? "";
        const link = trail ? match.slice(0, -trail.length) : match;
        return cleanUrl(link) + trail;
    });
}

// ---------------------------------------------------------------- Dangerous links

/** Known IP loggers / grabbers (Grabify, IPLogger & their disguise domains) and request loggers */
export const IP_LOGGER_DOMAINS = [
    "grabify.link", "grabify.icu", "grabify.org", "grabify.world",
    "iplogger.org", "iplogger.com", "iplogger.ru", "iplogger.co", "iplogger.info", "iplogger.cn",
    "2no.co", "yip.su", "iplis.ru", "02ip.ru", "ezstat.ru", "ipgrabber.ru", "ipgraber.ru",
    "blasze.com", "blasze.tk", "ps3cfw.com", "bmwforum.co", "leancoding.co", "spottyfly.com", "stopify.co",
    "quickmessage.us", "youshouldclick.us", "joinmy.site", "crabrave.pw", "lovebird.guru", "trulove.guru",
    "dateing.club", "otherhalf.life", "shrekis.life", "datasig.io", "datauth.io", "headshot.monster",
    "gaming-at-my.best", "progaming.monster", "yourmy.monster", "screenshare.host", "imageshare.best",
    "screenshot.best", "gamingfun.me", "catsnthing.com", "catsnthings.fun", "mypic.icu", "curiouscat.club",
    "fortnitechat.site", "fortnight.space", "freegiftcards.co", "xda-developers.us", "myprivate.pics",
    "noodshare.com", "locations.quest", "sportshub.bar", "rateyour.world",
    "canarytokens.com", "canarytokens.org", "webhook.site", "requestcatcher.com", "pipedream.net",
    "iplogger.gg", "ipgrab.link", "grabify.me"
];

/** Link shorteners – the actual destination isn't visible before clicking */
export const SHORTENER_DOMAINS = [
    "bit.ly", "bitly.com", "tinyurl.com", "cutt.ly", "is.gd", "v.gd", "t.ly", "shorturl.at", "rb.gy", "tiny.cc",
    "ow.ly", "rebrand.ly", "bl.ink", "shorte.st", "adf.ly", "soo.gd", "s.id", "clck.ru", "shorturl.com",
    "t.co", "lnkd.in", "buff.ly", "qrco.de", "urlz.fr", "goo.su", "u.to", "linktr.ee"
];

/** Official Discord/Steam domains */
const OFFICIAL_DOMAINS = [
    "discord.com", "discord.gg", "discord.new", "discord.gift", "discord.gifts", "discordapp.com", "discordapp.net",
    "discord.media", "discordstatus.com", "discord.co", "discord.dev", "discord.design", "discord.store",
    "discordmerch.com", "dis.gd", "discord.tools", "discord-activities.com", "discordsays.com", "discordcdn.com",
    "steampowered.com", "steamcommunity.com", "steamstatic.com", "steamgames.com", "steamusercontent.com",
    "steamchina.com", "steam-chat.com", "steamdeck.com", "steamserver.net", "s.team", "valvesoftware.com"
];

/** Known harmless sites with "discord" or similar in the name */
const KNOWN_SAFE_DOMAINS = [
    ...OFFICIAL_DOMAINS,
    "discord.js.org", "discordjs.dev", "discordjs.guide", "discord-api-types.dev", "discordnet.dev", "discordpy.readthedocs.io",
    "discord.me", "disboard.org", "discordbotlist.com", "discords.com", "discordservers.com", "discordlist.gg",
    "discord.bots.gg", "discordtemplates.me", "discordhome.com", "discordlookup.com", "discordresources.com",
    "discohook.org", "discogs.com", "betterdiscord.app", "vencord.dev", "top.gg", "steamdb.info", "steamcharts.com",
    "steamspy.com", "steamgriddb.com", "steamladder.com", "steamrep.com", "steamid.io", "steamid.xyz"
];

const matchesDomain = (host: string, list: string[]) => list.some(d => host === d || host.endsWith("." + d));

export const isOfficialHost = (host: string) => matchesDomain(host.toLowerCase(), OFFICIAL_DOMAINS);

/** Edit distance; swapped adjacent letters count as 1 error (dicsord, discrod) */
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

/** Digits/characters commonly used as letter substitutes (d1sc0rd, stearn …) */
function skeleton(s: string) {
    return s
        .replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d")
        .replace(/0/g, "o").replace(/1/g, "l").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t")
        .replace(/[^a-z.]/g, "");
}

const LOOKALIKE_TARGETS: [string, number][] = [["discord", 1], ["discordapp", 2], ["steamcommunity", 2], ["steampowered", 2]];
const BRAND_REGEX = /discord|steamcommunity|steampowered/;
const SCAM_WORDS = /nitro|gift|free|claim|airdrop|verify|login|promo|reward/;

export type LinkRisk = "danger" | "warn" | "none";

export type LinkKind = "iplogger" | "blocklist" | "punycode" | "ip" | "brand" | "lookalike" | "shortener";

// ---------------------------------------------------------------- Online blocklist

/** Known scam/phishing domains from the online list (null = off / not loaded) */
let blocklist: Set<string> | null = null;

export function setBlocklist(domains: Set<string> | null) {
    blocklist = domains?.size ? domains : null;
}

/** Checks the domain and all parent domains (a.b.scam.com → b.scam.com → scam.com) */
export function isBlocklisted(host: string) {
    if (!blocklist) return false;
    let h = host.toLowerCase().replace(/\.$/, "");
    while (h.includes(".")) {
        if (blocklist.has(h)) return true;
        h = h.slice(h.indexOf(".") + 1);
    }
    return false;
}

export interface LinkAnalysis {
    risk: LinkRisk;
    kind?: LinkKind;
    reason?: string;
    host: string;
}

export function analyzeUrl(raw: string): LinkAnalysis {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return { risk: "none", host: "" };
    }
    const host = url.hostname.toLowerCase();

    if (matchesDomain(host, IP_LOGGER_DOMAINS))
        return { risk: "danger", kind: "iplogger", host, reason: "Known IP logger. Anyone who clicks it gives the sender their IP address, approximate location and device." };

    if (matchesDomain(host, KNOWN_SAFE_DOMAINS)) return { risk: "none", host };

    if (isBlocklisted(host))
        return { risk: "danger", kind: "blocklist", host, reason: "On the blocklist of known scam and phishing sites (fake Nitro, Steam fraud, account theft). Don't open it and never log in there." };

    if (host.split(".").some(l => l.startsWith("xn--")))
        return { risk: "danger", kind: "punycode", host, reason: "The address contains special characters that look like normal letters (punycode). A typical phishing trick." };

    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("["))
        return { risk: "warn", kind: "ip", host, reason: "Link points directly to an IP address instead of a domain." };

    const skel = skeleton(host);
    if (BRAND_REGEX.test(skel)) {
        return SCAM_WORDS.test(host)
            ? { risk: "danger", kind: "brand", host, reason: "Poses as Discord/Steam (\"Nitro\", \"Gift\", \"Login\" …) but isn't. Classic phishing for account theft." }
            : { risk: "warn", kind: "brand", host, reason: "Has \"Discord\"/\"Steam\" in its name but isn't affiliated. Never log in there with your Discord or Steam credentials." };
    }

    for (const label of host.split(/[.-]/)) {
        const l = skeleton(label);
        if (l.length < 5) continue;
        for (const [target, maxDist] of LOOKALIKE_TARGETS) {
            if (editDistance(l, target) <= maxDist)
                return { risk: "danger", kind: "lookalike", host, reason: `This domain imitates "${target}" (typosquat). Likely phishing.` };
        }
    }

    if (matchesDomain(host, SHORTENER_DOMAINS))
        return { risk: "warn", kind: "shortener", host, reason: "Short link: you only see where it really leads after clicking. May point to an IP logger or phishing." };

    return { risk: "none", host };
}

/** Marker OpSec adds to links whose domain is on the blocklist (see index.tsx) */
export const BLOCKLIST_ATTR = "data-vc-opsec-scam";

/**
 * CSS that marks dangerous links in messages red:
 * IP loggers by their address, blocklist hits via the attribute (the list is too large for plain CSS).
 */
export function buildDangerCss({ ipLoggers, blocklisted }: { ipLoggers: boolean; blocklisted: boolean; }) {
    const red = `color: var(--vc-ui-red) !important;
    text-decoration: underline wavy !important;`;
    const parts: string[] = [];

    if (ipLoggers) {
        const selectors = IP_LOGGER_DOMAINS.flatMap(d => [`a[href*="//${d}"]`, `a[href*=".${d}/"]`]);
        parts.push(`${selectors.join(",\n")} {
    ${red}
}
${selectors.map(s => s + "::before").join(",\n")} {
    content: "⚠ IP logger: ";
    font-weight: 700;
}`);
    }

    if (blocklisted) {
        parts.push(`a[${BLOCKLIST_ATTR}] {
    ${red}
}
a[${BLOCKLIST_ATTR}]::before {
    content: "⚠ Scam link: ";
    font-weight: 700;
}`);
    }

    return parts.join("\n");
}
