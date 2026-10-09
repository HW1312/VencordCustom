/*
 * MessageSelect – renders selected messages to a canvas in Discord's look
 * Everything is drawn by hand (no DOM-to-image), so it doesn't depend on Discord's markup.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Message } from "@vencord/discord-types";
import { ChannelStore, IconUtils, showToast, UserStore } from "@webpack/common";

import { channelName, displayName, formatFullDate, messageDate, resolveRoleName, roleColor } from "./store";

// ---------------------------------------------------------------- Options & theme

export interface ShotOptions {
    theme: "dark" | "light";
    hideNames: boolean;
    hideAvatars: boolean;
    showImages: boolean;
}

interface Theme {
    bg: string;
    text: string;
    muted: string;
    header: string;
    codeBg: string;
    codeBorder: string;
    link: string;
    quoteBar: string;
    mentionBg: string;
    mentionText: string;
    embedBg: string;
    spoiler: string;
    placeholder: string;
}

const THEMES: Record<ShotOptions["theme"], Theme> = {
    dark: {
        bg: "#313338",
        text: "#dbdee1",
        muted: "#949ba4",
        header: "#f2f3f5",
        codeBg: "#2b2d31",
        codeBorder: "#1e1f22",
        link: "#00a8fc",
        quoteBar: "#4e5058",
        mentionBg: "rgba(88, 101, 242, 0.3)",
        mentionText: "#c9cdfb",
        embedBg: "#2b2d31",
        spoiler: "#1e1f22",
        placeholder: "#404249"
    },
    light: {
        bg: "#ffffff",
        text: "#313338",
        muted: "#5c5e66",
        header: "#060607",
        codeBg: "#f2f3f5",
        codeBorder: "#e3e5e8",
        link: "#006ce7",
        quoteBar: "#c4c9ce",
        mentionBg: "rgba(88, 101, 242, 0.15)",
        mentionText: "#505cdc",
        embedBg: "#f2f3f5",
        spoiler: "#c4c9ce",
        placeholder: "#e3e5e8"
    }
};

/** Discord's default avatar colors, used for anonymous / failed avatars */
const AVATAR_COLORS = ["#5865f2", "#757e8a", "#3ba55c", "#faa61a", "#ed4245", "#eb459f"];

const SANS = '"gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
const MONO = '"gg mono", Consolas, "Andale Mono WT", "Andale Mono", "Lucida Console", Monaco, monospace';

// ---------------------------------------------------------------- Geometry (CSS pixels)

const WIDTH = 760;
const PAD = 16;
const AVATAR = 40;
const GAP_AVATAR = 16;
const GROUP_GAP = 17;
const MSG_GAP = 2;
const MAX_IMG_W = 400;
const MAX_IMG_H = 300;
const MAX_CANVAS_PX = 32000;

// ---------------------------------------------------------------- Image loading

function loadImage(url: string | null | undefined, timeout = 8000): Promise<HTMLImageElement | null> {
    if (!url) return Promise.resolve(null);
    return new Promise(resolve => {
        const img = new Image();
        // With crossOrigin set, a response without CORS headers fails to load instead of tainting the canvas
        img.crossOrigin = "anonymous";
        img.decoding = "async";
        const timer = setTimeout(() => resolve(null), timeout);
        img.onload = () => { clearTimeout(timer); resolve(img); };
        img.onerror = () => { clearTimeout(timer); resolve(null); };
        img.src = url;
    });
}

async function loadFirst(urls: (string | null | undefined)[]) {
    for (const url of urls) {
        const img = await loadImage(url);
        if (img) return img;
    }
    return null;
}

function sized(url: string, w: number, h: number) {
    return `${url}${url.includes("?") ? "&" : "?"}width=${Math.round(w)}&height=${Math.round(h)}`;
}

function fit(w: number | undefined, h: number | undefined, maxW: number, maxH: number) {
    if (!w || !h) return { w: maxW, h: Math.round(maxW * 0.5625) };
    const s = Math.min(1, maxW / w, maxH / h);
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

// ---------------------------------------------------------------- Inline markdown

interface Run {
    text: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strike?: boolean;
    code?: boolean;
    spoiler?: boolean;
    mention?: boolean;
    link?: boolean;
    muted?: boolean;
    small?: boolean;
    /** Custom emoji image URL */
    emoji?: string;
}

type Style = Omit<Run, "text" | "emoji">;

interface Ctx {
    guildId: string | null;
    userName(id: string): string;
}

interface Rule {
    re: RegExp;
    apply(m: RegExpExecArray, style: Style, ctx: Ctx): Run[];
}

const nested = (key: keyof Style) => (m: RegExpExecArray, style: Style, ctx: Ctx) => parseInline(m[1], { ...style, [key]: true }, ctx);

const RULES: Rule[] = [
    { re: /\\([^\w\s])/y, apply: (m, s) => [{ ...s, text: m[1] }] },
    { re: /``([^]+?)``/y, apply: (m, s) => [{ ...s, code: true, text: m[1] }] },
    { re: /`([^`\n]+?)`/y, apply: (m, s) => [{ ...s, code: true, text: m[1] }] },
    { re: /\|\|([^]+?)\|\|/y, apply: nested("spoiler") },
    { re: /\*\*\*([^]+?)\*\*\*/y, apply: (m, s, c) => parseInline(m[1], { ...s, bold: true, italic: true }, c) },
    { re: /\*\*([^]+?)\*\*/y, apply: nested("bold") },
    { re: /__([^]+?)__/y, apply: nested("underline") },
    { re: /~~([^]+?)~~/y, apply: nested("strike") },
    { re: /\*(?!\s)([^*\n]+?)\*/y, apply: nested("italic") },
    { re: /_([^_\n]+?)_(?!\w)/y, apply: nested("italic") },
    { re: /<@!?(\d+)>/y, apply: (m, s, c) => [{ ...s, mention: true, text: `@${c.userName(m[1])}` }] },
    { re: /<@&(\d+)>/y, apply: (m, s, c) => [{ ...s, mention: true, text: `@${resolveRoleName(c.guildId, m[1])}` }] },
    { re: /<#(\d+)>/y, apply: (m, s) => [{ ...s, mention: true, text: `#${channelName(m[1])}` }] },
    { re: /<\/([\w -]+):\d+>/y, apply: (m, s) => [{ ...s, mention: true, text: `/${m[1]}` }] },
    { re: /@(everyone|here)\b/y, apply: (m, s) => [{ ...s, mention: true, text: m[0] }] },
    { re: /<(a?):(\w+):(\d+)>/y, apply: (m, s) => [{ ...s, text: `:${m[2]}:`, emoji: `https://cdn.discordapp.com/emojis/${m[3]}.${m[1] ? "gif" : "png"}?size=96` }] },
    { re: /<t:(-?\d+)(?::[tTdDfFR])?>/y, apply: (m, s) => [{ ...s, code: false, mention: true, text: formatFullDate(new Date(Number(m[1]) * 1000)) }] },
    { re: /<(https?:\/\/[^\s>]+)>/y, apply: (m, s) => [{ ...s, link: true, text: m[1] }] },
    { re: /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/y, apply: (m, s, c) => parseInline(m[1], { ...s, link: true }, c) },
    { re: /https?:\/\/[^\s<]+[^\s<.,:;"')\]]/y, apply: (m, s) => [{ ...s, link: true, text: m[0] }] }
];

function parseInline(text: string, style: Style, ctx: Ctx): Run[] {
    const out: Run[] = [];
    let plain = "";
    const flush = () => {
        if (plain) out.push({ ...style, text: plain });
        plain = "";
    };

    let i = 0;
    outer: while (i < text.length) {
        for (const rule of RULES) {
            rule.re.lastIndex = i;
            const m = rule.re.exec(text);
            if (m && m[0].length) {
                flush();
                out.push(...rule.apply(m, style, ctx));
                i += m[0].length;
                continue outer;
            }
        }
        plain += text[i++];
    }
    flush();
    return out;
}

// ---------------------------------------------------------------- Blocks

interface Block {
    kind: "text" | "code";
    runs: Run[];
    quote?: boolean;
    heading?: 1 | 2 | 3;
    subtext?: boolean;
    bullet?: boolean;
    /** Code block lines */
    code?: string[];
}

function parseBlocks(content: string, ctx: Ctx): Block[] {
    const blocks: Block[] = [];
    const parts = content.split(/```(?:[\w+-]*\n)?([^]*?)```/);

    parts.forEach((part, index) => {
        // Odd parts are code block contents
        if (index % 2 === 1) {
            blocks.push({ kind: "code", runs: [], code: part.replace(/\n$/, "").split("\n") });
            return;
        }

        let quoteRest = false;
        const lines = part.split("\n");
        // Trim empty lines around code blocks
        if (index > 0 && lines[0] === "") lines.shift();
        if (index < parts.length - 1 && lines[lines.length - 1] === "") lines.pop();

        for (let line of lines) {
            const block: Block = { kind: "text", runs: [] };
            if (quoteRest) block.quote = true;
            if (line.startsWith(">>> ")) {
                quoteRest = true;
                block.quote = true;
                line = line.slice(4);
            } else if (line.startsWith("> ") || line === ">") {
                block.quote = true;
                line = line.slice(2);
            }

            const heading = /^(#{1,3}) (.+)$/.exec(line);
            if (heading) {
                block.heading = heading[1].length as 1 | 2 | 3;
                line = heading[2];
            } else if (line.startsWith("-# ")) {
                block.subtext = true;
                line = line.slice(3);
            } else if (/^\s*[-*] /.test(line)) {
                block.bullet = true;
                line = line.replace(/^\s*[-*] /, "");
            }

            block.runs = parseInline(line, {}, ctx);
            blocks.push(block);
        }
    });

    return blocks;
}

// ---------------------------------------------------------------- Layout primitives

type Op = (c: CanvasRenderingContext2D) => void;

interface Layout {
    ops: Op[];
    y: number;
}

function fontSize(block: Block, run?: Run) {
    if (run?.small) return 10;
    if (block.heading === 1) return 24;
    if (block.heading === 2) return 20;
    if (block.subtext) return 13;
    return run?.code ? 14 : 16;
}

function lineHeight(block: Block) {
    if (block.heading === 1) return 30;
    if (block.heading === 2) return 26;
    if (block.subtext) return 18;
    return 22;
}

function fontFor(block: Block, run: Run) {
    const size = fontSize(block, run);
    const weight = run.bold || block.heading ? 700 : 400;
    return `${run.italic ? "italic " : ""}${weight} ${size}px ${run.code ? MONO : SANS}`;
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
}

interface Piece {
    run: Run;
    text: string;
    x: number;
    w: number;
}

/** Word wraps runs into lines of pieces */
function wrapRuns(measure: CanvasRenderingContext2D, block: Block, runs: Run[], maxW: number, emojiSize: number): Piece[][] {
    const lines: Piece[][] = [[]];
    let x = 0;

    const push = (run: Run, text: string, w: number) => {
        const line = lines[lines.length - 1];
        const prev = line[line.length - 1];
        // Merge with the previous piece of the same run to keep draw calls (and backgrounds) together
        if (prev && prev.run === run && !run.emoji) {
            prev.text += text;
            prev.w += w;
        } else {
            line.push({ run, text, w, x });
        }
        x += w;
    };
    const newLine = () => {
        lines.push([]);
        x = 0;
    };

    for (const run of runs) {
        if (run.emoji) {
            if (x + emojiSize > maxW && x > 0) newLine();
            push(run, run.text, emojiSize + 2);
            continue;
        }

        measure.font = fontFor(block, run);
        for (const token of run.text.match(/\s+|\S+/g) ?? []) {
            if (/^\s+$/.test(token)) {
                if (x === 0) continue;
                push(run, " ", measure.measureText(" ").width);
                continue;
            }
            let w = measure.measureText(token).width;
            if (x + w > maxW && x > 0) newLine();
            if (w <= maxW) {
                push(run, token, w);
                continue;
            }
            // Longer than a whole line: break by characters
            let chunk = "";
            for (const ch of token) {
                const cw = measure.measureText(chunk + ch).width;
                if (x + cw > maxW && chunk) {
                    push(run, chunk, measure.measureText(chunk).width);
                    newLine();
                    chunk = ch;
                } else chunk += ch;
            }
            w = measure.measureText(chunk).width;
            push(run, chunk, w);
        }
    }

    // Trailing spaces
    for (const line of lines) {
        const last = line[line.length - 1];
        if (last && /\s$/.test(last.text) && !last.run.emoji) {
            measure.font = fontFor(block, last.run);
            const trimmed = last.text.replace(/\s+$/, "");
            last.w = measure.measureText(trimmed).width;
            last.text = trimmed;
        }
    }
    return lines;
}

// ---------------------------------------------------------------- Message model

interface ShotMessage {
    message: Message;
    authorId: string;
    name: string;
    color: string | null;
    avatarUrl: string | null;
    avatarIndex: number;
    date: Date;
    startsGroup: boolean;
    blocks: Block[];
    jumbo: boolean;
    edited: boolean;
    images: { urls: string[]; w: number; h: number; spoiler: boolean; }[];
    files: { name: string; size: number; }[];
    stickers: { name: string; url: string | null; }[];
    embeds: { color: string | null; author?: string; title?: string; description?: Block[]; }[];
}

const GROUP_WINDOW = 7 * 60 * 1000;

function formatHeaderDate(d: Date) {
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (day === today) return `Today at ${time}`;
    if (today - day === 86400000) return `Yesterday at ${time}`;
    return `${d.toLocaleDateString()} ${time}`;
}

function isImageAttachment(a: any) {
    return /^image\//.test(a.content_type ?? "") || /\.(png|jpe?g|gif|webp|avif)$/i.test(a.filename ?? "");
}

function formatSize(bytes: number) {
    if (!bytes) return "";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
        bytes /= 1024;
        i++;
    }
    return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function intColor(n: number | null | undefined) {
    return typeof n === "number" ? `#${n.toString(16).padStart(6, "0")}` : null;
}

function buildModel(messages: Message[], opts: ShotOptions): ShotMessage[] {
    const channel = messages[0] ? ChannelStore.getChannel(messages[0].channel_id) : null;
    const guildId = channel?.guild_id ?? null;

    // Anonymous names in order of appearance (authors first, then mentioned users)
    const anon = new Map<string, number>();
    const anonIndex = (id: string) => {
        if (!anon.has(id)) anon.set(id, anon.size + 1);
        return anon.get(id)!;
    };
    messages.forEach(m => m.author?.id && anonIndex(m.author.id));

    const ctx: Ctx = {
        guildId,
        userName: id => opts.hideNames ? `User ${anonIndex(id)}` : displayName(UserStore.getUser(id), guildId)
    };

    let prev: ShotMessage | null = null;
    return messages.map(m => {
        const authorId = m.author?.id ?? "0";
        const date = messageDate(m);
        const user = UserStore.getUser(authorId) ?? m.author;
        const a: any = m.author;

        let avatarUrl: string | null = null;
        if (!opts.hideNames && !opts.hideAvatars) {
            try {
                avatarUrl = a?.avatar && a?.bot
                    ? `https://cdn.discordapp.com/avatars/${authorId}/${a.avatar}.png?size=128`
                    : IconUtils.getUserAvatarURL(user, false, 128, "png");
            } catch {
                avatarUrl = null;
            }
        }

        const blocks = parseBlocks(m.content ?? "", ctx);
        const allRuns = blocks.flatMap(b => b.runs);
        const jumbo = blocks.every(b => b.kind === "text")
            && allRuns.some(r => r.emoji)
            && allRuns.every(r => r.emoji || !r.text.trim())
            && allRuns.filter(r => r.emoji).length <= 27;

        const images: ShotMessage["images"] = [];
        const files: ShotMessage["files"] = [];
        for (const att of (m.attachments ?? []) as any[]) {
            if (isImageAttachment(att)) {
                const { w, h } = fit(att.width, att.height, MAX_IMG_W, MAX_IMG_H);
                const proxy = att.proxy_url ? sized(att.proxy_url, w * 2, h * 2) : null;
                images.push({
                    urls: [proxy, att.url].filter(Boolean),
                    w,
                    h,
                    spoiler: !!att.spoiler || !!(att.flags & 8) || att.filename?.startsWith("SPOILER_")
                });
            } else {
                files.push({ name: att.filename ?? "file", size: att.size ?? 0 });
            }
        }

        const stickers = ((m as any).stickerItems ?? m.stickers ?? []).map((s: any) => ({
            name: s.name ?? "Sticker",
            // Lottie stickers (format 3) can't be drawn
            url: s.format_type === 3 ? null : `https://media.discordapp.net/stickers/${s.id}.png?size=160`
        }));

        const embeds = ((m.embeds ?? []) as any[])
            .filter(e => e.rawTitle || e.title || e.rawDescription || e.description || e.author?.name)
            .map(e => ({
                color: e.color ? (typeof e.color === "string" ? e.color : intColor(e.color)) : null,
                author: e.author?.name,
                title: e.rawTitle ?? e.title,
                description: (e.rawDescription ?? e.description) ? parseBlocks(e.rawDescription ?? e.description, ctx) : undefined
            }));

        const startsGroup = !prev
            || prev.authorId !== authorId
            || date.getTime() - prev.date.getTime() > GROUP_WINDOW
            || !!m.messageReference;

        const item: ShotMessage = {
            message: m,
            authorId,
            name: opts.hideNames ? `User ${anonIndex(authorId)}` : displayName(user, guildId),
            color: opts.hideNames ? null : roleColor(authorId, guildId),
            avatarUrl,
            avatarIndex: opts.hideNames ? anonIndex(authorId) % AVATAR_COLORS.length : (Number(authorId.slice(-4)) || 0) % AVATAR_COLORS.length,
            date,
            startsGroup,
            blocks,
            jumbo,
            edited: !!m.editedTimestamp,
            images,
            files,
            stickers,
            embeds
        };
        prev = item;
        return item;
    });
}

// ---------------------------------------------------------------- Rendering

interface Assets {
    images: Map<string, HTMLImageElement | null>;
}

async function loadAssets(model: ShotMessage[], opts: ShotOptions): Promise<Assets> {
    const images = new Map<string, HTMLImageElement | null>();
    const jobs: Promise<void>[] = [];
    const add = (key: string, urls: (string | null | undefined)[]) => {
        if (!key || images.has(key)) return;
        images.set(key, null);
        jobs.push(loadFirst(urls).then(img => void images.set(key, img)));
    };

    for (const m of model) {
        if (m.startsGroup && m.avatarUrl) add(m.avatarUrl, [m.avatarUrl]);
        for (const b of m.blocks) for (const r of b.runs) if (r.emoji) add(r.emoji, [r.emoji]);
        if (opts.showImages) {
            for (const img of m.images) add(img.urls[0], img.urls);
            for (const s of m.stickers) if (s.url) add(s.url, [s.url]);
        }
    }

    await Promise.all(jobs);
    return { images };
}

function layoutBlocks(L: Layout, measure: CanvasRenderingContext2D, blocks: Block[], x: number, maxW: number, theme: Theme, assets: Assets, jumbo: boolean) {
    for (const block of blocks) {
        if (block.kind === "code") {
            const lines = block.code ?? [""];
            const lh = 18;
            const padIn = 8;
            measure.font = `400 14px ${MONO}`;
            // Wrap long code lines by characters
            const wrapped: string[] = [];
            for (const line of lines) {
                let cur = "";
                for (const ch of line) {
                    if (measure.measureText(cur + ch).width > maxW - padIn * 2 && cur) {
                        wrapped.push(cur);
                        cur = ch;
                    } else cur += ch;
                }
                wrapped.push(cur);
            }
            const top = L.y + 4;
            const h = wrapped.length * lh + padIn * 2;
            L.ops.push(c => {
                c.fillStyle = theme.codeBg;
                c.strokeStyle = theme.codeBorder;
                c.lineWidth = 1;
                roundRect(c, x + 0.5, top + 0.5, maxW - 1, h - 1, 4);
                c.fill();
                c.stroke();
                c.fillStyle = theme.text;
                c.font = `400 14px ${MONO}`;
                c.textBaseline = "middle";
                wrapped.forEach((line, i) => c.fillText(line, x + padIn, top + padIn + i * lh + lh / 2));
            });
            L.y = top + h + 4;
            continue;
        }

        const lh = jumbo ? 52 : lineHeight(block);
        const emojiSize = jumbo ? 48 : 22;
        const indent = (block.quote ? 16 : 0) + (block.bullet ? 18 : 0);
        const lines = wrapRuns(measure, block, block.runs, maxW - indent, emojiSize);
        const top = L.y;
        const extra = block.heading ? 4 : 0;

        if (block.quote) {
            const h = lines.length * lh;
            L.ops.push(c => {
                c.fillStyle = theme.quoteBar;
                roundRect(c, x, top + extra, 4, h, 2);
                c.fill();
            });
        }
        if (block.bullet) {
            L.ops.push(c => {
                c.fillStyle = theme.text;
                c.beginPath();
                c.arc(x + (block.quote ? 16 : 0) + 6, top + extra + lh / 2, 2.5, 0, Math.PI * 2);
                c.fill();
            });
        }

        lines.forEach((line, li) => {
            const ly = top + extra + li * lh;
            const mid = ly + lh / 2;
            for (const piece of line) {
                const { run } = piece;
                const px = x + indent + piece.x;
                L.ops.push(c => {
                    if (run.emoji) {
                        const img = assets.images.get(run.emoji);
                        if (img) c.drawImage(img, px, mid - emojiSize / 2, emojiSize, emojiSize);
                        else {
                            c.font = `400 14px ${SANS}`;
                            c.fillStyle = theme.muted;
                            c.textBaseline = "middle";
                            c.fillText(run.text, px, mid);
                        }
                        return;
                    }

                    c.font = fontFor(block, run);
                    c.textBaseline = "middle";
                    const size = fontSize(block, run);

                    if (run.spoiler) {
                        c.fillStyle = theme.spoiler;
                        roundRect(c, px - 1, mid - size * 0.7, piece.w + 2, size * 1.4, 3);
                        c.fill();
                        return;
                    }
                    if (run.code) {
                        c.fillStyle = theme.codeBg;
                        roundRect(c, px - 2, mid - size * 0.75, piece.w + 4, size * 1.5, 3);
                        c.fill();
                    }
                    if (run.mention) {
                        c.fillStyle = theme.mentionBg;
                        roundRect(c, px - 2, mid - size * 0.72, piece.w + 4, size * 1.44, 3);
                        c.fill();
                    }

                    c.fillStyle = run.mention ? theme.mentionText
                        : run.link ? theme.link
                            : run.muted || block.subtext ? theme.muted
                                : block.heading ? theme.header
                                    : theme.text;
                    c.fillText(piece.text, px, mid + 1);

                    if (run.underline) {
                        c.fillRect(px, mid + size * 0.55, piece.w, 1);
                    }
                    if (run.strike) {
                        c.fillRect(px, mid + 1, piece.w, 1.2);
                    }
                });
            }
        });

        L.y = top + extra * 2 + lines.length * lh;
    }
}

function layoutMessage(L: Layout, measure: CanvasRenderingContext2D, m: ShotMessage, opts: ShotOptions, theme: Theme, assets: Assets, first: boolean) {
    const showAvatars = !opts.hideAvatars;
    const contentX = showAvatars ? PAD + AVATAR + GAP_AVATAR : PAD;
    const maxW = WIDTH - contentX - PAD;

    if (m.startsGroup) {
        if (!first) L.y += GROUP_GAP;
        const top = L.y;

        if (showAvatars) {
            const img = m.avatarUrl ? assets.images.get(m.avatarUrl) : null;
            const initial = opts.hideNames ? "" : (m.name.trim()[0] ?? "?").toUpperCase();
            const color = AVATAR_COLORS[m.avatarIndex];
            L.ops.push(c => {
                c.save();
                c.beginPath();
                c.arc(PAD + AVATAR / 2, top + AVATAR / 2, AVATAR / 2, 0, Math.PI * 2);
                c.closePath();
                c.clip();
                if (img) {
                    c.drawImage(img, PAD, top, AVATAR, AVATAR);
                } else {
                    c.fillStyle = opts.hideNames ? theme.placeholder : color;
                    c.fillRect(PAD, top, AVATAR, AVATAR);
                    if (initial) {
                        c.fillStyle = "#ffffff";
                        c.font = `600 18px ${SANS}`;
                        c.textAlign = "center";
                        c.textBaseline = "middle";
                        c.fillText(initial, PAD + AVATAR / 2, top + AVATAR / 2 + 1);
                        c.textAlign = "left";
                    }
                }
                c.restore();
            });
        }

        // Name + timestamp
        measure.font = `600 16px ${SANS}`;
        const nameW = Math.min(measure.measureText(m.name).width, maxW - 120);
        const stamp = formatHeaderDate(m.date);
        const nameColor = m.color || theme.header;
        L.ops.push(c => {
            c.textBaseline = "middle";
            c.font = `600 16px ${SANS}`;
            c.fillStyle = nameColor;
            c.fillText(m.name, contentX, top + 11, maxW - 120);
            c.font = `400 12px ${SANS}`;
            c.fillStyle = theme.muted;
            c.fillText(stamp, contentX + nameW + 8, top + 12);
        });
        L.y = top + 22;
    } else {
        L.y += MSG_GAP;
    }

    // Content
    if (m.blocks.length && (m.message.content ?? "").trim()) {
        const { blocks } = m;
        if (m.edited) {
            const last = blocks[blocks.length - 1];
            if (last.kind === "text") last.runs = [...last.runs, { text: " (edited)", muted: true, small: true }];
        }
        layoutBlocks(L, measure, blocks, contentX, maxW, theme, assets, m.jumbo);
    }

    // Embeds
    for (const e of m.embeds) {
        const top = L.y + 4;
        const inner: Layout = { ops: [], y: top + 10 };
        const innerX = contentX + 16;
        const innerW = Math.min(432, maxW) - 28;
        if (e.author) layoutBlocks(inner, measure, [{ kind: "text", runs: [{ text: e.author, bold: true, small: false }], subtext: true }], innerX, innerW, theme, assets, false);
        if (e.title) layoutBlocks(inner, measure, [{ kind: "text", runs: [{ text: e.title, bold: true, link: true }] }], innerX, innerW, theme, assets, false);
        if (e.description) layoutBlocks(inner, measure, e.description.map(b => ({ ...b, runs: b.runs.map(r => ({ ...r })) })), innerX, innerW, theme, assets, false);
        const h = inner.y - top + 10;
        const w = Math.min(432, maxW);
        const bar = e.color || theme.quoteBar;
        L.ops.push(c => {
            c.fillStyle = theme.embedBg;
            roundRect(c, contentX, top, w, h, 4);
            c.fill();
            c.fillStyle = bar;
            roundRect(c, contentX, top, 4, h, 2);
            c.fill();
        });
        L.ops.push(...inner.ops);
        L.y = top + h + 4;
    }

    // Images
    if (opts.showImages) {
        for (const img of m.images) {
            const top = L.y + 4;
            const el = assets.images.get(img.urls[0]);
            L.ops.push(c => {
                c.save();
                roundRect(c, contentX, top, img.w, img.h, 8);
                c.clip();
                if (el) {
                    c.drawImage(el, contentX, top, img.w, img.h);
                    if (img.spoiler) {
                        c.fillStyle = "rgba(0, 0, 0, 0.85)";
                        c.fillRect(contentX, top, img.w, img.h);
                    }
                } else {
                    c.fillStyle = theme.placeholder;
                    c.fillRect(contentX, top, img.w, img.h);
                }
                c.restore();
                if (img.spoiler || !el) {
                    c.font = `600 14px ${SANS}`;
                    c.fillStyle = img.spoiler ? "#ffffff" : theme.muted;
                    c.textAlign = "center";
                    c.textBaseline = "middle";
                    c.fillText(img.spoiler ? "SPOILER" : "Image", contentX + img.w / 2, top + img.h / 2);
                    c.textAlign = "left";
                }
            });
            L.y = top + img.h + 4;
        }

        for (const s of m.stickers) {
            const el = s.url ? assets.images.get(s.url) : null;
            const top = L.y + 4;
            if (el) {
                L.ops.push(c => c.drawImage(el, contentX, top, 160, 160));
                L.y = top + 164;
            } else {
                layoutBlocks(L, measure, [{ kind: "text", runs: [{ text: `[Sticker: ${s.name}]`, muted: true }] }], contentX, maxW, theme, assets, false);
            }
        }
    } else if (m.images.length || m.stickers.length) {
        const n = m.images.length + m.stickers.length;
        layoutBlocks(L, measure, [{ kind: "text", runs: [{ text: n === 1 ? "[1 image]" : `[${n} images]`, muted: true }] }], contentX, maxW, theme, assets, false);
    }

    // Other files
    for (const f of m.files) {
        const top = L.y + 4;
        const w = Math.min(400, maxW);
        const h = 56;
        const size = formatSize(f.size);
        L.ops.push(c => {
            c.fillStyle = theme.embedBg;
            c.strokeStyle = theme.codeBorder;
            c.lineWidth = 1;
            roundRect(c, contentX + 0.5, top + 0.5, w - 1, h - 1, 8);
            c.fill();
            c.stroke();
            // File icon
            c.fillStyle = theme.muted;
            roundRect(c, contentX + 14, top + 14, 22, 28, 3);
            c.fill();
            c.textBaseline = "middle";
            c.font = `500 15px ${SANS}`;
            c.fillStyle = theme.link;
            c.fillText(f.name, contentX + 48, top + 20, w - 60);
            if (size) {
                c.font = `400 12px ${SANS}`;
                c.fillStyle = theme.muted;
                c.fillText(size, contentX + 48, top + 39);
            }
        });
        L.y = top + h + 4;
    }
}

/** Renders the messages and returns the finished canvas */
export async function renderScreenshot(messages: Message[], opts: ShotOptions): Promise<HTMLCanvasElement> {
    const theme = THEMES[opts.theme] ?? THEMES.dark;

    try {
        await Promise.all([
            document.fonts?.load(`400 16px ${SANS}`),
            document.fonts?.load(`600 16px ${SANS}`),
            document.fonts?.load(`400 14px ${MONO}`)
        ]);
    } catch { /* system fonts are fine */ }

    const model = buildModel(messages, opts);
    const assets = await loadAssets(model, opts);

    const measure = document.createElement("canvas").getContext("2d")!;
    const L: Layout = { ops: [], y: PAD };
    model.forEach((m, i) => {
        const groupTop = L.y + (m.startsGroup && i > 0 ? GROUP_GAP : 0);
        layoutMessage(L, measure, m, opts, theme, assets, i === 0);
        // A group header must be at least as tall as the avatar
        if (m.startsGroup && !opts.hideAvatars) L.y = Math.max(L.y, groupTop + AVATAR);
    });
    const height = Math.ceil(L.y + PAD);

    const scale = Math.max(0.5, Math.min(2, MAX_CANVAS_PX / height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(WIDTH * scale);
    canvas.height = Math.round(height * scale);
    const c = canvas.getContext("2d")!;
    c.scale(scale, scale);
    c.fillStyle = theme.bg;
    c.fillRect(0, 0, WIDTH, height);
    c.textAlign = "left";

    for (const op of L.ops) {
        try {
            c.save();
            op(c);
        } catch { /* one broken element shouldn't break the image */ } finally {
            c.restore();
        }
    }
    return canvas;
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("PNG export failed")), "image/png"));
}

const MAX_SHOT_MESSAGES = 200;

export function canRenderShot(count: number) {
    if (!count) return false;
    if (count > MAX_SHOT_MESSAGES) {
        showToast(`Select at most ${MAX_SHOT_MESSAGES} messages for a screenshot`, "failure");
        return false;
    }
    return true;
}
