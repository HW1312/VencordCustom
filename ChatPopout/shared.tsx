/*
 * ChatPopout – shared building blocks (icons, tooltips, media helpers, markdown)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory, vencordRootNode } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import { GuildMemberStore, IconUtils, Parser, useEffect, useLayoutEffect, useMemo, UserStore, useState } from "@webpack/common";

export const cl = classNameFactory("vc-chatpopout-");
export const log = new Logger("ChatPopout");

// ---------------------------------------------------------------- Icons

export const POPOUT_PATH = "M14 3a1 1 0 1 0 0 2h3.6l-7.3 7.3a1 1 0 0 0 1.4 1.4L19 6.4V10a1 1 0 1 0 2 0V4a1 1 0 0 0-1-1h-6ZM5 5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 1 0-2 0v5H5V7h5a1 1 0 1 0 0-2H5Z";
export const CLOSE_PATH = "M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 0 0-1.4 1.4l4.9 4.9-4.9 4.9a1 1 0 1 0 1.4 1.4l4.9-4.9 4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z";
export const MIN_PATH = "M5 12a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z";
export const MAX_PATH = "M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v12h12V6H6Z";
export const PIN_PATH = "M16 3a1 1 0 0 1 .7 1.7L16 5.4v4.2l2.7 2.7a1 1 0 0 1-.7 1.7h-5v6a1 1 0 1 1-2 0v-6H6a1 1 0 0 1-.7-1.7L8 9.6V5.4l-.7-.7A1 1 0 0 1 8 3h8Z";
export const MAIN_PATH = "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 4v10h5V8H4Zm7 0v10h9V8h-9Z";
export const CALL_PATH = "M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-5v2h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2H6a2 2 0 0 1-2-2V5Zm7.2 3.1a.6.6 0 0 0-.9.5v3.8a.6.6 0 0 0 .9.5l3-1.9a.6.6 0 0 0 0-1l-3-1.9Z";
export const FILE_PATH = "M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8.4a2 2 0 0 0-.6-1.4l-4.4-4.4A2 2 0 0 0 13.6 2H6Zm7 1.8L18.2 9H14a1 1 0 0 1-1-1V3.8Z";
export const MUTE_PATH = "M3.3 3.3a1 1 0 0 1 1.4 0l16 16a1 1 0 0 1-1.4 1.4l-3.4-3.4A7 7 0 0 1 13 18.9V21a1 1 0 1 1-2 0v-2.1A7 7 0 0 1 5 12a1 1 0 1 1 2 0 5 5 0 0 0 7.5 4.3l-1.6-1.6A3 3 0 0 1 9 12V10.4L3.3 4.7a1 1 0 0 1 0-1.4ZM12 2a3 3 0 0 1 3 3v5.2l-6-6A3 3 0 0 1 12 2Zm6.6 12.4-1.6-1.6c.1-.3.1-.5.1-.8a1 1 0 1 1 2 0c0 .8-.2 1.6-.5 2.4Z";
export const SIDEBAR_PATH = "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm6 0v14h10V5H9Zm-2 0H5v14h2V5Z";
export const HASH_PATH = "M10.99 3.16A1 1 0 1 0 9 2.84L8.15 8H4a1 1 0 0 0 0 2h3.82l-.67 4H3a1 1 0 1 0 0 2h3.82l-.8 4.84a1 1 0 0 0 1.97.32L8.85 16h4.97l-.8 4.84a1 1 0 0 0 1.97.32l.86-5.16H20a1 1 0 1 0 0-2h-3.82l.67-4H21a1 1 0 1 0 0-2h-3.82l.8-4.84a1 1 0 1 0-1.97-.32L15.15 8h-4.97l.8-4.84ZM14.15 14l.67-4H9.85l-.67 4h4.97Z";
export const SPEAKER_PATH = "M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM15.1 20.75c-.58.14-1.1-.33-1.1-.92v-.03c0-.5.37-.92.85-1.05a7 7 0 0 0 0-13.5A1.11 1.11 0 0 1 14 4.2v-.03c0-.6.52-1.06 1.1-.92a9 9 0 0 1 0 17.5ZM15.16 16.51c-.57.28-1.16-.2-1.16-.83v-.14c0-.43.28-.8.63-1.02a3 3 0 0 0 0-5.04c-.35-.23-.63-.6-.63-1.02v-.14c0-.63.59-1.1 1.16-.83a5 5 0 0 1 0 9.02Z";
export const ANNOUNCE_PATH = "M19.56 2a3 3 0 0 0-2.46 1.28 3.85 3.85 0 0 1-1.86 1.42l-8.9 3.18a.5.5 0 0 0-.34.47v10.09a3 3 0 0 0 2.27 2.9l.62.16c1.57.4 3.15-.56 3.55-2.12l.92-3.68a.5.5 0 0 1 .65-.35l2.7.96a3.85 3.85 0 0 1 1.86 1.42 3 3 0 0 0 5.43-1.75V5A3 3 0 0 0 19.56 2ZM4 9a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h.5a.5.5 0 0 0 .5-.5v-6a.5.5 0 0 0-.5-.5H4Z";
export const CHEVRON_PATH = "M5.3 9.3a1 1 0 0 1 1.4 0l5.3 5.29 5.3-5.3a1 1 0 1 1 1.4 1.42l-6 6a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.42Z";
export const DEAF_PATH = "M3.3 3.3a1 1 0 0 1 1.4 0l16 16a1 1 0 0 1-1.4 1.4l-1.5-1.5A2 2 0 0 1 17 20h-1a2 2 0 0 1-2-2v-3.6L6.5 6.9A7 7 0 0 0 5 11v1h2a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H6a3 3 0 0 1-3-3v-8c0-1.8.6-3.5 1.6-4.9l-1.3-1.4a1 1 0 0 1 0-1.4ZM12 3a9 9 0 0 1 9 9v5.2l-2-2V12a7 7 0 0 0-11.6-5.3L6 5.3A9 9 0 0 1 12 3Z";
export const DOWNLOAD_PATH = "M12 2a1 1 0 0 1 1 1v10.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V3a1 1 0 0 1 1-1ZM3 20a1 1 0 0 1 1-1h16a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1Z";
export const COPY_PATH = "M3 16a1 1 0 0 1-1-1V5a3 3 0 0 1 3-3h10a1 1 0 1 1 0 2H5a1 1 0 0 0-1 1v10a1 1 0 0 1-1 1Zm6-10h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Zm0 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H9Z";
export const LINK_PATH = "M16.32 14.72a1 1 0 0 1 0-1.41l2.51-2.51a3.98 3.98 0 0 0-5.62-5.63l-2.52 2.51a1 1 0 0 1-1.41-1.41l2.52-2.52a5.98 5.98 0 0 1 8.45 8.46l-2.52 2.51a1 1 0 0 1-1.41 0ZM7.68 9.3a1 1 0 0 1 0 1.41l-2.52 2.51a3.98 3.98 0 1 0 5.63 5.63l2.51-2.52a1 1 0 0 1 1.42 1.42l-2.52 2.51a5.98 5.98 0 0 1-8.45-8.45l2.51-2.51a1 1 0 0 1 1.42 0Zm1.6 5.42a1 1 0 0 0 1.42 0l4.03-4.02a1 1 0 0 0-1.42-1.42L9.29 13.3a1 1 0 0 0 0 1.42Z";
export const REPLY_PATH = "M2.3 7.3a1 1 0 0 0 0 1.4l5 5a1 1 0 0 0 1.4-1.4L5.42 9H11a7 7 0 0 1 7 7v4a1 1 0 1 0 2 0v-4a9 9 0 0 0-9-9H5.41l3.3-3.3a1 1 0 0 0-1.42-1.4l-5 5Z";
export const EDIT_PATH = "M14.06 4.94a1.5 1.5 0 0 1 2.12 0l2.88 2.88a1.5 1.5 0 0 1 0 2.12L9.4 19.6a2 2 0 0 1-.95.53l-4.2 1.05a1 1 0 0 1-1.22-1.21l1.05-4.2a2 2 0 0 1 .53-.95l9.45-9.88Z";
export const TRASH_PATH = "M14.25 1c.41 0 .75.34.75.75V3h5.25c.41 0 .75.34.75.75v.5c0 .41-.34.75-.75.75H3.75A.75.75 0 0 1 3 4.25v-.5c0-.41.34-.75.75-.75H9V1.75c0-.41.34-.75.75-.75h4.5ZM5.06 7a1 1 0 0 0-1 1.06l.76 12.13a3 3 0 0 0 3 2.81h8.36a3 3 0 0 0 3-2.81l.75-12.13a1 1 0 0 0-1-1.06H5.07Z";
export const ID_PATH = "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm4 3v8h2V8H7Zm4 0v8h3a4 4 0 0 0 0-8h-3Zm2 2h1a2 2 0 1 1 0 4h-1v-4Z";
export const ZOOM_PATH = "M10 3a7 7 0 1 0 4.2 12.6l5.1 5.1a1 1 0 0 0 1.4-1.4l-5.1-5.1A7 7 0 0 0 10 3Zm-5 7a5 5 0 1 1 10 0 5 5 0 0 1-10 0Zm5-3a1 1 0 0 1 1 1v1h1a1 1 0 1 1 0 2h-1v1a1 1 0 1 1-2 0v-1H8a1 1 0 1 1 0-2h1V8a1 1 0 0 1 1-1Z";
export const LEFT_PATH = "M15.7 5.3a1 1 0 0 1 0 1.4L10.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0Z";
export const RIGHT_PATH = "M8.3 18.7a1 1 0 0 1 0-1.4l5.29-5.3-5.3-5.3a1 1 0 0 1 1.42-1.4l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.42 0Z";
export const PLAY_PATH = "M8 5.14v13.72a1 1 0 0 0 1.5.86l11.04-6.86a1 1 0 0 0 0-1.72L9.5 4.28A1 1 0 0 0 8 5.14Z";
export const USER_PATH = "M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm-9 9a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8 1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z";

export function Icon({ path, size = 18, className }: { path: string; size?: number; className?: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden>
            <path fill="currentColor" d={path} />
        </svg>
    );
}

/**
 * Tooltip in the popout window. Discord's own tooltip would appear in the main window,
 * so this is a pure CSS recreation with Discord's colors, font and arrow.
 */
export function tip(text: string, pos: "top" | "bottom" = "top", align: "center" | "start" | "end" = "center") {
    return { "data-tip": text, "data-tip-pos": pos, "data-tip-align": align };
}

// ---------------------------------------------------------------- Media

export const CDN = "https://cdn.discordapp.com";

/** Discord flag for animated images/media (attachments, embed media, component media) */
const IS_ANIMATED = 1 << 5;
const IS_SPOILER = 1 << 3;

export function sized(url: string, w: number, h: number) {
    return `${url}${url.includes("?") ? "&" : "?"}width=${Math.round(w)}&height=${Math.round(h)}`;
}

export function fitBox(w?: number, h?: number, maxW = 400, maxH = 300) {
    if (!w || !h) return { width: undefined, height: undefined };
    const s = Math.min(1, maxW / w, maxH / h);
    return { width: Math.round(w * s), height: Math.round(h * s) };
}

/** GIFs, animated WebP/AVIF … – the media proxy turns them static when resized, so they are loaded unscaled */
export function isAnimated(media: { flags?: number; content_type?: string; url?: string; filename?: string; } | null | undefined) {
    if (!media) return false;
    return !!((media.flags ?? 0) & IS_ANIMATED)
        || media.content_type === "image/gif"
        || /\.gif($|\?)/i.test(media.filename ?? media.url ?? "");
}

export function isSpoiler(a: { flags?: number; filename?: string; spoiler?: boolean; }) {
    return !!a.spoiler || !!((a.flags ?? 0) & IS_SPOILER) || !!a.filename?.startsWith("SPOILER_");
}

/** Image that falls back to the original URL if the media proxy fails */
export function FallbackImg({ src, fallback, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { fallback?: string; }) {
    const [failed, setFailed] = useState(false);
    const url = failed && fallback ? fallback : src;
    return <img {...props} src={url} loading="lazy" draggable={false} onError={() => !failed && fallback && fallback !== src && setFailed(true)} />;
}

/** Autoplaying, muted, looping video like Discord's GIF player */
export function GifVideo({ src, fallback, poster, width, height, ...props }: React.VideoHTMLAttributes<HTMLVideoElement> & { src: string; fallback?: string; }) {
    const [failed, setFailed] = useState(false);
    return (
        <video
            {...props}
            className={cl("image")}
            src={failed && fallback ? fallback : src}
            poster={poster}
            width={width}
            height={height}
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            onError={() => !failed && fallback && fallback !== src && setFailed(true)}
        />
    );
}

/** Blurred until clicked, like Discord's spoiler attachments */
export function Spoiler({ children }: { children: React.ReactNode; }) {
    const [shown, setShown] = useState(false);
    if (shown) return <>{children}</>;
    return (
        <div className={cl("spoiler")} onClickCapture={e => { e.stopPropagation(); e.preventDefault(); setShown(true); }}>
            <div className={cl("spoiler-content")}>{children}</div>
            <span className={cl("spoiler-label")}>SPOILER</span>
        </div>
    );
}

// ---------------------------------------------------------------- Markdown

export function Markdown({ content, channelId, messageId }: { content: string; channelId: string; messageId: string; }) {
    const nodes = useMemo(() => {
        try {
            return Parser.parse(content, true, { channelId, messageId, allowLinks: true, allowHeading: true, allowList: true, allowEmojiLinks: true, viewingChannelId: channelId });
        } catch (e) {
            log.error("Couldn't render markdown", e);
            return content;
        }
    }, [content, channelId, messageId]);

    return <ErrorBoundary noop fallback={() => <span>{content}</span>}>{nodes}</ErrorBoundary>;
}

// ---------------------------------------------------------------- Users

export function userAvatar(id: string, author?: any, size = 80) {
    const user = UserStore.getUser(id);
    if (user && !author?.bot) return IconUtils.getUserAvatarURL(user, false, size) as string;
    if (author?.avatar) return `${CDN}/avatars/${id}/${author.avatar}.webp?size=${size}`;
    return IconUtils.getDefaultAvatarURL(id, author?.discriminator) as string;
}

export function displayName(id: string, guildId: string | null) {
    const u: any = UserStore.getUser(id);
    return (guildId && GuildMemberStore.getNick(guildId, id)) || u?.globalName || u?.username || "Someone";
}

// ---------------------------------------------------------------- Popout window

/** Prepares a popout document (theme classes, Vencord styles) and keeps its title up to date */
export function usePopoutDocument(rootRef: React.RefObject<HTMLElement | null>, title: string) {
    useLayoutEffect(() => {
        const doc = rootRef.current?.ownerDocument;
        if (!doc || doc === document) return;
        doc.documentElement.className = document.documentElement.className;
        doc.body.classList.add(...Array.from(document.body.classList));
        if (!doc.querySelector("vencord-root")) doc.documentElement.appendChild(vencordRootNode.cloneNode(true));
    }, []);

    useEffect(() => {
        const doc = rootRef.current?.ownerDocument;
        if (doc) doc.title = title;
    }, [title]);
}
