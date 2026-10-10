/*
 * MediaGallery – Gallery window, lightbox & settings
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { useForceUpdater } from "@utils/react";
import { IconComponent } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { NavigationRouter, useCallback, useEffect, useMemo, useRef, UserStore, useState } from "@webpack/common";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { Avatar, Button, confirm, Empty, Icon, IconButton, ICONS, LinkRow, Note, openWindow, Pill, Pills, Popover, Progress, Row, RoundButton, SearchField, Section, Segmented, Sheet, Spinner, TextField, ToggleRow } from "../_ui";
import { downloadSingle, downloadZip, formatDate, formatNumber, formatSize, ZipJob, ZipProgress } from "./download";
import { settings } from "./index";
import { Author, ChannelIndex, getIndex, loadPages, MediaItem, MediaKind, resetIndex, subscribe } from "./store";

const cl = classNameFactory("vc-mediagallery-");

// ---------------------------------------------------------------- Icons

const PATHS = {
    gallery: "M4 3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4Zm3 3.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM4 15l3.5-4.5 2.5 3 3.5-4.5L16 13v2H4Zm16-8v10a4 4 0 0 1-4 4H6a2 2 0 0 0 2 2h8a6 6 0 0 0 6-6V9a2 2 0 0 0-2-2Z",
    file: "M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6H6Zm7 1.5L18.5 9H14a1 1 0 0 1-1-1V3.5Z",
    audio: "M20 3v12.5a3.5 3.5 0 1 1-2-3.16V7l-8 1.6v8.9A3.5 3.5 0 1 1 8 14.34V5l12-2Z",
    jump: "M10 3a1 1 0 0 1 1 1v6.59l7.3-7.3a1 1 0 1 1 1.4 1.42L12.42 12H19a1 1 0 1 1 0 2h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM4 14a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z",
    sender: "M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13Zm8 0c-.29 0-.62.02-.97.05A4.22 4.22 0 0 1 17 16.5V19h6v-2.5c0-2.33-4.67-3.5-7-3.5Z"
};

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

/** Round macOS selection mark */
function Checkbox({ checked, onClick, className }: { checked: boolean; onClick(e: ReactMouseEvent): void; className?: string; }) {
    return (
        <div
            role="checkbox"
            aria-checked={checked}
            className={classes(cl("check"), checked && cl("check-on"), className)}
            onClick={e => { e.stopPropagation(); onClick(e); }}
        >
            {checked && <Icon path={ICONS.check} size={12} />}
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
            <Pill selected={selected.size > 0} icon={PATHS.sender} onClick={() => setOpen(v => !v)}>{label} ▾</Pill>
            {open && (
                <Popover width={300} className={cl("picker-panel")}>
                    <SearchField placeholder="Search senders…" value={query} autoFocus onChange={setQuery} />
                    <div className={cl("picker-list")}>
                        {list.length === 0
                            ? <Empty title="No senders found" />
                            : (
                                <Section>
                                    {list.map(a => (
                                        <Row
                                            key={a.id}
                                            leading={<Avatar src={a.avatarUrl} size={24} />}
                                            title={a.name}
                                            onClick={() => toggle(a.id)}
                                            trailing={<>
                                                <span className={cl("muted")}>{formatNumber(a.count)}</span>
                                                <Checkbox checked={selected.has(a.id)} onClick={() => toggle(a.id)} />
                                            </>}
                                        />
                                    ))}
                                    {selected.size > 0 && <LinkRow onClick={() => onChange(new Set())}>Reset selection</LinkRow>}
                                </Section>
                            )}
                    </div>
                </Popover>
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
                {item.kind === "video" && <span className={cl("badge")}><Icon path={ICONS.play} size={11} /></span>}
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
                {author && <Avatar src={author.avatarUrl} size={32} />}
                <div className={cl("lb-title")}>
                    <div className={cl("lb-name")}>{item.filename}</div>
                    <div className={cl("muted")}>
                        {author?.name ?? "Unknown"} · {formatDate(item.timestamp, true)}
                        {item.size > 0 && <> · {formatSize(item.size)}</>}
                        {item.width && item.height ? <> · {item.width}×{item.height}</> : null}
                        {" · "}{formatNumber(index + 1)} / {formatNumber(items.length)}
                    </div>
                </div>
                <Button variant="gray" small icon={PATHS.jump} onClick={() => onJump(item)}>Jump to message</Button>
                <Button variant="gray" small icon={ICONS.external} onClick={() => VencordNative.native.openExternal(item.url)}>Open</Button>
                <Button small icon={ICONS.download} disabled={busy} onClick={download}>{busy ? "Loading…" : "Download"}</Button>
                <RoundButton icon={ICONS.close} label="Close" onClick={onClose} />
            </div>

            <div className={cl("lb-stage")}>
                <RoundButton icon={ICONS.back} label="Previous" size={44} className={cl("lb-arrow")} disabled={index === 0} onClick={e => { e.stopPropagation(); prev(); }} />
                <div className={cl("lb-center")} onClick={e => e.stopPropagation()}>{media}</div>
                <RoundButton icon={ICONS.chevron} label="Next" size={44} className={cl("lb-arrow")} disabled={index >= items.length - 1} onClick={e => { e.stopPropagation(); next(); }} />
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
            confirm({
                title: "Large download",
                icon: ICONS.download,
                iconColor: "orange",
                body: (
                    <>
                        Your selection contains {formatNumber(items.length)} files totaling {formatSize(selectedBytes)}
                        {unknown > 0 && <> (plus {formatNumber(unknown)} with unknown size)</>}.
                        Everything is collected in memory and then saved as a single ZIP file – this can take a while and use a lot of RAM.
                    </>
                ),
                confirmText: "Download anyway",
                cancelText: "Cancel"
            }).then(ok => ok && run());
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
        <Sheet
            className={cl("sheet")}
            height="min(860px, 88vh)"
            onClose={onClose}
            header={{
                title: "Media Gallery",
                subtitle: channelTitle(channel),
                icon: PATHS.gallery,
                iconColor: "teal",
                actions: !idx.loading && idx.scanned > 0 && <RoundButton icon={ICONS.refresh} label="Discard index and reload" onClick={reload} />
            }}
            top={
                <div className={cl("top")}>
                    {/* Loading */}
                    <div className={cl("bar")}>
                        <div className={cl("stats")}>
                            <strong>{formatNumber(stats.count)} files</strong> · {formatSize(stats.bytes)} · {formatNumber(stats.senders)} senders
                        </div>
                        <div className={cl("spacer")} />
                        <span className={cl("status")}>{idx.loading && <Spinner />}{loadStatus}</span>
                        {idx.loading
                            ? <Button variant="gray" small onClick={() => idx.cancel?.()}>Cancel</Button>
                            : !idx.done && (
                                <>
                                    <Button variant="tinted" small onClick={() => loadPages(idx, pagesPerClick)}>
                                        Load more (+{formatNumber(pagesPerClick * 100)})
                                    </Button>
                                    <Button variant="gray" small onClick={() => loadPages(idx, Infinity)}>Load all</Button>
                                </>
                            )}
                    </div>
                    {idx.error && <Note tone="bad">{idx.error}</Note>}

                    {/* Filter */}
                    <div className={cl("bar")}>
                        <Pills>
                            {KINDS.map(k => (
                                <Pill key={k} selected={kinds.has(k)} onClick={() => toggleKind(k)}>{KIND_LABELS[k]}</Pill>
                            ))}
                            <Pill selected={showEmbeds} onClick={() => setShowEmbeds(v => !v)} title="Images/videos from link previews">Link-Embeds</Pill>
                            <AuthorPicker authors={authors} selected={authorFilter} onChange={setAuthorFilter} />
                        </Pills>
                    </div>
                    <div className={cl("bar")}>
                        <label className={cl("date")}>
                            from <TextField type="date" value={from} max={to || undefined} onChange={setFrom} />
                        </label>
                        <label className={cl("date")}>
                            to <TextField type="date" value={to} min={from || undefined} onChange={setTo} />
                        </label>
                        <SearchField className={cl("search")} placeholder="Search file name…" value={query} onChange={setQuery} />
                        <Segmented<SortMode> small value={sort} options={SORTS} onChange={setSort} />
                    </div>
                </div>
            }
            footer={
                <div className={cl("bar")}>
                    {zip
                        ? (
                            <>
                                <div className={cl("progress")}>
                                    <Progress value={zip.total ? (zip.done / zip.total) * 100 : 0} />
                                </div>
                                <span className={cl("status")}>
                                    {zip.phase === "pack"
                                        ? "Creating ZIP…"
                                        : `${formatNumber(zip.done)} / ${formatNumber(zip.total)} · ${formatSize(zip.bytes)}${zip.failed ? ` · ${zip.failed} failed` : ""}`}
                                </span>
                                <Button variant="gray" small onClick={cancelZip}>Cancel</Button>
                            </>
                        )
                        : (
                            <>
                                <span className={cl("status")}>
                                    {selecting
                                        ? `${formatNumber(selection.size)} selected · ${formatSize(selectedBytes)}`
                                        : "Tip: Shift-click selects a range, Ctrl-click selects individual files."}
                                </span>
                                <div className={cl("spacer")} />
                                <Button variant="gray" small disabled={!filtered.length} onClick={selectAll}>Select all</Button>
                                {selecting && <Button variant="gray" small onClick={clearSelection}>Clear selection</Button>}
                                <Button small icon={ICONS.download} disabled={!selecting} onClick={startZip}>Download selection</Button>
                            </>
                        )}
                </div>
            }
        >
            {/* Grid */}
            <div className={cl("scroll")} ref={scrollRef} style={{ ["--vc-mediagallery-size" as any]: `${thumbSize}px` }}>
                {filtered.length === 0
                    ? (
                        <Empty
                            icon={idx.loading ? undefined : PATHS.gallery}
                            title={idx.loading
                                ? "Searching for media…"
                                : idx.items.length
                                    ? "No results for these filters."
                                    : idx.done
                                        ? "There is no media in this channel."
                                        : "No media found yet – load more messages."}
                        >
                            {idx.loading && <Spinner size={20} />}
                        </Empty>
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
        </Sheet>
    );
}

export function openGallery(channel: Channel) {
    openWindow(close => (
        <ErrorBoundary>
            <Gallery channel={channel} onClose={close} />
        </ErrorBoundary>
    ), { size: "large", className: cl("window") });
}

// ---------------------------------------------------------------- Settings

function Choice<T extends number>({ value, options, onChange }: { value: T; options: { value: T; label: string; }[]; onChange(v: T): void; }) {
    return (
        <Segmented
            small
            value={String(value)}
            options={options.map(o => ({ value: String(o.value), label: o.label }))}
            onChange={v => onChange(Number(v) as T)}
        />
    );
}

export const SettingsPanel = ErrorBoundary.wrap(() => {
    const s = settings.use(["showChatBarButton", "showHeaderButton", "autoLoad", "showEmbeds", "pagesPerClick", "thumbSize", "zipWarnMb"]);

    return (
        <Sheet
            embedded
            header={{
                title: "Media Gallery",
                subtitle: <>
                    Open via the gallery button in the channel header or chat bar, or by right-clicking a channel, thread, DM or message → "Media Gallery".
                    History is loaded throttled (about 1 request per second) and cached for this session.
                </>,
                icon: PATHS.gallery,
                iconColor: "teal"
            }}
        >
            <Section title="Buttons">
                <ToggleRow title="Channel header button" subtitle="Top right next to the pins, also in channels where you can't write." checked={s.showHeaderButton} onChange={v => settings.store.showHeaderButton = v} />
                <ToggleRow title="Chat bar button" checked={s.showChatBarButton} onChange={v => settings.store.showChatBarButton = v} />
            </Section>
            <Section title="Gallery">
                <ToggleRow title="Load automatically on open" subtitle="Immediately scans the latest 100 messages." checked={s.autoLoad} onChange={v => settings.store.autoLoad = v} />
                <ToggleRow title="Show link embeds" subtitle="Images and videos from link previews (Tenor, Twitter …)." checked={s.showEmbeds} onChange={v => settings.store.showEmbeds = v} />
                <Row
                    title="“Load more” scans"
                    trailing={<Choice value={s.pagesPerClick} options={[{ value: 5, label: "500" }, { value: 10, label: "1,000" }, { value: 25, label: "2,500" }]} onChange={v => settings.store.pagesPerClick = v} />}
                />
                <Row
                    title="Thumbnails"
                    trailing={<Choice value={s.thumbSize} options={[{ value: 110, label: "Small" }, { value: 150, label: "Medium" }, { value: 210, label: "Large" }]} onChange={v => settings.store.thumbSize = v} />}
                />
                <Row
                    title="Warn for ZIPs above"
                    trailing={<Choice value={s.zipWarnMb} options={[{ value: 250, label: "250 MB" }, { value: 500, label: "500 MB" }, { value: 1000, label: "1 GB" }, { value: 2000, label: "2 GB" }]} onChange={v => settings.store.zipWarnMb = v} />}
                />
            </Section>
        </Sheet>
    );
}, { noop: true });
