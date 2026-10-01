/*
 * LinkCards – Vencord Userplugin
 * Live status cards under messages for Discord, YouTube, Twitch, Kick, X, Reddit, TikTok, GitHub, Steam and more.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";

import { hasData, pruneCache, resetMemory } from "./cache";
import { logger, resetBackoffs } from "./net";
import { clearMatchMemo, findMatches, matchUrl } from "./providers";
import { LinkCardsAccessory, SettingsPanel } from "./ui";

// ---------------------------------------------------------------- Settings

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    github: {
        type: OptionType.BOOLEAN,
        description: "GitHub cards (issues, PRs, repos, releases)",
        default: true,
        hidden: true
    },
    steam: {
        type: OptionType.BOOLEAN,
        description: "Steam cards (price, discount, reviews)",
        default: true,
        hidden: true
    },
    npm: {
        type: OptionType.BOOLEAN,
        description: "npm cards",
        default: true,
        hidden: true
    },
    pypi: {
        type: OptionType.BOOLEAN,
        description: "PyPI cards",
        default: true,
        hidden: true
    },
    crates: {
        type: OptionType.BOOLEAN,
        description: "crates.io cards",
        default: true,
        hidden: true
    },
    discord: {
        type: OptionType.BOOLEAN,
        description: "Discord invite cards",
        default: true,
        hidden: true
    },
    youtube: {
        type: OptionType.BOOLEAN,
        description: "YouTube cards",
        default: true,
        hidden: true
    },
    twitch: {
        type: OptionType.BOOLEAN,
        description: "Twitch cards",
        default: true,
        hidden: true
    },
    kick: {
        type: OptionType.BOOLEAN,
        description: "Kick cards",
        default: true,
        hidden: true
    },
    twitter: {
        type: OptionType.BOOLEAN,
        description: "X / Twitter cards",
        default: true,
        hidden: true
    },
    reddit: {
        type: OptionType.BOOLEAN,
        description: "Reddit cards",
        default: true,
        hidden: true
    },
    tiktok: {
        type: OptionType.BOOLEAN,
        description: "TikTok cards",
        default: true,
        hidden: true
    },
    bluesky: {
        type: OptionType.BOOLEAN,
        description: "Bluesky cards",
        default: true,
        hidden: true
    },
    wikipedia: {
        type: OptionType.BOOLEAN,
        description: "Wikipedia cards",
        default: true,
        hidden: true
    },
    roblox: {
        type: OptionType.BOOLEAN,
        description: "Roblox cards",
        default: true,
        hidden: true
    },
    modrinth: {
        type: OptionType.BOOLEAN,
        description: "Modrinth cards",
        default: true,
        hidden: true
    },
    google: {
        type: OptionType.BOOLEAN,
        description: "Google cards",
        default: true,
        hidden: true
    },
    githubToken: {
        type: OptionType.STRING,
        description: "GitHub Personal Access Token (only sent to api.github.com)",
        default: "",
        hidden: true
    },
    steamCountry: {
        type: OptionType.STRING,
        description: "Steam country for prices (ISO code, e.g. US, GB, DE)",
        default: "DE",
        hidden: true
    },
    onlyVisible: {
        type: OptionType.BOOLEAN,
        description: "Only load when the card is visible",
        default: true,
        hidden: true
    },
    hideEmbeds: {
        type: OptionType.BOOLEAN,
        description: "Hide Discord's own embed for these links",
        default: false,
        hidden: true
    }
});

// ---------------------------------------------------------------- Hide original embeds

/** Only hide the embed if a card with data is shown for this exact link */
function shouldIgnoreEmbed(embed: any, message: any) {
    try {
        if (!settings.store.hideEmbeds || !embed?.url || !message?.content) return false;
        const m = matchUrl(embed.url);
        if (!m || !hasData(m.key)) return false;
        return findMatches(message.content).some(x => x.key === m.key);
    } catch (e) {
        logger.error("Error in shouldIgnoreEmbed", e);
        return false;
    }
}

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "LinkCards",
    description: "Live status cards under messages: Discord invites, YouTube/TikTok views, Twitch/Kick live status, X/Reddit/Bluesky posts, GitHub, Steam, Roblox, package versions and more – always up to date instead of a frozen embed",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Chat", "Utility"],
    dependencies: ["MessageAccessoriesAPI", "MessageUpdaterAPI"],
    settings,

    patches: [
        {
            // Same pattern as FakeNitro: skip individual embeds in renderEmbeds
            find: "}renderStickersAccessories(",
            replacement: {
                match: /(renderEmbeds\((\i)\){)(.+?embeds\.map\(\((\i),\i\)?=>{)/,
                replace: (_, rest1, message, rest2, embed) => `${rest1}const vcLinkCardsMessage=${message};${rest2}if($self.shouldIgnoreEmbed(${embed},vcLinkCardsMessage))return null;`
            }
        }
    ],

    shouldIgnoreEmbed,

    renderMessageAccessory: ({ message }) => {
        if (!message?.content || !findMatches(message.content).length) return null;
        return <LinkCardsAccessory message={message} />;
    },

    start() {
        pruneCache();
    },

    stop() {
        resetMemory();
        resetBackoffs();
        clearMatchMemo();
    }
});

