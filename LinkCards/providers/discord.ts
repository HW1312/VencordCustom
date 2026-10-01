/*
 * LinkCards – Discord invites: server name, online & member count, boosts
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ICONS } from "../icons";
import { api } from "../net";
import { CardView, formatCompact, hostIs, NotFoundError, Provider, segments, Stat, Target, timeAgo, truncate } from "../types";

type InviteTarget = Target & { code: string; };

const CODE = /^[\w-]{2,32}$/;

function match(url: URL): InviteTarget | null {
    let code: string | undefined;
    if (hostIs(url, "discord.gg", "www.discord.gg")) {
        [code] = segments(url);
    } else if (hostIs(url, "discord.com", "www.discord.com", "ptb.discord.com", "canary.discord.com", "discordapp.com", "www.discordapp.com")) {
        const [section, c] = segments(url);
        if (section === "invite") code = c;
    }
    if (!code || !CODE.test(code)) return null;
    return { code, id: code, url: url.href };
}

interface InviteData {
    code: string;
    name: string;
    isGroup: boolean;
    description?: string | null;
    channel?: string | null;
    members?: number | null;
    online?: number | null;
    boosts?: number | null;
    verified: boolean;
    partnered: boolean;
    expiresAt?: string | null;
}

async function fetchInvite(t: InviteTarget): Promise<InviteData> {
    const d = await api(`https://discord.com/api/v10/invites/${encodeURIComponent(t.code)}?with_counts=true&with_expiration=true`);
    if (!d?.code) throw new NotFoundError();
    const features: string[] = d.guild?.features ?? [];

    return {
        code: d.code,
        name: d.guild?.name ?? d.channel?.name ?? "Group DM",
        isGroup: !d.guild,
        description: d.guild?.description,
        channel: d.guild ? d.channel?.name : null,
        members: d.approximate_member_count,
        online: d.approximate_presence_count,
        boosts: d.guild?.premium_subscription_count,
        verified: features.includes("VERIFIED"),
        partnered: features.includes("PARTNERED"),
        expiresAt: d.expires_at
    };
}

function render(d: InviteData): CardView {
    const stats: Stat[] = [];
    if (d.online != null) stats.push({ dot: "#23a55a", value: `${formatCompact(d.online)} online`, title: "Members online" });
    if (d.members != null) stats.push({ icon: ICONS.people, value: `${formatCompact(d.members)} members`, title: "Members" });
    if (d.boosts) stats.push({ value: `${d.boosts} boosts`, title: "Server boosts", dot: "#ff73fa" });

    return {
        color: "#5865f2",
        provider: "Discord",
        context: d.isGroup ? "Group invite" : "Server invite",
        icon: ICONS.people,
        title: d.name,
        url: `https://discord.gg/${d.code}`,
        badge: d.verified ? "Verified" : d.partnered ? "Partner" : undefined,
        meta: [
            d.channel && `#${d.channel}`,
            d.expiresAt ? `expires ${timeAgo(d.expiresAt)}` : "never expires"
        ],
        description: truncate(d.description),
        stats
    };
}

export const discord: Provider<InviteTarget, InviteData> = {
    id: "discord",
    label: "Discord",
    hint: "Server invites: online and member count, boosts",
    ttl: 10 * 60_000,
    match,
    fetch: fetchInvite,
    render
};
