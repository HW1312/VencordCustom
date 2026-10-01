/*
 * GofileUpload – Vencord Userplugin
 * Files that are too large for Discord are uploaded to gofile.io (Catbox as fallback) instead and the
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
import { showToast, Toasts, UserStore } from "@webpack/common";

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
        description: "Size limit without Nitro (MB) – larger files go to Gofile",
        default: 19.8
    },
    limitBasic: {
        type: OptionType.NUMBER,
        description: "Size limit with Nitro Basic / Classic (MB)",
        default: 49.8
    },
    limitNitro: {
        type: OptionType.NUMBER,
        description: "Size limit with Nitro (MB)",
        default: 999
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
            <button class="vc-gofile-cancel" title="Cancel">✕</button>
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
        showToast("Download link copied to clipboard", Toasts.Type.SUCCESS);
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
        showToast(`Upload failed: ${title}`, Toasts.Type.FAILURE);
    }
}

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "GofileUpload",
    description: "Files that are too large for Discord (19.8 MB without Nitro, 999 MB with Nitro) are uploaded to gofile.io (Catbox as fallback) with metadata stripped, and the link is sent in the chat instead",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Chat", "Utility"],
    settings,

    patches: [
        {
            // UploadHandler.promptToUpload – every way of adding files (drop, paste, + button) goes through it,
            // and it shows the "Your files are too powerful" error. We take the oversized files out before that.
            find: "Unexpected mismatch between files and file metadata",
            replacement: {
                match: /async function \i\((\i),(\i),(\i)\){(?=let\{filesMetadata:)/,
                replace: "$&{const vcKeep=$self.interceptFiles($1,$2,arguments[3]);if(vcKeep!=null){if(!vcKeep.length)return;$1=vcKeep}}"
            }
        }
    ],

    /**
     * Returns null to leave everything to Discord, otherwise the files Discord should still handle itself
     * (the oversized ones are uploaded to Gofile in the background).
     */
    interceptFiles(files: ArrayLike<File> | null, channel: Channel | null, options?: { filesMetadata?: unknown[]; }) {
        try {
            if (!running || !files?.length || !channel) return null;
            const limit = limitBytes();
            if (!limit) return null;

            const list = Array.from(files);
            const big = list.filter(f => f instanceof File && f.size > limit);
            if (!big.length) return null;

            const keep: File[] = [];
            const keepMeta: unknown[] = [];
            list.forEach((f, i) => {
                if (big.includes(f)) return;
                keep.push(f);
                if (options?.filesMetadata) keepMeta.push(options.filesMetadata[i]);
            });
            if (options?.filesMetadata) options.filesMetadata = keepMeta;

            showToast(`${big.length === 1 ? "File is" : `${big.length} files are`} too large for Discord – uploading to a file host`, Toasts.Type.MESSAGE);
            void uploadFiles(big, channel);
            return keep;
        } catch (e) {
            logger.error("interceptFiles failed", e);
            return null;
        }
    },

    start() {
        running = true;
    },

    stop() {
        running = false;
        for (const id of active) void Native.cancelUpload(id).catch(() => { });
        active.clear();
    }
});
