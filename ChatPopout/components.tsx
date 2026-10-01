/*
 * ChatPopout – message components of bots/apps: buttons & selects (action rows) and
 * "Components V2" layouts (text, sections, containers, galleries, files, separators)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classes } from "@utils/misc";

import { mediaAttrs, MediaItem } from "./media";
import { CDN, CHEVRON_PATH, cl, FallbackImg, FILE_PATH, fitBox, Icon, isAnimated, isSpoiler, LINK_PATH, Markdown, sized, Spoiler, tip } from "./shared";

export const IS_COMPONENTS_V2 = 1 << 15;

const enum Type {
    ActionRow = 1,
    Button = 2,
    StringSelect = 3,
    TextInput = 4,
    UserSelect = 5,
    RoleSelect = 6,
    MentionableSelect = 7,
    ChannelSelect = 8,
    Section = 9,
    TextDisplay = 10,
    Thumbnail = 11,
    MediaGallery = 12,
    File = 13,
    Separator = 14,
    Container = 17
}

const BUTTON_STYLE: Record<number, string> = { 1: "primary", 2: "secondary", 3: "success", 4: "danger", 5: "link", 6: "premium" };

interface Ctx {
    message: { id: string; channel_id: string; attachments?: any[]; };
    open(original: string): void;
    jump(): void;
}

/** "attachment://name.png" refers to an attachment of the message */
function resolveMedia(media: any, message: Ctx["message"]): MediaItem | null {
    if (!media?.url) return null;
    let { url, proxy_url: proxy, width, height, content_type } = media;
    if (url.startsWith("attachment://")) {
        const a = message.attachments?.find(x => x.filename === url.slice("attachment://".length));
        if (!a) return null;
        ({ url, proxy_url: proxy, width, height, content_type } = a);
    }
    return {
        url: proxy ?? url,
        original: url,
        kind: content_type?.startsWith("video/") ? "video" : "image",
        width,
        height
    };
}

/** All media in components (for the viewer's gallery) */
export function collectComponentMedia(components: any[] | undefined, message: Ctx["message"], out: MediaItem[] = []) {
    for (const c of components ?? []) {
        if (c.type === Type.Thumbnail) {
            const m = resolveMedia(c.media, message);
            if (m) out.push(m);
        } else if (c.type === Type.MediaGallery) {
            for (const it of c.items ?? []) {
                const m = resolveMedia(it.media, message);
                if (m) out.push(m);
            }
        } else if (c.type === Type.Section) {
            collectComponentMedia([...(c.components ?? []), c.accessory].filter(Boolean), message, out);
        } else if (c.components) {
            collectComponentMedia(c.components, message, out);
        }
    }
    return out;
}

function Media({ item, raw, ctx, maxW, maxH, className }: { item: MediaItem; raw: any; ctx: Ctx; maxW: number; maxH: number; className?: string; }) {
    const box = fitBox(item.width, item.height, maxW, maxH);
    const content = item.kind === "video"
        ? <video className={classes(cl("image"), className)} src={item.url} controls preload="metadata" width={box.width} height={box.height} {...mediaAttrs(item)} />
        : <FallbackImg
            className={classes(cl("image"), className)}
            src={box.width && !isAnimated(raw) ? sized(item.url, box.width * 2, box.height! * 2) : item.url}
            fallback={item.original}
            width={box.width}
            height={box.height}
            alt={raw?.description ?? ""}
            onClick={() => ctx.open(item.original)}
            {...mediaAttrs(item)}
        />;
    return raw?.spoiler || isSpoiler(raw ?? {}) ? <Spoiler>{content}</Spoiler> : content;
}

function Emoji({ emoji }: { emoji: any; }) {
    if (!emoji) return null;
    if (emoji.id) return <img className={cl("comp-emoji")} src={`${CDN}/emojis/${emoji.id}.${emoji.animated ? "gif" : "webp"}?size=32`} alt={emoji.name} />;
    return <span className={cl("comp-emoji-text")}>{emoji.name}</span>;
}

function Button({ c, ctx }: { c: any; ctx: Ctx; }) {
    const style = BUTTON_STYLE[c.style] ?? "secondary";
    const body = <>
        <Emoji emoji={c.emoji} />
        {c.label && <span className={cl("comp-btn-label")}>{c.label}</span>}
        {style === "link" && <Icon path={LINK_PATH} size={14} />}
    </>;
    const className = classes(cl("comp-btn"), cl(`comp-btn-${style}`), c.disabled && cl("comp-btn-disabled"));

    if (style === "link" && c.url && !c.disabled) {
        return <a className={className} href={c.url} target="_blank" rel="noreferrer noopener">{body}</a>;
    }
    // Interactions only work in the main window (Discord sends them with its own session state)
    return (
        <button className={className} disabled={c.disabled} {...tip("Use in main window")} onClick={ctx.jump}>
            {body}
        </button>
    );
}

function Select({ c, ctx }: { c: any; ctx: Ctx; }) {
    return (
        <button className={classes(cl("comp-select"), c.disabled && cl("comp-btn-disabled"))} disabled={c.disabled} {...tip("Use in main window")} onClick={ctx.jump}>
            <span>{c.placeholder || "Make a selection"}</span>
            <Icon path={CHEVRON_PATH} size={16} />
        </button>
    );
}

function Component({ c, ctx }: { c: any; ctx: Ctx; }) {
    switch (c.type) {
        case Type.ActionRow:
            return <div className={cl("comp-row")}>{(c.components ?? []).map((x: any, i: number) => <Component key={x.id ?? i} c={x} ctx={ctx} />)}</div>;
        case Type.Button:
            return <Button c={c} ctx={ctx} />;
        case Type.StringSelect:
        case Type.UserSelect:
        case Type.RoleSelect:
        case Type.MentionableSelect:
        case Type.ChannelSelect:
            return <Select c={c} ctx={ctx} />;
        case Type.TextDisplay:
            return <div className={cl("comp-text")}><Markdown content={c.content ?? ""} channelId={ctx.message.channel_id} messageId={ctx.message.id} /></div>;
        case Type.Section:
            return (
                <div className={cl("comp-section")}>
                    <div className={cl("comp-section-body")}>
                        {(c.components ?? []).map((x: any, i: number) => <Component key={x.id ?? i} c={x} ctx={ctx} />)}
                    </div>
                    {c.accessory && <div className={cl("comp-accessory")}><Component c={c.accessory} ctx={ctx} /></div>}
                </div>
            );
        case Type.Thumbnail: {
            const item = resolveMedia(c.media, ctx.message);
            return item && <Media item={item} raw={{ ...c.media, spoiler: c.spoiler, description: c.description }} ctx={ctx} maxW={85} maxH={85} className={cl("comp-thumb")} />;
        }
        case Type.MediaGallery: {
            const items = (c.items ?? []).map((it: any) => ({ it, item: resolveMedia(it.media, ctx.message) })).filter((x: any) => x.item);
            const single = items.length === 1;
            return (
                <div className={classes(cl("comp-gallery"), single && cl("comp-gallery-single"))}>
                    {items.map(({ it, item }: any, i: number) => (
                        <Media key={i} item={item} raw={{ ...it.media, spoiler: it.spoiler, description: it.description }} ctx={ctx} maxW={single ? 400 : 200} maxH={single ? 300 : 200} />
                    ))}
                </div>
            );
        }
        case Type.File: {
            const name = c.file?.url?.replace("attachment://", "");
            const a = ctx.message.attachments?.find(x => x.filename === name);
            return (
                <a className={cl("file")} href={a?.url ?? c.file?.url} target="_blank" rel="noreferrer noopener">
                    <Icon path={FILE_PATH} size={22} />
                    <span className={cl("file-name")}>{a?.filename ?? name ?? "File"}</span>
                </a>
            );
        }
        case Type.Separator:
            return <div className={classes(cl("comp-sep"), c.divider !== false && cl("comp-sep-line"), c.spacing === 2 && cl("comp-sep-large"))} />;
        case Type.Container: {
            const color = typeof c.accent_color === "number" ? `#${c.accent_color.toString(16).padStart(6, "0")}` : undefined;
            const body = (
                <div className={cl("comp-container")} style={color ? { borderLeftColor: color } : undefined}>
                    {(c.components ?? []).map((x: any, i: number) => <Component key={x.id ?? i} c={x} ctx={ctx} />)}
                </div>
            );
            return c.spoiler ? <Spoiler>{body}</Spoiler> : body;
        }
        default:
            return null;
    }
}

export function MessageComponents({ components, ctx }: { components?: any[]; ctx: Ctx; }) {
    if (!components?.length) return null;
    return (
        <div className={cl("components")}>
            {components.map((c, i) => <Component key={c.id ?? i} c={c} ctx={ctx} />)}
        </div>
    );
}
