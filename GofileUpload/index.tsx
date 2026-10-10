/*
 * GofileUpload – Vencord Userplugin
 * Images that are too large for Discord are compressed in the renderer first, so they stay normal attachments.
 * Everything that is still too large is uploaded to gofile.io (Catbox as fallback) instead and the
 * download link is sent in the chat where you tried to send them. Metadata is stripped before uploading (same as OpSec).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { definePluginSettings } from "@api/Settings";
import { copyToClipboard } from "@utils/clipboard";
import { insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { showToast, UserStore } from "@webpack/common";

import { ICONS, notify } from "../_ui";
import { randomFilename, stripMetadata } from "../opsec/metadata";
import type { Provider } from "./native";

const logger = new Logger("GofileUpload");

const Native = VencordNative.pluginHelpers.GofileUpload as PluginNative<typeof import("./native")>;

const MB = 1024 * 1024;
const CHUNK_SIZE = 8 * MB;
/** Forum & media channels have no chat to send a link into */
const NO_CHAT_TYPES = new Set([15, 16]);

let running = false;
/** Main-process job ids of running uploads */
const active = new Set<string>();

// ---------------------------------------------------------------- Settings

const settings = definePluginSettings({
    limitFree: {
        type: OptionType.NUMBER,
        description: "Size limit without Nitro (MB) – larger files go to Gofile (Discord allows 10 MB)",
        default: 9.8
    },
    limitBasic: {
        type: OptionType.NUMBER,
        description: "Size limit with Nitro Basic / Classic (MB)",
        default: 49.8
    },
    limitNitro: {
        type: OptionType.NUMBER,
        description: "Size limit with Nitro (MB)",
        default: 499
    },
    autoCompress: {
        type: OptionType.BOOLEAN,
        description: "Compress images that are too large instead of uploading them to Gofile (animated images are never compressed)",
        default: true
    },
    compressFormat: {
        type: OptionType.SELECT,
        description: "Format for compressed images",
        options: [
            { label: "Automatic (JPEG, WebP for images with transparency)", value: "auto", default: true },
            { label: "Always JPEG", value: "jpeg" },
            { label: "Always WebP", value: "webp" }
        ]
    },
    compressQuality: {
        type: OptionType.SLIDER,
        description: "Highest quality to try when compressing (%) – lower values are only used if needed",
        markers: [60, 70, 80, 90, 100],
        default: 92,
        stickToMarkers: false
    },
    preferCatbox: {
        type: OptionType.BOOLEAN,
        description: "Try Catbox first for files up to 200 MB (direct download links) – Gofile becomes the fallback",
        default: false
    },
    stripMetadata: {
        type: OptionType.BOOLEAN,
        description: "Strip metadata (GPS, device, capture time …) from images & videos before uploading",
        default: true
    },
    randomizeName: {
        type: OptionType.BOOLEAN,
        description: "Upload with a random filename (the original name is visible on Gofile otherwise)",
        default: false
    },
    sendMode: {
        type: OptionType.SELECT,
        description: "What to do with the link once the upload is done",
        options: [
            { label: "Send it in the chat automatically", value: "send", default: true },
            { label: "Insert it into the chat box (you press Enter)", value: "insert" },
            { label: "Only copy it to the clipboard", value: "copy" }
        ]
    },
    limitsVersion: {
        type: OptionType.NUMBER,
        description: "",
        default: 0,
        hidden: true
    }
});

/** Discord's premiumType: 0/null = none, 1 = Classic, 2 = Nitro, 3 = Basic */
function limitBytes() {
    const premium = UserStore.getCurrentUser()?.premiumType ?? 0;
    const { limitFree, limitBasic, limitNitro } = settings.store;
    const mb = premium === 2 ? limitNitro : premium === 1 || premium === 3 ? limitBasic : limitFree;
    return Math.max(0, Number(mb) || 0) * MB;
}

function formatSize(bytes: number) {
    return bytes >= 1024 * MB ? `${(bytes / 1024 / MB).toFixed(2)} GB` : `${(bytes / MB).toFixed(1)} MB`;
}

// ---------------------------------------------------------------- Progress cards

function getStack() {
    let stack = document.querySelector<HTMLElement>(".vc-gofile-stack");
    if (!stack) {
        stack = document.createElement("div");
        stack.className = "vc-gofile-stack";
        document.body.appendChild(stack);
    }
    return stack;
}

function createCard(title: string, onCancel: () => void) {
    const card = document.createElement("div");
    card.className = "vc-gofile-card";
    card.innerHTML = `
        <div class="vc-gofile-row">
            <div class="vc-gofile-name"></div>
            <button class="vc-gofile-cancel" title="Cancel" aria-label="Cancel"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="${ICONS.close}"/></svg></button>
        </div>
        <div class="vc-gofile-status"></div>
        <div class="vc-gofile-bar"><div class="vc-gofile-fill"></div></div>`;
    card.querySelector(".vc-gofile-name")!.textContent = title;
    const cancel = card.querySelector<HTMLButtonElement>(".vc-gofile-cancel")!;
    cancel.onclick = onCancel;
    getStack().appendChild(card);

    const status = card.querySelector<HTMLElement>(".vc-gofile-status")!;
    const fill = card.querySelector<HTMLElement>(".vc-gofile-fill")!;

    return {
        update(text: string, progress?: number) {
            status.textContent = text;
            if (progress != null) fill.style.width = `${Math.round(progress * 100)}%`;
        },
        finish(state: "done" | "error", text: string) {
            card.dataset.state = state;
            status.textContent = text;
            fill.style.width = "100%";
            cancel.remove();
            setTimeout(() => {
                card.remove();
                const stack = document.querySelector(".vc-gofile-stack");
                if (stack && !stack.childElementCount) stack.remove();
            }, state === "done" ? 4000 : 8000);
        }
    };
}

// ---------------------------------------------------------------- Hosts (Gofile, Catbox as fallback)

type Host = Provider;
const HOST_NAMES: Record<Host, string> = { gofile: "Gofile", catbox: "Catbox" };

/** Catbox: max 200 MB, and these types are refused (catbox.moe/faq.php) */
const CATBOX_MAX = 200 * MB;
const CATBOX_BLOCKED = /\.(exe|scr|cpl|doc\w*|jar)$/i;

function catboxSkipReason(file: File) {
    if (file.size > CATBOX_MAX) return "over 200 MB";
    const ext = CATBOX_BLOCKED.exec(file.name)?.[0];
    return ext ? `${ext.toLowerCase()} not allowed` : null;
}

function hostOrder(file: File): Host[] {
    if (catboxSkipReason(file)) return ["gofile"];
    return settings.store.preferCatbox ? ["catbox", "gofile"] : ["gofile", "catbox"];
}

interface GofileFolder { token: string; id: string; }

interface HostResult {
    url: string;
    /** Gofile guest folder, so further files land in the same folder (one link) */
    folder?: GofileFolder;
}

class CancelledError extends Error { }

interface UploadHandle {
    cancelled: boolean;
    jobId: string | null;
}

const cleanIpcError = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** Streams the file in chunks into a temp file in the main process (native.ts). Returns the job id. */
async function copyToMain(file: File, handle: UploadHandle, onProgress: (done: number) => void) {
    // Missing when Discord's main process still runs an older Vencord build (only Ctrl+R after installing)
    if (!Native?.beginUpload) throw new Error("Fully quit Discord (also from the tray) and start it again");

    const jobId = await Native.beginUpload();
    handle.jobId = jobId;
    active.add(jobId);

    for (let pos = 0; pos < file.size; pos += CHUNK_SIZE) {
        if (handle.cancelled) throw new CancelledError("Cancelled");
        const chunk = new Uint8Array(await file.slice(pos, pos + CHUNK_SIZE).arrayBuffer());
        await Native.writeChunk(jobId, chunk);
        onProgress(Math.min(pos + CHUNK_SIZE, file.size));
    }
    return jobId;
}

async function sendToHost(jobId: string, host: Host, file: File, folder: GofileFolder | null, handle: UploadHandle, onProgress: (sent: number) => void): Promise<HostResult> {
    const poll = setInterval(async () => {
        const p = await Native.getProgress(jobId).catch(() => null);
        if (p) onProgress(p.sent);
    }, 500);

    try {
        const fields = host === "gofile" && folder ? { token: folder.token, folderId: folder.id } : undefined;
        const body = await Native.uploadTo(jobId, host, file.name, file.type, fields).catch(e => {
            if (handle.cancelled) throw new CancelledError("Cancelled");
            throw new Error(cleanIpcError(e));
        });

        if (host === "catbox") {
            const url = body.trim();
            if (!/^https:\/\/files\.catbox\.moe\/\S+$/.test(url)) throw new Error(url.slice(0, 120) || "unexpected response");
            return { url };
        }

        let res: any;
        try { res = JSON.parse(body); } catch { throw new Error(`unexpected response: ${body.slice(0, 120)}`); }
        const data = res?.data;
        if (res?.status !== "ok" || !data?.downloadPage) throw new Error(res?.status ?? "unexpected response");
        return {
            url: data.downloadPage,
            folder: data.guestToken && data.parentFolder ? { token: data.guestToken, id: data.parentFolder } : undefined
        };
    } finally {
        clearInterval(poll);
    }
}

async function prepareFile(file: File) {
    const { stripMetadata: strip, randomizeName } = settings.store;
    const name = randomizeName ? randomFilename(file.name) : file.name;
    if (strip) {
        try {
            const result = await stripMetadata(file, name);
            if (result) return result.file;
        } catch (e) {
            logger.error("Failed to strip metadata from", file.name, e);
            throw new Error("Could not strip metadata – not uploaded");
        }
    }
    return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
}

function deliverLink(channel: Channel, text: string) {
    const mode = settings.store.sendMode;
    if (mode === "copy" || NO_CHAT_TYPES.has(channel.type)) {
        copyToClipboard(text);
        showToast("Download link copied to clipboard", "success");
    } else if (mode === "insert") {
        insertTextIntoChatInputBox(text);
    } else {
        sendMessage(channel.id, { content: text });
    }
}

/**
 * Uploads the files one after another. Each file tries its hosts in order (Gofile → Catbox by default);
 * Gofile uploads share one folder, so several files usually end up as a single link.
 */
async function uploadFiles(files: File[], channel: Channel) {
    const total = files.reduce((n, f) => n + f.size, 0);
    const title = files.length === 1 ? files[0].name : `${files.length} files`;
    const handle: UploadHandle = { cancelled: false, jobId: null };
    const card = createCard(title, () => {
        handle.cancelled = true;
        if (handle.jobId) void Native.cancelUpload(handle.jobId).catch(() => { });
    });

    try {
        const links: string[] = [];
        let folder: GofileFolder | null = null;
        let sentBefore = 0;

        for (const original of files) {
            if (handle.cancelled) throw new CancelledError("Cancelled");

            card.update(settings.store.stripMetadata ? "Stripping metadata …" : "Preparing …", sentBefore / total);
            const file = await prepareFile(original);
            if (handle.cancelled) throw new CancelledError("Cancelled");

            // Progress bar: copying to the main process counts 10 %, the upload 90 %
            const show = (text: string, fileProgress: number) => card.update(text, (sentBefore + fileProgress * original.size) / total);
            const part = (n: number) => Math.min(n, file.size) / (file.size || 1);

            let jobId: string | null = null;
            try {
                jobId = await copyToMain(file, handle, n => show("Preparing upload …", part(n) * 0.1));

                const order = hostOrder(file);
                const errors: string[] = [];
                let result: HostResult | null = null;

                for (const [i, host] of order.entries()) {
                    if (handle.cancelled) throw new CancelledError("Cancelled");
                    const name = HOST_NAMES[host];
                    try {
                        result = await sendToHost(jobId, host, file, folder, handle, n =>
                            show(`Uploading to ${name} … ${formatSize(sentBefore + part(n) * original.size)} / ${formatSize(total)}`, 0.1 + part(n) * 0.9));
                        break;
                    } catch (e) {
                        if (handle.cancelled || e instanceof CancelledError) throw new CancelledError("Cancelled");
                        logger.warn(`${name} upload failed`, e);
                        errors.push(`${name}: ${e instanceof Error ? e.message : e}`);
                        const next = order[i + 1];
                        if (next) show(`${name} failed – trying ${HOST_NAMES[next]} …`, 0.1);
                    }
                }

                if (!result) {
                    const skip = catboxSkipReason(file);
                    if (skip) errors.push(`Catbox skipped (${skip})`);
                    throw new Error(errors.join(" · "));
                }

                if (result.folder && !folder) {
                    folder = result.folder;
                    links.push(result.url);
                } else if (!result.folder || result.folder.id !== folder?.id) {
                    // Catbox link, or Gofile didn't give us a folder to share
                    if (!links.includes(result.url)) links.push(result.url);
                }
            } finally {
                if (jobId) {
                    active.delete(jobId);
                    void Native.discardUpload(jobId).catch(() => { });
                }
                handle.jobId = null;
            }
            sentBefore += original.size;
        }

        const label = files.length === 1
            ? `**${files[0].name.replace(/[*_~`|\\]/g, "\\$&")}** (${formatSize(total)})`
            : `**${files.length} files** (${formatSize(total)})`;
        deliverLink(channel, `📎 ${label}\n${links.join("\n")}`);
        card.finish("done", "Uploaded");
    } catch (e) {
        if (e instanceof CancelledError) {
            card.finish("error", "Cancelled");
            return;
        }
        logger.error("Upload failed", e);
        card.finish("error", `Failed – ${e instanceof Error ? e.message : e}`);
        notify({ title: "Upload failed", body: title, kind: "error", app: "GofileUpload" });
    }
}

/**
 * For SecretChat: uploads an already encrypted file with the progress card and returns the link instead of sending
 * it. Catbox first (direct link – the chat can load and decrypt it right away), Gofile as fallback.
 * null = cancelled or failed (the card says why).
 */
export async function uploadForLink(file: File, title: string): Promise<{ url: string; host: Host; } | null> {
    const handle: UploadHandle = { cancelled: false, jobId: null };
    const card = createCard(title, () => {
        handle.cancelled = true;
        if (handle.jobId) void Native.cancelUpload(handle.jobId).catch(() => { });
    });
    const part = (n: number) => Math.min(n, file.size) / (file.size || 1);
    let jobId: string | null = null;

    try {
        card.update("Preparing upload …", 0);
        jobId = await copyToMain(file, handle, n => card.update("Preparing upload …", part(n) * 0.1));

        const order: Host[] = catboxSkipReason(file) ? ["gofile"] : ["catbox", "gofile"];
        const errors: string[] = [];
        for (const host of order) {
            if (handle.cancelled) throw new CancelledError("Cancelled");
            const name = HOST_NAMES[host];
            try {
                const { url } = await sendToHost(jobId, host, file, null, handle, n =>
                    card.update(`Uploading to ${name} … ${formatSize(part(n) * file.size)} / ${formatSize(file.size)}`, 0.1 + part(n) * 0.9));
                card.finish("done", "Uploaded – the link is sent encrypted");
                return { url, host };
            } catch (e) {
                if (handle.cancelled || e instanceof CancelledError) throw new CancelledError("Cancelled");
                logger.warn(`${name} upload failed`, e);
                errors.push(`${name}: ${e instanceof Error ? e.message : e}`);
            }
        }
        throw new Error(errors.join(" · "));
    } catch (e) {
        if (!(e instanceof CancelledError)) logger.error("Upload failed", e);
        card.finish("error", e instanceof CancelledError ? "Cancelled" : `Failed – ${e instanceof Error ? e.message : e}`);
        return null;
    } finally {
        if (jobId) {
            active.delete(jobId);
            void Native.discardUpload(jobId).catch(() => { });
        }
    }
}

// ---------------------------------------------------------------- Auto-compress (images)

const COMPRESSIBLE = /^image\/(jpeg|png|webp|bmp)$/;
const COMPRESSIBLE_EXT = /\.(jpe?g|jfif|png|webp|bmp)$/i;
/** Inputs bigger than this aren't decoded at all (memory) – they go to Gofile */
const COMPRESS_MAX_INPUT = 150 * MB;
/** Decoded images are first scaled down to at most this many pixels */
const MAX_PIXELS = 40_000_000;
/** Never scale the long side below this (unless the image already is smaller) */
const MIN_LONG_SIDE = 1280;
/** Stay a bit below the limit */
const SAFETY = 0.98;
const MAX_ENCODES = 16;

function isCompressible(file: File) {
    if (!(file instanceof File) || file.size > COMPRESS_MAX_INPUT) return false;
    return COMPRESSIBLE.test(file.type) || (!file.type && COMPRESSIBLE_EXT.test(file.name));
}

interface ImageInfo {
    kind: "jpeg" | "png" | "webp" | "bmp";
    animated: boolean;
    alpha: boolean;
}

const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len));
const readBytes = async (file: File, start: number, end: number) => new Uint8Array(await file.slice(start, end).arrayBuffer());

/** Sniffs the real format from the magic bytes and detects animation / transparency where the header tells us. */
async function inspectImage(file: File): Promise<ImageInfo | null> {
    const head = await readBytes(file, 0, 64);
    if (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) return { kind: "jpeg", animated: false, alpha: false };
    if (ascii(head, 0, 2) === "BM") return { kind: "bmp", animated: false, alpha: false };

    if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") {
        const chunk = ascii(head, 12, 4);
        if (chunk === "VP8X") {
            const flags = head[20];
            return { kind: "webp", animated: (flags & 0x02) !== 0, alpha: (flags & 0x10) !== 0 };
        }
        // VP8L (lossless) can carry alpha, simple VP8 can't
        return { kind: "webp", animated: false, alpha: chunk === "VP8L" };
    }

    if (head[0] === 0x89 && ascii(head, 1, 3) === "PNG") {
        // IHDR colour type 4 / 6 = has an alpha channel
        let alpha = head[25] === 4 || head[25] === 6;
        let animated = false;
        // Walk the chunks up to the first IDAT: acTL (APNG) and tRNS must come before it
        let pos = 8;
        for (let i = 0; i < 200 && pos + 8 <= file.size; i++) {
            const h = await readBytes(file, pos, pos + 8);
            const len = new DataView(h.buffer).getUint32(0);
            const type = ascii(h, 4, 4);
            if (type === "IDAT" || type === "IEND") break;
            if (type === "acTL") animated = true;
            if (type === "tRNS") alpha = true;
            pos += 12 + len;
        }
        return { kind: "png", animated, alpha };
    }

    return null;
}

function outputType(info: ImageInfo): { mime: string; ext: string; } {
    const format = settings.store.compressFormat;
    const webp = format === "webp" || (format !== "jpeg" && (info.alpha || info.kind === "webp"));
    return webp ? { mime: "image/webp", ext: ".webp" } : { mime: "image/jpeg", ext: ".jpg" };
}

function renameExt(name: string, ext: string) {
    const base = name.replace(/\.[^./\\]*$/, "");
    return (base || "image") + ext;
}

function makeCanvas(w: number, h: number) {
    if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
}

function encodeCanvas(canvas: OffscreenCanvas | HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
    if (canvas instanceof HTMLCanvasElement) return new Promise(res => canvas.toBlob(res, type, quality));
    return canvas.convertToBlob({ type, quality });
}

/**
 * Re-encodes an image through a canvas (this also drops all metadata) until it fits under `limit`:
 * first lower quality steps, then smaller sizes. Returns null if it can't get small enough.
 */
async function compressImage(file: File, limit: number): Promise<File | null> {
    const info = await inspectImage(file);
    if (!info || info.animated) return null;

    const { mime, ext } = outputType(info);
    const opaque = mime === "image/jpeg";
    const target = limit * SAFETY;
    const maxQ = Math.min(1, Math.max(0.5, (Number(settings.store.compressQuality) || 92) / 100));
    const qualities = [...new Set([maxQ, 0.85, 0.75, 0.65].filter(q => q <= maxQ))];

    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
        const { width, height } = bitmap;
        if (!width || !height) return null;
        const longSide = Math.max(width, height);
        const minScale = Math.min(1, MIN_LONG_SIDE / longSide);
        let scale = Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)));
        let encodes = 0;

        while (encodes < MAX_ENCODES) {
            const w = Math.max(1, Math.round(width * scale));
            const h = Math.max(1, Math.round(height * scale));
            const canvas = makeCanvas(w, h);
            const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
            if (!ctx) return null;
            if (opaque) {
                // JPEG has no alpha – transparent pixels would turn black otherwise
                ctx.fillStyle = "#fff";
                ctx.fillRect(0, 0, w, h);
            }
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(bitmap, 0, 0, w, h);

            let smallest = Infinity;
            try {
                for (const q of qualities) {
                    if (encodes++ >= MAX_ENCODES) return null;
                    const blob = await encodeCanvas(canvas, mime, q);
                    // Chromium silently falls back to PNG for types it can't encode
                    if (!blob || blob.type !== mime) return null;
                    if (blob.size <= target) {
                        return new File([blob], renameExt(file.name, ext), { type: mime, lastModified: file.lastModified });
                    }
                    smallest = Math.min(smallest, blob.size);
                }
            } finally {
                // Free the canvas memory right away
                canvas.width = canvas.height = 0;
            }

            if (scale <= minScale) return null;
            // File size scales roughly with the pixel count
            const factor = Math.min(0.85, Math.max(0.5, Math.sqrt(target / smallest) * 0.95));
            scale = Math.max(minScale, scale * factor);
        }
        return null;
    } finally {
        bitmap.close();
    }
}

/** Compresses the oversized compressible images in `list` (in place). Never throws. */
async function compressOversized(list: File[], limit: number) {
    const done: { name: string; from: number; to: number; }[] = [];
    for (const [i, f] of list.entries()) {
        if (!(f instanceof File) || f.size <= limit || !isCompressible(f)) continue;
        try {
            const out = await compressImage(f, limit);
            if (out) {
                list[i] = out;
                done.push({ name: f.name, from: f.size, to: out.size });
            } else {
                logger.info("Could not compress", f.name, "under the limit – uploading to a file host");
            }
        } catch (e) {
            logger.error("Failed to compress", f.name, e);
        }
    }

    if (done.length === 1) {
        const [d] = done;
        notify({ title: `Compressed ${d.name}`, body: `${formatSize(d.from)} → ${formatSize(d.to)}`, kind: "success", app: "GofileUpload" });
    } else if (done.length > 1) {
        const from = done.reduce((n, d) => n + d.from, 0);
        const to = done.reduce((n, d) => n + d.to, 0);
        notify({ title: `Compressed ${done.length} images`, body: `${formatSize(from)} → ${formatSize(to)}`, kind: "success", app: "GofileUpload" });
    }
}

/**
 * Takes the files over the limit out of `list` and uploads them to a file host in the background.
 * Returns the files Discord should still handle itself (keeps filesMetadata in sync).
 */
function splitOff(list: File[], limit: number, channel: Channel, options?: { filesMetadata?: unknown[]; }) {
    const big = list.filter(f => f instanceof File && f.size > limit);
    if (!big.length) return list;

    const keep: File[] = [];
    const keepMeta: unknown[] = [];
    list.forEach((f, i) => {
        if (big.includes(f)) return;
        keep.push(f);
        if (options?.filesMetadata) keepMeta.push(options.filesMetadata[i]);
    });
    if (options?.filesMetadata) options.filesMetadata = keepMeta;

    notify({ title: `${big.length === 1 ? "File is" : `${big.length} files are`} too large for Discord`, body: "Uploading to a file host", kind: "info", app: "GofileUpload" });
    void uploadFiles(big, channel);
    return keep;
}

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "GofileUpload",
    description: "Files that are too large for Discord (19.8 MB without Nitro, 999 MB with Nitro) are uploaded to gofile.io (Catbox as fallback) with metadata stripped, and the link is sent in the chat instead. Oversized images are compressed first so they stay normal attachments",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Chat", "Utility"],
    settings,

    patches: [
        {
            // UploadHandler.promptToUpload – every way of adding files (drop, paste, + button) goes through it,
            // and it shows the "Your files are too powerful" error. We compress / take the oversized files out before that.
            // The function is async, so we can await the compression before Discord sees (and uploads) the files.
            find: "Unexpected mismatch between files and file metadata",
            replacement: {
                // SecretChat's block (/*vcSC*/…/*vcSC*/) may already sit there – it stays first
                match: /async function \i\((\i),(\i),(\i)\){(?:\/\*vcSC\*\/.*?\/\*vcSC\*\/)?(?=let\{filesMetadata:)/,
                replace: "$&{let vcKeep=$self.interceptFiles($1,$2,arguments[3]);if(vcKeep instanceof Promise)vcKeep=await vcKeep;if(vcKeep!=null){if(!vcKeep.length)return;$1=vcKeep}}"
            }
        }
    ],

    /**
     * Returns null to leave everything to Discord, otherwise the files Discord should still handle itself
     * (oversized images are compressed first, the remaining oversized files are uploaded to Gofile in the background).
     * Returns a Promise only when images need compressing – that Promise never rejects.
     */
    interceptFiles(files: ArrayLike<File> | null, channel: Channel | null, options?: { filesMetadata?: unknown[]; }): File[] | null | Promise<File[] | null> {
        try {
            if (!running || !files?.length || !channel) return null;
            const limit = limitBytes();
            if (!limit) return null;

            const list = Array.from(files);
            const big = list.filter(f => f instanceof File && f.size > limit);
            if (!big.length) return null;

            if (settings.store.autoCompress && big.some(isCompressible)) {
                return (async () => {
                    try {
                        const compressed = [...list];
                        await compressOversized(compressed, limit);
                        return splitOff(compressed, limit, channel, options);
                    } catch (e) {
                        logger.error("Auto-compress failed, falling back to the file host", e);
                        try {
                            return splitOff(list, limit, channel, options);
                        } catch (e2) {
                            logger.error("interceptFiles failed", e2);
                            return null;
                        }
                    }
                })();
            }

            return splitOff(list, limit, channel, options);
        } catch (e) {
            logger.error("interceptFiles failed", e);
            return null;
        }
    },

    start() {
        running = true;
        // Discord lowered its limits (free 25 → 10 MB, Nitro → 500 MB) – fix values saved from the old defaults once
        const s = settings.store;
        if (s.limitsVersion < 1) {
            if (s.limitFree > 10) s.limitFree = 9.8;
            if (s.limitNitro > 500) s.limitNitro = 499;
            s.limitsVersion = 1;
        }
    },

    stop() {
        running = false;
        for (const id of active) void Native.cancelUpload(id).catch(() => { });
        active.clear();
    }
});
