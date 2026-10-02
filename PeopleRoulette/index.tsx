/*
 * PeopleRoulette – Vencord Userplugin
 * Just for fun: press a button and get a random person from the servers you're in - see their profile and
 * jump straight into their DMs to meet someone new. Only picks people who are likely open to a chat.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import {
    ChannelStore, GuildMemberStore, PresenceStore, RelationshipStore, SnowflakeUtils, UserStore
} from "@webpack/common";

import { openRouletteModal, renderTitleBarButton, SettingsPanel } from "./ui";

const DAY = 24 * 60 * 60 * 1000;
const SEEN_MAX = 1000;

// ---------------------------------------------------------------- Settings

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    showTitleBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show icon in the title bar",
        default: true,
        hidden: true
    },
    onlyOnline: {
        type: OptionType.BOOLEAN,
        description: "Only people who are online right now",
        default: true,
        hidden: true
    },
    skipDnd: {
        type: OptionType.BOOLEAN,
        description: "Skip people on Do Not Disturb",
        default: true,
        hidden: true
    },
    skipExistingDms: {
        type: OptionType.BOOLEAN,
        description: "Skip people you already have a DM with",
        default: true,
        hidden: true
    },
    skipSeen: {
        type: OptionType.BOOLEAN,
        description: "Don't show the same person twice",
        default: true,
        hidden: true
    },
    minAccountAgeDays: {
        type: OptionType.NUMBER,
        description: "Minimum account age in days (filters out fresh spam accounts)",
        default: 30,
        hidden: true
    },
    /** Servers whose members are never picked */
    excludedGuilds: {
        type: OptionType.CUSTOM,
        default: [] as string[],
        hidden: true
    },
    /** People that were already shown (newest last) */
    seen: {
        type: OptionType.CUSTOM,
        default: [] as string[],
        hidden: true
    }
});

// ---------------------------------------------------------------- Pool

export interface Candidate {
    id: string;
    /** Shared servers where the member is loaded */
    guildIds: string[];
}

/**
 * Everyone Discord has loaded as a member of one of your servers (people from member lists, chats and
 * voice channels you've seen), minus everyone who is unlikely to want a random DM.
 * Discord doesn't reveal whether someone accepts DMs from server members, so that can't be checked upfront.
 */
export function getPool(): Candidate[] {
    const s = settings.store;
    const me = UserStore.getCurrentUser()?.id;
    const excluded = new Set(s.excludedGuilds);
    const seen = s.skipSeen ? new Set(s.seen) : null;
    const minCreated = Date.now() - s.minAccountAgeDays * DAY;

    const byUser = new Map<string, string[]>();
    const all = GuildMemberStore.getMutableAllGuildsAndMembers();
    for (const guildId in all) {
        if (excluded.has(guildId)) continue;
        for (const userId in all[guildId]) {
            const list = byUser.get(userId);
            if (list) list.push(guildId);
            else byUser.set(userId, [guildId]);
        }
    }

    const pool: Candidate[] = [];
    for (const [id, guildIds] of byUser) {
        if (id === me || seen?.has(id)) continue;

        const user = UserStore.getUser(id);
        if (!user || user.bot || user.system) continue;

        // Friends, blocked people and pending requests: any relationship at all
        if (RelationshipStore.getRelationshipType(id) !== 0) continue;
        if (s.skipExistingDms && ChannelStore.getDMFromUserId(id)) continue;

        const status = PresenceStore.getStatus(id) as string;
        if (s.onlyOnline && (!status || status === "offline" || status === "invisible")) continue;
        if (s.skipDnd && status === "dnd") continue;

        if (SnowflakeUtils.extractTimestamp(id) > minCreated) continue;
        if (guildIds.every(g => GuildMemberStore.isGuestOrLurker(g, id))) continue;

        pool.push({ id, guildIds });
    }
    return pool;
}

export function pickRandom<T>(list: T[]): T | undefined {
    return list[Math.floor(Math.random() * list.length)];
}

export function markSeen(id: string) {
    const seen = settings.store.seen.filter(x => x !== id);
    seen.push(id);
    settings.store.seen = seen.slice(-SEEN_MAX);
}

export function resetSeen() {
    settings.store.seen = [];
}

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "PeopleRoulette",
    description: "Just for fun: get a random person from your servers and jump into their DMs to meet someone new",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Fun", "Friends"],
    settings,

    patches: [
        {
            // Left side of the title bar (next to Back/Forward & Inbox): append the button at the end
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(leading:.{0,2500}?)\]\}\),title:/,
                replace: "$1,$self.renderTitleBarButton()]}),title:"
            }
        }
    ],

    renderTitleBarButton,

    toolboxActions: {
        "People Roulette": () => openRouletteModal()
    }
});
