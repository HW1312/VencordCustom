/*
 * ServerTools – FairGiveaway: load reactions, filter and draw verifiably
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FluxDispatcher, GuildMemberStore, SnowflakeUtils, UserStore } from "@webpack/common";

import { api, CancelToken, sleep } from "./queue";

export interface ReactionEmoji {
    id: string | null;
    name: string;
    animated?: boolean;
}

export interface Participant {
    id: string;
    name: string;
    username: string;
    bot: boolean;
}

export const emojiKey = (e: ReactionEmoji) => e.id ? `${e.name}:${e.id}` : e.name;

export const emojiLabel = (e: ReactionEmoji) => e.id ? `:${e.name}:` : e.name;

export function emojiUrl(e: ReactionEmoji) {
    return e.id ? `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? "gif" : "webp"}?size=48` : null;
}

// ---------------------------------------------------------------- Loading reactions

/** All users who reacted with the emoji (normal + super reactions), page by page via the queue */
export async function fetchReactors(channelId: string, messageId: string, emoji: ReactionEmoji, withBurst: boolean, opts: {
    token: CancelToken;
    onProgress(count: number): void;
    onRateLimit?(seconds: number): void;
}): Promise<Participant[]> {
    const byId = new Map<string, Participant>();
    const key = encodeURIComponent(emojiKey(emoji));

    for (const type of withBurst ? [0, 1] : [0]) {
        let after: string | undefined;
        while (true) {
            opts.token.throwIfCancelled();
            const query: Record<string, any> = { limit: 100, type };
            if (after) query.after = after;
            const page = await api<any[]>("get", {
                url: `/channels/${channelId}/messages/${messageId}/reactions/${key}`,
                query
            }, { token: opts.token, onRateLimit: opts.onRateLimit });

            if (!Array.isArray(page) || page.length === 0) break;
            for (const u of page) {
                byId.set(u.id, {
                    id: u.id,
                    name: u.global_name || u.username,
                    username: u.username,
                    bot: !!u.bot
                });
            }
            opts.onProgress(byId.size);
            if (page.length < 100) break;
            after = page[page.length - 1].id;
        }
    }
    return [...byId.values()];
}

// ---------------------------------------------------------------- Filter

export interface GiveawayFilters {
    excludeBots: boolean;
    excludeSelf: boolean;
    /** 0 = off */
    minAccountDays: number;
    /** 0 = off */
    minMemberDays: number;
    /** empty = off; participant needs at least one of the roles */
    requiredRoles: string[];
}

export interface FilterResult {
    eligible: Participant[];
    excluded: Record<string, number>;
    /** Participants without member data for whom the membership-duration filter was skipped */
    memberUnknown: number;
}

/**
 * Request missing members via the gateway (like Discord itself does, no REST requests)
 * and wait briefly until they are in the cache.
 */
export async function ensureMembers(guildId: string, userIds: string[], token?: CancelToken) {
    const missing = userIds.filter(id => !GuildMemberStore.getMember(guildId, id));
    if (!missing.length) return 0;

    for (let i = 0; i < missing.length; i += 100) {
        FluxDispatcher.dispatch({
            type: "GUILD_MEMBERS_REQUEST",
            guildIds: [guildId],
            userIds: missing.slice(i, i + 100)
        });
    }

    const deadline = Date.now() + Math.min(8000, 2000 + missing.length * 10);
    while (Date.now() < deadline) {
        await sleep(300, token);
        if (missing.every(id => GuildMemberStore.getMember(guildId, id))) break;
    }
    return missing.filter(id => !GuildMemberStore.getMember(guildId, id)).length;
}

export function applyFilters(participants: Participant[], guildId: string | null, f: GiveawayFilters): FilterResult {
    const me = UserStore.getCurrentUser()?.id;
    const now = Date.now();
    const excluded: Record<string, number> = {};
    let memberUnknown = 0;
    const out = (reason: string) => {
        excluded[reason] = (excluded[reason] ?? 0) + 1;
        return false;
    };

    const eligible = participants.filter(p => {
        if (f.excludeBots && p.bot) return out("Bots");
        if (f.excludeSelf && p.id === me) return out("You");
        if (f.minAccountDays > 0) {
            const age = (now - SnowflakeUtils.extractTimestamp(p.id)) / 86400_000;
            if (age < f.minAccountDays) return out(`Account younger than ${f.minAccountDays} days`);
        }
        if (guildId && (f.minMemberDays > 0 || f.requiredRoles.length)) {
            const member: any = GuildMemberStore.getMember(guildId, p.id);
            if (f.requiredRoles.length) {
                if (!member) return out("Not (or no longer) in the server");
                if (!f.requiredRoles.some(r => member.roles?.includes(r))) return out("Missing required role");
            }
            if (f.minMemberDays > 0) {
                const joined = member?.joinedAt ? Date.parse(member.joinedAt) : NaN;
                if (Number.isNaN(joined)) memberUnknown++;
                else if ((now - joined) / 86400_000 < f.minMemberDays) return out(`In the server for less than ${f.minMemberDays} days`);
            }
        }
        return true;
    });

    return { eligible, excluded, memberUnknown };
}

// ---------------------------------------------------------------- Verifiable draw

async function sha256(text: string): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(text: string) {
    return toHex(await sha256(text));
}

/** Numbers from SHA-256(seed + ":" + k), k = 0, 1, 2 ...; per block 8 x 32 bits (big-endian) */
class HashRng {
    private buffer: number[] = [];
    private counter = 0;

    constructor(private seed: string) { }

    private async refill() {
        const bytes = await sha256(`${this.seed}:${this.counter++}`);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < 8; i++) this.buffer.push(view.getUint32(i * 4, false));
    }

    async uint32() {
        if (!this.buffer.length) await this.refill();
        return this.buffer.shift()!;
    }

    /** Uniformly distributed number in [0, n) - values above the last full multiple are discarded */
    async int(n: number) {
        const limit = Math.floor(0x100000000 / n) * n;
        while (true) {
            const u = await this.uint32();
            if (u < limit) return u % n;
        }
    }
}

export const compareIds = (a: string, b: string) => {
    const x = BigInt(a), y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
};

export interface DrawResult {
    round: number;
    messageId: string;
    drawTimestamp: number;
    participantCount: number;
    participantsHash: string;
    seed: string;
    winners: string[];
    sortedIds: string[];
}

export async function draw(messageId: string, participantIds: string[], winnerCount: number, round = 1): Promise<DrawResult> {
    const sortedIds = [...new Set(participantIds)].sort(compareIds);
    const list = sortedIds.join(",");
    const drawTimestamp = Date.now();
    const participantsHash = await sha256Hex(list);
    const seed = await sha256Hex(`${messageId}:${drawTimestamp}:${list}`);

    // Fisher-Yates from the front, only as far as needed
    const rng = new HashRng(seed);
    const arr = [...sortedIds];
    const count = Math.min(winnerCount, arr.length);
    for (let i = 0; i < count; i++) {
        const j = i + await rng.int(arr.length - i);
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }

    return {
        round,
        messageId,
        drawTimestamp,
        participantCount: sortedIds.length,
        participantsHash,
        seed,
        winners: arr.slice(0, count),
        sortedIds
    };
}

// ---------------------------------------------------------------- Texts

export function formatResult(r: DrawResult, emoji: ReactionEmoji) {
    const emojiText = emoji.id ? `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>` : emoji.name;
    const lines = [
        `🎉 **Giveaway result${r.round > 1 ? ` (redraw ${r.round - 1})` : ""}**`,
        `Winners: ${r.winners.map(id => `<@${id}>`).join(", ") || "–"}`,
        `Participants: ${r.participantCount} (reaction ${emojiText})`,
        `Time: ${r.drawTimestamp} (<t:${Math.floor(r.drawTimestamp / 1000)}:f>)`,
        `Seed: \`${r.seed}\``,
        `Participant hash: \`${r.participantsHash}\``,
        "-# Verifiable: seed = SHA-256(message ID:time:sorted participant IDs), draw via SHA-256 randomness + Fisher-Yates."
    ];
    return lines.join("\n");
}

/** Small, standalone verification script (browser console or Node 18+) */
export function verifyScript(r: DrawResult, winnerCount: number) {
    return `// FairGiveaway - verification script. Paste the participant IDs (comma-separated) into IDS.
const MESSAGE_ID = "${r.messageId}", TIME = ${r.drawTimestamp}, WINNERS = ${winnerCount};
const IDS = "${r.sortedIds.join(",")}";
const sha = async s => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const hex = b => [...b].map(x => x.toString(16).padStart(2, "0")).join("");
(async () => {
  const ids = IDS.split(",").sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  const list = ids.join(",");
  console.log("Participant hash", hex(await sha(list)));
  const seed = hex(await sha(MESSAGE_ID + ":" + TIME + ":" + list));
  console.log("Seed", seed);
  let buf = [], k = 0;
  const u32 = async () => { if (!buf.length) { const b = await sha(seed + ":" + k++); const v = new DataView(b.buffer); for (let i = 0; i < 8; i++) buf.push(v.getUint32(i * 4)); } return buf.shift(); };
  const int = async n => { const lim = Math.floor(2 ** 32 / n) * n; for (;;) { const u = await u32(); if (u < lim) return u % n; } };
  for (let i = 0; i < Math.min(WINNERS, ids.length); i++) { const j = i + await int(ids.length - i); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  console.log("Winners", ids.slice(0, WINNERS));
})();`;
}
