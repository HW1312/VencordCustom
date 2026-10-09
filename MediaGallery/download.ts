/*
 * MediaGallery – Single download & ZIP export of the selection
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";
import { saveFile } from "@utils/web";
import { showToast } from "@webpack/common";
import { Zippable, zipSync } from "fflate";

import type { Author, MediaItem } from "./store";

const Native = VencordNative.pluginHelpers.MediaGallery as PluginNative<typeof import("./native")>;

// ---------------------------------------------------------------- Formatting

export function formatSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

export const formatNumber = (n: number) => n.toLocaleString("en-US");

export function formatDate(ts: number, withTime = false) {
    const d = new Date(ts);
    return withTime
        ? d.toLocaleString("en-US", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
        : d.toLocaleDateString("en-US", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function isoDate(ts: number) {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Removes characters that are not allowed in file names (Windows) */
export function sanitize(name: string) {
    return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^SPOILER_/, "").replace(/[. ]+$/, "").slice(0, 120) || "file";
}

export function zipName(item: MediaItem, author?: Author) {
    return `${isoDate(item.timestamp)}_${sanitize(author?.name ?? item.authorId)}_${sanitize(item.filename)}`;
}

/** URL fetched for the download (embeds: the actual video instead of the preview image) */
function downloadUrl(item: MediaItem) {
    if (item.embed && item.videoUrl) return item.videoUrl;
    return item.url;
}

async function fetchItem(item: MediaItem) {
    const res = await Native.fetchBytes(downloadUrl(item));
    if (!res.ok || !res.data) {
        // Fallback via the media proxy (e.g. if the original URL is no longer reachable)
        if (item.proxyUrl && item.proxyUrl !== item.url && !item.videoUrl) {
            const alt = await Native.fetchBytes(item.proxyUrl);
            if (alt.ok && alt.data) return alt.data;
        }
        throw new Error(res.error || "Download failed");
    }
    return res.data;
}

// ---------------------------------------------------------------- Single file

export async function downloadSingle(item: MediaItem, author?: Author) {
    try {
        const data = await fetchItem(item);
        saveFile(new File([data as BlobPart], zipName(item, author)));
    } catch (e) {
        showToast(`Download failed: ${item.filename}`, "failure");
    }
}

// ---------------------------------------------------------------- ZIP

export interface ZipProgress {
    done: number;
    total: number;
    bytes: number;
    failed: number;
    phase: "download" | "pack";
}

export interface ZipJob {
    cancel(): void;
    promise: Promise<void>;
}

export function downloadZip(
    items: MediaItem[],
    authors: Map<string, Author>,
    archiveName: string,
    onProgress: (p: ZipProgress) => void
): ZipJob {
    let cancelled = false;

    const promise = (async () => {
        const files: Zippable = {};
        const used = new Set<string>();
        const failed: string[] = [];
        const progress: ZipProgress = { done: 0, total: items.length, bytes: 0, failed: 0, phase: "download" };
        onProgress({ ...progress });

        const sorted = [...items].sort((a, b) => a.timestamp - b.timestamp);
        for (const item of sorted) {
            if (cancelled) return;

            let name = zipName(item, authors.get(item.authorId));
            if (used.has(name.toLowerCase())) {
                const dot = name.lastIndexOf(".");
                const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
                let n = 2;
                while (used.has(`${stem}_${n}${ext}`.toLowerCase())) n++;
                name = `${stem}_${n}${ext}`;
            }
            used.add(name.toLowerCase());

            try {
                const data = await fetchItem(item);
                // Media is already compressed → store only (level 0), which is much faster
                files[name] = [data, { level: 0 }];
                progress.bytes += data.byteLength;
            } catch {
                failed.push(`${name}  ←  ${downloadUrl(item)}`);
                progress.failed++;
            }

            progress.done++;
            if (cancelled) return;
            onProgress({ ...progress });
            // Short pause between files to avoid flooding the CDN
            await new Promise(r => setTimeout(r, 150));
        }

        if (cancelled) return;
        if (failed.length) {
            files["_failed.txt"] = new TextEncoder().encode(failed.join("\r\n"));
        }
        if (Object.keys(files).length === (failed.length ? 1 : 0)) {
            showToast("No file could be downloaded", "failure");
            return;
        }

        progress.phase = "pack";
        onProgress({ ...progress });
        await new Promise(r => setTimeout(r, 30));

        const zipped = zipSync(files);
        if (cancelled) return;
        saveFile(new File([zipped as BlobPart], `${sanitize(archiveName)}.zip`, { type: "application/zip" }));

        if (failed.length) showToast(`${failed.length} file(s) could not be downloaded`, "failure");
        else showToast(`${items.length} files saved as ZIP`, "success");
    })();

    return {
        cancel: () => { cancelled = true; },
        promise
    };
}
