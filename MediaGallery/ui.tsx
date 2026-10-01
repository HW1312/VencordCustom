/*
 * MediaGallery – Gallery window, lightbox & settings
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { Switch } from "@components/Switch";
import { classes } from "@utils/misc";
import { useForceUpdater } from "@utils/react";
import { IconComponent } from "@utils/types";
import { Channel, RenderModalProps } from "@vencord/discord-types";
import { Alerts, Modal, NavigationRouter, openModal, useCallback, useEffect, useMemo, useRef, UserStore, useState } from "@webpack/common";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { downloadSingle, downloadZip, formatDate, formatNumber, formatSize, ZipJob, ZipProgress } from "./download";
import { settings } from "./index";
import { Author, ChannelIndex, getIndex, loadPages, MediaItem, MediaKind, resetIndex, subscribe } from "./store";

const cl = classNameFactory("vc-mediagallery-");

// ---------------------------------------------------------------- Icons

const PATHS = {
    gallery: "M4 3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4Zm3 3.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM4 15l3.5-4.5 2.5 3 3.5-4.5L16 13v2H4Zm16-8v10a4 4 0 0 1-4 4H6a2 2 0 0 0 2 2h8a6 6 0 0 0 6-6V9a2 2 0 0 0-2-2Z",
    file: "M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6H6Zm7 1.5L18.5 9H14a1 1 0 0 1-1-1V3.5Z",
    audio: "M20 3v12.5a3.5 3.5 0 1 1-2-3.16V7l-8 1.6v8.9A3.5 3.5 0 1 1 8 14.34V5l12-2Z",
    play: "M8 5.14v13.72a1 1 0 0 0 1.52.85l10.94-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14Z",
    left: "M15.7 5.3a1 1 0 0 1 0 1.4L10.42 12l5.3 5.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.42 0Z",
    right: "M8.3 18.7a1 1 0 0 1 0-1.4l5.28-5.3-5.3-5.3a1 1 0 0 1 1.42-1.4l6 6a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.42 0Z",
    close: "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z",
    check: "M9.2 17.6a1 1 0 0 1-1.4 0l-4.5-4.5a1 1 0 1 1 1.4-1.4l3.8 3.78 9.8-9.8a1 1 0 1 1 1.4 1.42L9.2 17.6Z",
    download: "M12 2a1 1 0 0 1 1 1v10.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V3a1 1 0 0 1 1-1ZM4 19a1 1 0 1 0 0 2h16a1 1 0 1 0 0-2H4Z",
    open: "M14 3a1 1 0 1 0 0 2h3.59l-6.3 6.3a1 1 0 0 0 1.42 1.4L19 6.42V10a1 1 0 1 0 2 0V4a1 1 0 0 0-1-1h-6ZM5 5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 1 0-2 0v5H5V7h5a1 1 0 1 0 0-2H5Z",
    jump: "M10 3a1 1 0 0 1 1 1v6.59l7.3-7.3a1 1 0 1 1 1.4 1.42L12.42 12H19a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM4 14a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z"
};

function Icon({ path, size = 18, className }: { path: string; size?: number; className?: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={classes(cl("icon"), className)}>
            <path fill="currentColor" d={path} />
        </svg>
    );
}

export const GalleryIcon: IconComponent = ({ width = 20, height = 20, className }) => (
    <svg viewBox="0 0 24 24" width={width} height={height} className={className}>
        <path fill="currentColor" d={PATHS.gallery} />
    </svg>
);

// ---------------------------------------------------------------- Helpers

const KIND_LABELS: Record<MediaKind, string> = {
    image: "Images",
    video: "Videos",
    gif: "GIFs",
    file: "Files",
    audio: "Audio"
};
const KINDS = Object.keys(KIND_LABELS) as MediaKind[];

type SortMode = "new" | "old" | "large";
const SORTS: { value: SortMode; label: string; }[] = [
    { value: "new", label: "Newest" },
    { value: "old", label: "Oldest" },
    { value: "large", label: "Largest" }
];

const PROXY_HOSTS = /^(media\.discordapp\.net|images-ext-\d+\.discordapp\.net|cdn\.discordapp\.com)$/;

/** Downscaled thumbnail via the Discord media proxy */
function thumbUrl(item: MediaItem, size: number): string | null {
    if (item.kind === "file" || item.kind === "audio") return null;
    try {
        const u = new URL(item.proxyUrl);
        if (!PROXY_HOSTS.test(u.hostname)) return item.proxyUrl;
        if (u.hostname === "cdn.discordapp.com") u.hostname = "media.discordapp.net";

        const px = Math.round(size * Math.min(window.devicePixelRatio || 1, 2));
        if (item.width && item.height) {
            // Fill the square: shorter side = px, not larger than the original
            const scale = Math.min(1, px / Math.min(item.width, item.height));
            u.searchParams.set("width", String(Math.max(1, Math.round(item.width * scale))));
            u.searchParams.set("height", String(Math.max(1, Math.round(item.height * scale))));
        } else {
            u.searchParams.set("width", String(px));
        }
        // Video attachments: get a still frame from the proxy
        if (item.kind === "video" && !item.embed) u.searchParams.set("format", "jpeg");
        return u.toString();
    } catch {
        return item.proxyUrl;
    }
}

function extensionOf(name: string) {
    const m = /\.([a-z0-9]{1,6})$/i.exec(name);
    return m ? m[1].toUpperCase() : "FILE";
}

function channelTitle(channel: Channel) {
    if (channel.name) return channel.guild_id ? `#${channel.name}` : channel.name;
    const user = UserStore.getUser(channel.recipients?.[0]);
    return user ? `@${(user as any).globalName || user.username}` : "Direct Message";
}

function parseDay(value: string, endOfDay: boolean) {
    if (!value) return null;
    const t = Date.parse(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00"}`);
    return Number.isNaN(t) ? null : t;
}

function useIndex(idx: ChannelIndex) {
    const forceUpdate = useForceUpdater();
    useEffect(() => subscribe(idx, forceUpdate), [idx]);
    return idx.version;
}

function Checkbox({ checked, onClick, className }: { checked: boolean; onClick(e: ReactMouseEvent): void; className?: string; }) {
    return (
        <div
            role="checkbox"
            aria-checked={checked}
            className={classes(cl("check"), checked && cl("check-on"), className)}
            onClick={e => { e.stopPropagation(); onClick(e); }}
        >
            {checked && <Icon path={PATHS.check} size={14} />}
        </div>
    );
}

// ---------------------------------------------------------------- Sender picker

function AuthorPicker({ authors, selected, onChange }: { authors: Author[]; selected: Set<string>; onChange(s: Set<string>): void; }) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (!ref.current?.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", onDown, true);
        return () => document.removeEventListener("mousedown", onDown, true);
    }, [open]);

    const list = useMemo(() => {
        const q = query.trim().toLowerCase();
        return authors
            .filter(a => !q || a.name.toLowerCase().includes(q))
            .sort((a, b) => b.count - a.count);
    }, [authors, query]);

    const label = selected.size === 0
        ? "All senders"
        : selected.size === 1
            ? authors.find(a => selected.has(a.id))?.name ?? "1 sender"
            : `${selected.size} senders`;

    const toggle = (id: string) => {
        const next = new Set(selected);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        onChange(next);
    };

    return (
        <div className={cl("picker")} ref={ref}>
            <button className={classes(cl("button"), selected.size > 0 && cl("button-active"))} onClick={() => setOpen(v => !v)}>
                {label} ▾
            </button>
            {open && (
                <div className={cl("picker-panel")}>
                    <input
                        className={cl("input")}
                        placeholder="Search senders…"
                        value={query}
                        autoFocus
                        onChange={e => setQuery(e.currentTarget.value)}
                    />
                    <div className={cl("picker-list")}>
                        {list.length === 0 && <div className={cl("muted")}>No senders found</div>}
                        {list.map(a => (
                            <div key={a.id} className={cl("picker-item")} onClick={() => toggle(a.id)}>
                                <Checkbox checked={selected.has(a.id)} onClick={() => toggle(a.id)} />
                                <img className={cl("avatar")} src={a.avatarUrl} alt="" />
                                <span className={cl("picker-name")}>{a.name}</span>
                                <span className={cl("muted")}>{formatNumber(a.count)}</span>
                            </div>
                        ))}
                    </div>
                    {selected.size > 0 && (
                        <button className={cl("link")} onClick={() => onChange(new Set())}>Reset selection</button>
                    )}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------- Tile

function Tile({ item, author, selected, selecting, size, onToggle, onOpen }: {
    item: MediaItem;
    author?: Author;
    selected: boolean;
    selecting: boolean;
    size: number;
    onToggle(e: ReactMouseEvent): void;
    onOpen(): void;
}) {
    const [failed, setFailed] = useState(false);
    const thumb = failed ? null : thumbUrl(item, size);

    return (
        <div
            className={classes(cl("tile"), selected && cl("tile-selected"), item.spoiler && cl("tile-spoiler"))}
            onClick={e => (selecting || e.shiftKey || e.ctrlKey || e.metaKey) ? onToggle(e) : onOpen()}
        >
            {thumb
                ? <img className={cl("thumb")} src={thumb} loading="lazy" decoding="async" alt="" draggable={false} onError={() => setFailed(true)} />
                : (
                    <div className={cl("placeholder")}>
                        <Icon path={item.kind === "audio" ? PATHS.audio : PATHS.file} size={34} />
                        <span className={cl("ext")}>{extensionOf(item.filename)}</span>
                    </div>
                )}

            <div className={cl("badges")}>
                {item.kind === "video" && <span className={cl("badge")}><Icon path={PATHS.play} size={12} /></span>}
                {item.kind === "gif" && <span className={cl("badge")}>GIF</span>}
                {item.embed && <span className={cl("badge")}>Link</span>}
                {item.spoiler && <span className={cl("badge")}>Spoiler</span>}
            </div>

            <Checkbox checked={selected} onClick={onToggle} className={cl("tile-check")} />

            <div className={cl("info")}>
                <div className={cl("info-name")}>{item.filename}</div>
                <div className={cl("info-meta")}>
                    {item.size > 0 && <>{formatSize(item.size)} · </>}
                    {author?.name ?? "Unknown"}
                </div>
                <div className={cl("info-meta")}>{formatDate(item.timestamp, true)}</div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- Lightbox

function Lightbox({ items, index, authors, onIndex, onClose, onJump }: {
    items: MediaItem[];
    index: number;
    authors: Map<string, Author>;
    onIndex(i: number): void;
    onClose(): void;
    onJump(item: MediaItem): void;
}) {
    const item = items[index];
    const author = item && authors.get(item.authorId);
    const [busy, setBusy] = useState(false);

    const prev = useCallback(() => index > 0 && onIndex(index - 1), [index]);
    const next = useCallback(() => index < items.length - 1 && onIndex(index + 1), [index, items.length]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
            if (e.key === "ArrowLeft") prev();
            else if (e.key === "ArrowRight") next();
            else if (e.key === "Escape") onClose();
            else return;
            // Do not pass on to Discord (otherwise Escape closes the whole window)
            e.preventDefault();
            e.stopImmediatePropagation();
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [prev, next, onClose]);

    if (!item) return null;

    const download = async () => {
        setBusy(true);
        await downloadSingle(item, author);
        setBusy(false);
    };

    let media: ReactNode;
    if (item.kind === "image") {
        media = <img className={cl("lb-media")} src={item.embed ? item.proxyUrl : item.url} alt={item.filename} />;
    } else if (item.kind === "gif") {
        media = item.videoUrl
            ? <video className={cl("lb-media")} src={item.videoUrl} autoPlay loop muted playsInline />
            : <img className={cl("lb-media")} src={item.embed ? item.proxyUrl : item.url} alt={item.filename} />;
    } else if (item.kind === "video") {
        media = <video key={item.key} className={cl("lb-media")} src={item.videoUrl ?? item.proxyUrl} controls autoPlay playsInline />;
    } else {
        media = (
            <div className={cl("lb-file")}>
                <Icon path={item.kind === "audio" ? PATHS.audio : PATHS.file} size={64} />
                <div className={cl("lb-file-name")}>{item.filename}</div>
                {item.size > 0 && <div className={cl("muted")}>{formatSize(item.size)}</div>}
                {item.kind === "audio" && <audio key={item.key} src={item.proxyUrl} controls className={cl("lb-audio")} />}
            </div>
        );
    }

    return (
        <div className={cl("lightbox")} onClick={onClose}>
            <div className={cl("lb-top")} onClick={e => e.stopPropagation()}>
                {author && <img className={cl("avatar")} src={author.avatarUrl} alt="" />}
                <div className={cl("lb-title")}>
                    <div className={cl("lb-name")}>{item.filename}</div>
                    <div className={cl("muted")}>
                        {author?.name ?? "Unknown"} · {formatDate(item.timestamp, true)}
                        {item.size > 0 && <> · {formatSize(item.size)}</>}
                        {item.width && item.height ? <> · {item.width}×{item.height}</> : null}
                        {" · "}{formatNumber(index + 1)} / {formatNumber(items.length)}
                    </div>
                </div>
                <button className={cl("button")} onClick={() => onJump(item)}>
                    <Icon path={PATHS.jump} size={16} /> Jump to message
                </button>
                <button className={cl("button")} onClick={() => VencordNative.native.openExternal(item.url)}>
                    <Icon path={PATHS.open} size={16} /> Open
                </button>
                <button className={classes(cl("button"), cl("button-primary"))} disabled={busy} onClick={download}>
                    <Icon path={PATHS.download} size={16} /> {busy ? "Loading…" : "Download"}
                </button>
                <button className={cl("icon-button")} onClick={onClose} aria-label="Close">
                    <Icon path={PATHS.close} size={20} />
                </button>
            </div>

            <div className={cl("lb-stage")}>
                <button className={classes(cl("lb-arrow"), cl("lb-arrow-left"))} disabled={index === 0} onClick={e => { e.stopPropagation(); prev(); }}>
                    <Icon path={PATHS.left} size={28} />
                </button>
                <div className={cl("lb-center")} onClick={e => e.stopPropagation()}>{media}</div>
                <button className={classes(cl("lb-arrow"), cl("lb-arrow-right"))} disabled={index >= items.length - 1} onClick={e => { e.stopPropagation(); next(); }}>
                    <Icon path={PATHS.right} size={28} />
                </button>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- Gallery

const PAGE_RENDER = 150;

function Gallery({ channel, onClose }: { channel: Channel; onClose(): void; }) {
    const idx = useMemo(() => getIndex(channel.id, channel.guild_id ?? null), [channel.id]);
    const version = useIndex(idx);
    const { pagesPerClick, thumbSize, zipWarnMb, autoLoad, showEmbeds: showEmbedsDefault } = settings.use(["pagesPerClick", "thumbSize", "zipWarnMb", "autoLoad", "showEmbeds"]);

    // Filter
    const [kinds, setKinds] = useState<Set<MediaKind>>(() => new Set(KINDS));
    const [showEmbeds, setShowEmbeds] = useState(showEmbedsDefault);
    const [authorFilter, setAuthorFilter] = useState<Set<string>>(() => new Set());
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");
    const [query, setQuery] = useState("");
    const [sort, setSort] = useState<SortMode>("new");

    // Selection & view
    const [selection, setSelection] = useState<Set<string>>(() => new Set());
    const lastClicked = useRef<number | null>(null);
    const [lightbox, setLightbox] = useState<number | null>(null);
    const [renderCount, setRenderCount] = useState(PAGE_RENDER);
    const scrollRef = useRef<HTMLDivElement>(null);
    const sentinelRef = useRef<HTMLDivElement>(null);

    // ZIP
    const [zip, setZip] = useState<ZipProgress | null>(null);
    const zipJob = useRef<ZipJob | null>(null);

    // On first open load the newest page; on close cancel running operations
    useEffect(() => {
        if (autoLoad && idx.scanned === 0 && !idx.loading && !idx.done) loadPages(idx, 1);
        return () => {
            idx.cancel?.();
            zipJob.current?.cancel();
        };
    }, [idx]);

    const authors = useMemo(() => [...idx.authors.values()], [version]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        const fromTs = parseDay(from, false);
        const toTs = parseDay(to, true);

        const list = idx.items.filter(i =>
            kinds.has(i.kind)
            && (showEmbeds || !i.embed)
            && (authorFilter.size === 0 || authorFilter.has(i.authorId))
            && (fromTs == null || i.timestamp >= fromTs)
            && (toTs == null || i.timestamp <= toTs)
            && (!q || i.filename.toLowerCase().includes(q))
        );

        if (sort === "new") list.sort((a, b) => b.timestamp - a.timestamp);
        else if (sort === "old") list.sort((a, b) => a.timestamp - b.timestamp);
        else list.sort((a, b) => b.size - a.size || b.timestamp - a.timestamp);
        return list;
    }, [version, kinds, showEmbeds, authorFilter, from, to, query, sort]);

    // Filter changed → start from the top again
    useEffect(() => {
        setRenderCount(PAGE_RENDER);
        lastClicked.current = null;
        scrollRef.current?.scrollTo({ top: 0 });
    }, [kinds, showEmbeds, authorFilter, from, to, query, sort]);

    // Infinite scrolling: render more tiles when the end becomes visible
    useEffect(() => {
        const el = sentinelRef.current;
        if (!el) return;
        const obs = new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting)) setRenderCount(c => c + PAGE_RENDER);
        }, { root: scrollRef.current, rootMargin: "600px" });
        obs.observe(el);
        return () => obs.disconnect();
    }, [renderCount, filtered.length > renderCount]);

    const stats = useMemo(() => {
        let bytes = 0;
        const senders = new Set<string>();
        for (const i of filtered) {
            bytes += i.size;
            senders.add(i.authorId);
        }
        return { count: filtered.length, bytes, senders: senders.size };
    }, [filtered]);

    const selectedItems = useMemo(() => idx.items.filter(i => selection.has(i.key)), [selection, version]);
    const selectedBytes = selectedItems.reduce((s, i) => s + i.size, 0);

    // ---------------------------------------------------------------- Actions

    const toggleItem = (index: number, e: ReactMouseEvent) => {
        const item = filtered[index];
        setSelection(prev => {
            const next = new Set(prev);
            if (e.shiftKey && lastClicked.current != null && filtered[lastClicked.current]) {
                // Select range (state of the clicked item decides on/off)
                const on = !prev.has(item.key);
                const [a, b] = [lastClicked.current, index].sort((x, y) => x - y);
                for (let i = a; i <= b; i++) {
                    if (on) next.add(filtered[i].key);
                    else next.delete(filtered[i].key);
                }
            } else if (next.has(item.key)) next.delete(item.key);
            else next.add(item.key);
            return next;
        });
        lastClicked.current = index;
    };

    const selectAll = () => setSelection(new Set(filtered.map(i => i.key)));
    const clearSelection = () => { setSelection(new Set()); lastClicked.current = null; };

    const toggleKind = (k: MediaKind) => setKinds(prev => {
        const next = new Set(prev);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        return next.size ? next : new Set(KINDS);
    });

    const jumpTo = (item: MediaItem) => {
        onClose();
        NavigationRouter.transitionTo(`/channels/${item.guildId ?? "@me"}/${item.channelId}/${item.messageId}`);
    };

    const reload = () => {
        resetIndex(channel.id);
        onClose();
        openGallery(channel);
    };

    const startZip = () => {
        const items = selectedItems;
        if (!items.length || zipJob.current) return;

        const run = () => {
            const job = downloadZip(items, idx.authors, `${channelTitle(channel).replace(/^[#@]/, "")}_media`, p => setZip(p));
            zipJob.current = job;
            job.promise
                .catch(() => { })
                .finally(() => {
                    if (zipJob.current === job) zipJob.current = null;
                    setZip(null);
                });
        };

        const unknown = items.filter(i => i.size === 0).length;
        if (selectedBytes > zipWarnMb * 1024 * 1024) {
            Alerts.show({
                title: "Large download",
                body: (
                    <div className={cl("alert")}>
                        Your selection contains {formatNumber(items.length)} files totaling {formatSize(selectedBytes)}
                        {unknown > 0 && <> (plus {formatNumber(unknown)} with unknown size)</>}.
                        Everything is collected in memory and then saved as a single ZIP file – this can take a while and use a lot of RAM.
                    </div>
                ),
                confirmText: "Download anyway",
                cancelText: "Cancel",
                onConfirm: run
            });
        } else run();
    };

    const cancelZip = () => {
        zipJob.current?.cancel();
        zipJob.current = null;
        setZip(null);
    };

    // ---------------------------------------------------------------- Rendering

    const selecting = selection.size > 0;
    const loadStatus = idx.loading
        ? idx.rateLimited
            ? `Rate limited – waiting ${idx.rateLimited} s…`
            : `Loading… ${formatNumber(idx.scanned)} messages scanned`
        : idx.done
            ? `Entire history scanned (${formatNumber(idx.scanned)} messages)`
            : `${formatNumber(idx.scanned)} messages scanned`;

    return (
        <div className={cl("root")} style={{ ["--vc-mediagallery-size" as any]: `${thumbSize}px` }}>
            {/* Loading */}
            <div className={cl("bar")}>
                <div className={cl("stats")}>
                    <strong>{formatNumber(stats.count)} files</strong> · {formatSize(stats.bytes)} · {formatNumber(stats.senders)} senders
                </div>
                <div className={cl("spacer")} />
                <span className={cl("muted")}>{idx.loading && <span className={cl("spinner")} />}{loadStatus}</span>
                {idx.loading
                    ? <button className={cl("button")} onClick={() => idx.cancel?.()}>Cancel</button>
                    : !idx.done && (
                        <>
                            <button className={cl("button")} onClick={() => loadPages(idx, pagesPerClick)}>
                                Load more (+{formatNumber(pagesPerClick * 100)})
                            </button>
                            <button className={cl("button")} onClick={() => loadPages(idx, Infinity)}>Load all</button>
                        </>
                    )}
                {!idx.loading && idx.scanned > 0 && (
                    <button className={cl("icon-button")} onClick={reload} title="Discard index and reload">↻</button>
                )}
            </div>
            {idx.error && <div className={cl("error")}>{idx.error}</div>}

            {/* Filter */}
            <div className={cl("bar")}>
                <div className={cl("chips")}>
                    {KINDS.map(k => (
                        <button key={k} className={classes(cl("chip"), kinds.has(k) && cl("chip-on"))} onClick={() => toggleKind(k)}>
                            {KIND_LABELS[k]}
                        </button>
                    ))}
                    <button className={classes(cl("chip"), showEmbeds && cl("chip-on"))} onClick={() => setShowEmbeds(v => !v)} title="Images/videos from link previews">
                        Link-Embeds
                    </button>
                </div>
                <AuthorPicker authors={authors} selected={authorFilter} onChange={setAuthorFilter} />
                <label className={cl("date")}>
                    from <input type="date" className={cl("input")} value={from} max={to || undefined} onChange={e => setFrom(e.currentTarget.value)} />
                </label>
                <label className={cl("date")}>
                    to <input type="date" className={cl("input")} value={to} min={from || undefined} onChange={e => setTo(e.currentTarget.value)} />
                </label>
                <input className={classes(cl("input"), cl("search"))} placeholder="Search file name…" value={query} onChange={e => setQuery(e.currentTarget.value)} />
                <div className={cl("segmented")}>
                    {SORTS.map(s => (
                        <button key={s.value} className={classes(cl("segment"), sort === s.value && cl("segment-on"))} onClick={() => setSort(s.value)}>
                            {s.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Grid */}
            <div className={cl("scroll")} ref={scrollRef}>
                {filtered.length === 0
                    ? (
                        <div className={cl("empty")}>
                            {idx.loading
                                ? "Searching for media…"
                                : idx.items.length
                                    ? "No results for these filters."
                                    : idx.done
                                        ? "There is no media in this channel."
                                        : "No media found yet – load more messages."}
                        </div>
                    )
                    : (
                        <div className={cl("grid")}>
                            {filtered.slice(0, renderCount).map((item, i) => (
                                <Tile
                                    key={item.key}
                                    item={item}
                                    author={idx.authors.get(item.authorId)}
                                    selected={selection.has(item.key)}
                                    selecting={selecting}
                                    size={thumbSize}
                                    onToggle={e => toggleItem(i, e)}
                                    onOpen={() => setLightbox(i)}
                                />
                            ))}
                        </div>
                    )}
                {filtered.length > renderCount && <div ref={sentinelRef} className={cl("sentinel")} />}
            </div>

            {/* Selection */}
            <div className={cl("bar")}>
                {zip
                    ? (
                        <>
                            <div className={cl("progress")}>
                                <div className={cl("progress-fill")} style={{ width: `${zip.total ? (zip.done / zip.total) * 100 : 0}%` }} />
                            </div>
                            <span className={cl("muted")}>
                                {zip.phase === "pack"
                                    ? "Creating ZIP…"
                                    : `${formatNumber(zip.done)} / ${formatNumber(zip.total)} · ${formatSize(zip.bytes)}${zip.failed ? ` · ${zip.failed} failed` : ""}`}
                            </span>
                            <button className={cl("button")} onClick={cancelZip}>Cancel</button>
                        </>
                    )
                    : (
                        <>
                            <span className={cl("muted")}>
                                {selecting
                                    ? `${formatNumber(selection.size)} selected · ${formatSize(selectedBytes)}`
                                    : "Tip: Shift-click selects a range, Ctrl-click selects individual files."}
                            </span>
                            <div className={cl("spacer")} />
                            <button className={cl("button")} disabled={!filtered.length} onClick={selectAll}>Select all</button>
                            {selecting && <button className={cl("button")} onClick={clearSelection}>Clear selection</button>}
                            <button className={classes(cl("button"), cl("button-primary"))} disabled={!selecting} onClick={startZip}>
                                <Icon path={PATHS.download} size={16} /> Download selection
                            </button>
                        </>
                    )}
            </div>

            {lightbox != null && filtered[lightbox] && (
                <Lightbox
                    items={filtered}
                    index={lightbox}
                    authors={idx.authors}
                    onIndex={setLightbox}
                    onClose={() => setLightbox(null)}
                    onJump={jumpTo}
                />
            )}
        </div>
    );
}

function GalleryModal({ modalProps, channel }: { modalProps: RenderModalProps; channel: Channel; }) {
    return (
        <Modal
            {...modalProps}
            size="xxl"
            title="Media Gallery"
            subtitle={channelTitle(channel)}
        >
            <ErrorBoundary>
                <Gallery channel={channel} onClose={modalProps.onClose} />
            </ErrorBoundary>
        </Modal>
    );
}

export function openGallery(channel: Channel) {
    openModal(props => <GalleryModal modalProps={props} channel={channel} />);
}

// ---------------------------------------------------------------- Settings

function Choice<T extends number>({ value, options, onChange }: { value: T; options: { value: T; label: string; }[]; onChange(v: T): void; }) {
    return (
        <div className={cl("segmented")}>
            {options.map(o => (
                <button key={o.value} className={classes(cl("segment"), o.value === value && cl("segment-on"))} onClick={() => onChange(o.value)}>
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode; }) {
    return (
        <div className={cl("option")}>
            <div>
                <div>{label}</div>
                {hint && <div className={cl("muted")}>{hint}</div>}
            </div>
            {children}
        </div>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(() => {
    const s = settings.use(["showChatBarButton", "autoLoad", "showEmbeds", "pagesPerClick", "thumbSize", "zipWarnMb"]);

    return (
        <div className={cl("settings")}>
            <div className={cl("muted")}>
                Open via the gallery button in the chat bar or by right-clicking a channel, thread or DM → "Media Gallery".
                History is loaded throttled (about 1 request per second) and cached for this session.
            </div>
            <Row label="Chat bar button">
                <Switch checked={s.showChatBarButton} onChange={v => settings.store.showChatBarButton = v} />
            </Row>
            <Row label="Load automatically on open" hint="Immediately scans the latest 100 messages.">
                <Switch checked={s.autoLoad} onChange={v => settings.store.autoLoad = v} />
            </Row>
            <Row label="Show link embeds" hint="Images and videos from link previews (Tenor, Twitter …).">
                <Switch checked={s.showEmbeds} onChange={v => settings.store.showEmbeds = v} />
            </Row>
            <Row label="“Load more” scans">
                <Choice
                    value={s.pagesPerClick}
                    options={[{ value: 5, label: "500" }, { value: 10, label: "1,000" }, { value: 25, label: "2,500" }]}
                    onChange={v => settings.store.pagesPerClick = v}
                />
            </Row>
            <Row label="Thumbnails">
                <Choice
                    value={s.thumbSize}
                    options={[{ value: 110, label: "Small" }, { value: 150, label: "Medium" }, { value: 210, label: "Large" }]}
                    onChange={v => settings.store.thumbSize = v}
                />
            </Row>
            <Row label="Warn for ZIPs above">
                <Choice
                    value={s.zipWarnMb}
                    options={[{ value: 250, label: "250 MB" }, { value: 500, label: "500 MB" }, { value: 1000, label: "1 GB" }, { value: 2000, label: "2 GB" }]}
                    onChange={v => settings.store.zipWarnMb = v}
                />
            </Row>
        </div>
    );
}, { noop: true });
