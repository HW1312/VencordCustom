/*
 * ChatPopout – media viewer (like Discord's) and copy/save helpers for images & videos
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyToClipboard } from "@utils/clipboard";
import { classes } from "@utils/misc";
import { showToast, useEffect, useRef, useState } from "@webpack/common";

import { cl, CLOSE_PATH, COPY_PATH, DOWNLOAD_PATH, Icon, LEFT_PATH, log, POPOUT_PATH, RIGHT_PATH, tip, ZOOM_PATH } from "./shared";

export interface MediaItem {
    /** What is displayed (media proxy, unscaled) */
    url: string;
    /** Original file – used for copying links, saving and opening in the browser */
    original: string;
    kind: "image" | "video";
    name?: string;
    width?: number;
    height?: number;
}

export interface MediaMeta {
    author?: string;
    avatar?: string;
    date?: Date;
}

const nativeApi = () => (window as any).DiscordNative;

export function fileName(item: { name?: string; original: string; }) {
    if (item.name) return item.name;
    try {
        return decodeURIComponent(new URL(item.original).pathname.split("/").pop() || "file");
    } catch {
        return "file";
    }
}

/** Data attributes so the context menu knows which media was right-clicked */
export function mediaAttrs(item: MediaItem) {
    return {
        "data-media": item.original,
        "data-media-url": item.url,
        "data-media-kind": item.kind,
        "data-media-name": item.name
    };
}

export function mediaFromElement(el: Element | null): MediaItem | null {
    const host = el?.closest("[data-media]");
    if (!host) return null;
    const original = host.getAttribute("data-media")!;
    return {
        original,
        url: host.getAttribute("data-media-url") || original,
        kind: host.getAttribute("data-media-kind") === "video" ? "video" : "image",
        name: host.getAttribute("data-media-name") || undefined
    };
}

// ---------------------------------------------------------------- Clipboard & files

export async function copyText(text: string, label = "Copied to clipboard") {
    try {
        await copyToClipboard(text);
        showToast(label, "success");
    } catch (e) {
        log.error("Couldn't copy", e);
        showToast("Couldn't copy", "failure");
    }
}

async function fetchBlob(url: string) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
}

/** The clipboard only takes PNG */
async function toPng(blob: Blob): Promise<Blob> {
    if (blob.type === "image/png") return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("PNG conversion failed")), "image/png"));
}

export async function copyImage(item: MediaItem, win: Window) {
    try {
        const png = await toPng(await fetchBlob(item.url));
        const clip = nativeApi()?.clipboard;
        if (typeof clip?.copyImage === "function") {
            clip.copyImage(new Uint8Array(await png.arrayBuffer()), item.original);
        } else {
            const Item = (win as any).ClipboardItem ?? ClipboardItem;
            await win.navigator.clipboard.write([new Item({ "image/png": png })]);
        }
        showToast("Image copied", "success");
    } catch (e) {
        log.error("Couldn't copy image", e);
        showToast("Couldn't copy image", "failure");
    }
}

export async function saveMedia(item: MediaItem, win: Window) {
    const name = fileName(item);
    try {
        const blob = await fetchBlob(item.original).catch(() => fetchBlob(item.url));
        const files = nativeApi()?.fileManager;
        if (typeof files?.saveWithDialog === "function") {
            await files.saveWithDialog(new Uint8Array(await blob.arrayBuffer()), name);
            return;
        }
        const a = win.document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        win.document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            URL.revokeObjectURL(a.href);
            a.remove();
        }, 0);
    } catch (e) {
        log.error("Couldn't save file", e);
        showToast("Couldn't save file", "failure");
    }
}

/** Opens a link in the browser (links with target=_blank leave Discord) */
export function openExternal(url: string, doc: Document) {
    const a = doc.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noreferrer noopener";
    doc.body.appendChild(a);
    a.click();
    a.remove();
}

// ---------------------------------------------------------------- Viewer

function ViewerButton({ path, label, onClick }: { path: string; label: string; onClick(): void; }) {
    return (
        <button className={cl("viewer-btn")} aria-label={label} {...tip(label, "bottom", "end")} onClick={e => { e.stopPropagation(); onClick(); }}>
            <Icon path={path} size={20} />
        </button>
    );
}

export function MediaViewer({ items, index, meta, onClose }: { items: MediaItem[]; index: number; meta?: MediaMeta; onClose(): void; }) {
    const [i, setI] = useState(index);
    const [zoomed, setZoomed] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const item = items[i] ?? items[0];
    const many = items.length > 1;

    const go = (dir: number) => {
        setZoomed(false);
        setI(n => (n + dir + items.length) % items.length);
    };

    useEffect(() => {
        const doc = rootRef.current?.ownerDocument;
        if (!doc) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
            else if (many && e.key === "ArrowLeft") go(-1);
            else if (many && e.key === "ArrowRight") go(1);
            else return;
            e.preventDefault();
            e.stopPropagation();
        };
        doc.addEventListener("keydown", onKey, true);
        return () => doc.removeEventListener("keydown", onKey, true);
    }, [many, items.length]);

    if (!item) return null;
    const win = () => rootRef.current?.ownerDocument?.defaultView ?? window;

    return (
        <div ref={rootRef} className={cl("viewer")} onClick={onClose}>
            <div className={cl("viewer-top")} onClick={e => e.stopPropagation()}>
                <div className={cl("viewer-meta")}>
                    {meta?.avatar && <img className={cl("viewer-avatar")} src={meta.avatar} alt="" />}
                    <div className={cl("viewer-meta-text")}>
                        {meta?.author && <div className={cl("viewer-author")}>{meta.author}</div>}
                        <div className={cl("viewer-sub")}>
                            {[meta?.date?.toLocaleString("en-US"), fileName(item)].filter(Boolean).join(" · ")}
                        </div>
                    </div>
                </div>
                <div className={cl("viewer-actions")}>
                    {item.kind === "image" && <ViewerButton path={ZOOM_PATH} label={zoomed ? "Fit to window" : "Zoom"} onClick={() => setZoomed(z => !z)} />}
                    {item.kind === "image" && <ViewerButton path={COPY_PATH} label="Copy Image" onClick={() => copyImage(item, win())} />}
                    <ViewerButton path={DOWNLOAD_PATH} label="Save" onClick={() => saveMedia(item, win())} />
                    <ViewerButton path={POPOUT_PATH} label="Open in Browser" onClick={() => openExternal(item.original, win().document)} />
                    <ViewerButton path={CLOSE_PATH} label="Close (Esc)" onClick={onClose} />
                </div>
            </div>

            <div className={classes(cl("viewer-stage"), zoomed && cl("viewer-stage-zoomed"))}>
                {item.kind === "video"
                    ? <video key={item.url} className={cl("viewer-media")} src={item.url} controls autoPlay onClick={e => e.stopPropagation()} />
                    : <img
                        key={item.url}
                        className={cl("viewer-media")}
                        src={item.url}
                        alt=""
                        draggable={false}
                        {...mediaAttrs(item)}
                        onClick={e => { e.stopPropagation(); setZoomed(z => !z); }}
                    />}
            </div>

            {many && <>
                <button className={classes(cl("viewer-nav"), cl("viewer-prev"))} aria-label="Previous" onClick={e => { e.stopPropagation(); go(-1); }}>
                    <Icon path={LEFT_PATH} size={24} />
                </button>
                <button className={classes(cl("viewer-nav"), cl("viewer-next"))} aria-label="Next" onClick={e => { e.stopPropagation(); go(1); }}>
                    <Icon path={RIGHT_PATH} size={24} />
                </button>
                <div className={cl("viewer-count")}>{i + 1} / {items.length}</div>
            </>}
        </div>
    );
}
