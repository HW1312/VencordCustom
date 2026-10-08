/*
 * MediaGrab – Runs a download (setup → yt-dlp → chat / Downloads) and shows a progress card for it
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Settings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { Channel, CloudUpload as TCloudUpload, Message } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import { Constants, DraftType, RestAPI, SnowflakeUtils, UploadHandler, UserStore } from "@webpack/common";

import type { JobState, SetupState } from "./native";
import { settings } from "./settings";

const Native = VencordNative.pluginHelpers.MediaGrab as PluginNative<typeof import("./native")>;
const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);
const logger = new Logger("MediaGrab");

const MB = 1024 * 1024;
const POLL = 400;

export interface GrabRequest {
    url: string;
    kind: "video" | "audio";
    /** 0 = best */
    maxHeight: number;
    toChat: boolean;
    toDisk: boolean;
    channel?: Channel | null;
    /** Send the file as a message right away instead of only attaching it to the message box */
    sendNow?: boolean;
    /** Reply target when sendNow is used */
    reply?: Message["messageReference"];
}

const MIME: Record<string, string> = {
    mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mov: "video/quicktime",
    mp3: "audio/mpeg", m4a: "audio/mp4", opus: "audio/ogg", ogg: "audio/ogg", wav: "audio/wav"
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const cleanIpcError = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function formatSize(bytes: number) {
    return bytes >= 1024 * MB ? `${(bytes / 1024 / MB).toFixed(2)} GB` : `${(bytes / MB).toFixed(1)} MB`;
}

function formatEta(s: number) {
    if (!s || s < 0) return "";
    return s >= 60 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")} left` : `${Math.ceil(s)} s left`;
}

export function shortUrl(url: string) {
    try {
        const u = new URL(url);
        return (u.hostname.replace(/^www\./, "") + u.pathname).slice(0, 60);
    } catch {
        return url.slice(0, 60);
    }
}

/** TikTok sound pages (tiktok.com/music/…) – there is only audio */
export const isSoundLink = (url: string) => /^https?:\/\/(www\.|m\.)?tiktok\.com\/music\//i.test(url.trim());

export const isUrl = (s: string) => /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(s.trim());

/** Discord's upload limit – same numbers as GofileUpload when it's on, otherwise Discord's defaults (premiumType 2 = Nitro, 1/3 = Classic / Basic) */
function uploadLimit() {
    const premium = UserStore.getCurrentUser()?.premiumType ?? 0;
    const gofile = Settings.plugins.GofileUpload;
    const [free, basic, nitro] = gofile?.enabled
        ? [gofile.limitFree ?? 9.8, gofile.limitBasic ?? 49.8, gofile.limitNitro ?? 499]
        : [10, 50, 500];
    return (premium === 2 ? nitro : premium === 1 || premium === 3 ? basic : free) * MB;
}

/** Uploads the file and sends it as its own message (like Voice Messages does) */
function sendFile(file: File, channelId: string, reply?: Message["messageReference"]) {
    return new Promise<void>((resolve, reject) => {
        const upload = new CloudUpload({ file, isThumbnail: false, platform: CloudUploadPlatform.WEB }, channelId);
        upload.on("complete", () => {
            RestAPI.post({
                url: Constants.Endpoints.MESSAGES(channelId),
                body: {
                    channel_id: channelId,
                    content: "",
                    nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                    sticker_ids: [],
                    type: 0,
                    attachments: [{ id: "0", filename: upload.filename, uploaded_filename: upload.uploadedFilename }],
                    message_reference: reply ?? null
                }
            }).then(() => resolve(), reject);
        });
        upload.on("error", () => reject(new Error("Upload to Discord failed")));
        upload.upload();
    });
}

export function isInstalled() {
    return Native?.isInstalled?.() ?? Promise.resolve(false);
}

// ---------------------------------------------------------------- Running downloads (for the chat bar button)

/** Card id → progress (0–1, -1 = unknown) */
const running = new Map<number, number>();
const listeners = new Set<() => void>();
let nextCard = 0;

function setRunning(id: number, progress: number | null) {
    if (progress == null) running.delete(id);
    else running.set(id, progress);
    listeners.forEach(l => l());
}

export function subscribeRunning(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

/** Number of running downloads and their average progress (-1 if any of them is unknown) */
export function getRunning() {
    const values = [...running.values()];
    const progress = values.some(v => v < 0) ? -1 : values.reduce((a, b) => a + b, 0) / (values.length || 1);
    return { count: values.length, progress };
}

// ---------------------------------------------------------------- Progress cards

function getStack() {
    let stack = document.querySelector<HTMLElement>(".vc-mediagrab-stack");
    if (!stack) {
        stack = document.createElement("div");
        stack.className = "vc-mediagrab-stack";
        document.body.appendChild(stack);
    }
    return stack;
}

function createCard(title: string, onCancel: () => void) {
    const card = document.createElement("div");
    card.className = "vc-mediagrab-card";
    card.innerHTML = `
        <div class="vc-mediagrab-row">
            <div class="vc-mediagrab-name"></div>
            <button class="vc-mediagrab-x" title="Cancel">✕</button>
        </div>
        <div class="vc-mediagrab-status"></div>
        <div class="vc-mediagrab-bar"><div class="vc-mediagrab-fill"></div></div>`;
    const name = card.querySelector<HTMLElement>(".vc-mediagrab-name")!;
    const status = card.querySelector<HTMLElement>(".vc-mediagrab-status")!;
    const fill = card.querySelector<HTMLElement>(".vc-mediagrab-fill")!;
    const x = card.querySelector<HTMLButtonElement>(".vc-mediagrab-x")!;
    name.textContent = title;
    x.onclick = onCancel;
    getStack().appendChild(card);

    const runId = nextCard++;
    setRunning(runId, -1);

    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        card.remove();
        const stack = document.querySelector(".vc-mediagrab-stack");
        if (stack && !stack.childElementCount) stack.remove();
        onClose?.();
    };
    let onClose: (() => void) | undefined;

    return {
        setTitle(text: string) {
            if (text) name.textContent = text;
        },
        update(text: string, progress: number) {
            status.textContent = text;
            card.dataset.indeterminate = String(progress < 0);
            if (progress >= 0) fill.style.width = `${Math.round(progress * 100)}%`;
            setRunning(runId, progress);
        },
        finish(state: "done" | "error", text: string, action?: { label: string; run(): void; }, onClosed?: () => void) {
            setRunning(runId, null);
            card.dataset.state = state;
            card.dataset.indeterminate = "false";
            status.textContent = text;
            fill.style.width = "100%";
            onClose = onClosed;
            x.title = "Close";
            x.onclick = close;
            if (action) {
                const btn = document.createElement("button");
                btn.className = "vc-mediagrab-action";
                btn.textContent = action.label;
                btn.onclick = action.run;
                status.append(" ", btn);
            }
            setTimeout(close, state === "done" ? (action ? 10_000 : 5000) : 15_000);
        }
    };
}

// ---------------------------------------------------------------- Download flow

const SETUP_TEXT: Record<NonNullable<SetupState["step"]>, string> = {
    "yt-dlp": "Installing yt-dlp (one time)",
    ffmpeg: "Installing ffmpeg (one time)",
    extract: "Unpacking ffmpeg …",
    update: "Updating yt-dlp …"
};

const COOKIE_ERROR = /cookie|DPAPI|decrypt/i;

/** yt-dlp's errors are long and technical – shorten the common ones */
function friendlyError(error: string) {
    if (/login required|log in|sign in to confirm|private|age[- ]restrict|confirm your age/i.test(error))
        return "This video needs a login. Set \"Use the login of a browser\" to Firefox in the MediaGrab settings (and log in there).";
    if (/unsupported url/i.test(error)) return "This website isn't supported.";
    if (/HTTP Error 404|not found|unavailable|removed/i.test(error)) return "Video not found – it may have been deleted or made private.";
    return error.replace(/\s*See https?:\/\/\S+ for more info\.?/i, "").replace(/\s*\(caused by .*\)$/, "");
}

function describe(state: JobState) {
    switch (state.phase) {
        case "downloading": {
            // ffmpeg's merge / MP3 step after the last stream prints nothing in quiet mode
            if (state.progress >= 0.999) return "Processing …";
            const parts = [state.progress >= 0 ? `${Math.round(state.progress * 100)}%` : "Downloading …"];
            if (state.speed > 0) parts.push(`${formatSize(state.speed)}/s`);
            const eta = formatEta(state.eta);
            if (eta) parts.push(eta);
            return parts.join(" · ");
        }
        case "merging": return "Merging video and audio …";
        case "converting": return "Converting to MP3 …";
        case "finishing": return "Finishing …";
        case "fetching": return "Opening the TikTok sound …";
        default: return "Fetching video info …";
    }
}

/** The main-process part only loads when Discord starts – Ctrl+R after installing isn't enough */
export const needsRestart = () => !Native?.startGrab;

export async function grab(req: GrabRequest) {
    if (isSoundLink(req.url)) req = { ...req, kind: "audio" };
    let jobId: string | null = null;
    let cancelled = false;
    const label = req.kind === "audio" ? "MP3" : "Video";
    const card = createCard(`${label}: ${shortUrl(req.url)}`, () => {
        cancelled = true;
        if (jobId) Native.cancelGrab(jobId);
    });
    card.update("Starting …", -1);

    if (needsRestart()) {
        card.finish("error", "Quit Discord completely once (tray icon → Quit) and start it again – Ctrl+R is not enough to install MediaGrab.");
        return;
    }

    try {
        // ---- yt-dlp + ffmpeg (first use) and daily yt-dlp update
        const setup = Native.ensureSetup();
        let setupDone = false;
        setup.finally(() => setupDone = true).catch(() => { });
        while (!setupDone) {
            const s = await Native.getSetupState();
            if (s.step) {
                const progress = s.total > 0 ? s.done / s.total : -1;
                const amount = s.total > 0 ? ` · ${formatSize(s.done)} / ${formatSize(s.total)}` : "";
                card.update(SETUP_TEXT[s.step] + amount, progress);
            } else card.update("Preparing …", -1);
            await sleep(POLL);
        }
        await setup;
        if (cancelled) throw new Error("Cancelled");

        // ---- Download. If the browser login can't be read (Chrome locks / encrypts its cookies while it runs),
        // try again without it – most videos don't need a login anyway.
        let cookiesFrom = settings.store.cookiesFrom;
        let note = "";
        let state: JobState | null = null;
        while (true) {
            jobId = await Native.startGrab({
                url: req.url,
                kind: req.kind,
                maxHeight: req.kind === "video" ? req.maxHeight : 0,
                keep: req.toDisk,
                cookiesFrom
            });

            while (true) {
                state = await Native.getJob(jobId);
                if (!state) throw new Error("Download disappeared");
                if (state.title) card.setTitle(`${label}: ${state.title}`);
                if (state.status !== "running") break;
                card.update(note + describe(state), state.phase === "downloading" ? state.progress : -1);
                await sleep(POLL);
            }
            if (state.status !== "error" || cancelled || cookiesFrom === "none" || !COOKIE_ERROR.test(state.error ?? "")) break;

            logger.warn(`Could not read ${cookiesFrom} cookies, retrying without login:`, state.error);
            Native.finishJob(jobId);
            note = `Couldn't use the ${cookiesFrom} login, trying without · `;
            cookiesFrom = "none";
        }
        if (state.status === "error") throw new Error(friendlyError(state.error || "Download failed"));

        const fileName = state.file!;
        const size = formatSize(state.size ?? 0);
        const id = jobId;

        // ---- Into the chat (GofileUpload takes over if the file is too large)
        let sent = false;
        if (req.toChat && req.channel) {
            card.update("Adding to the chat …", -1);
            const bytes = await Native.readResult(id);
            const ext = fileName.split(".").pop()!.toLowerCase();
            const file = new File([bytes as BlobPart], fileName, { type: MIME[ext] ?? "application/octet-stream" });
            // Too large to send directly → the normal way, so GofileUpload can turn it into a link
            if (req.sendNow && file.size <= uploadLimit()) {
                card.update("Sending …", -1);
                try {
                    await sendFile(file, req.channel.id, req.reply);
                    sent = true;
                } catch (e) {
                    // Usually Discord rejecting the size (e.g. the limit is set too high) → let GofileUpload handle it
                    logger.warn("Direct send failed, handing the file to the normal upload", e);
                    UploadHandler.promptToUpload([file], req.channel, DraftType.ChannelMessage);
                }
            } else {
                UploadHandler.promptToUpload([file], req.channel, DraftType.ChannelMessage);
            }
        }

        if (req.toDisk) {
            card.finish("done", `Saved to Downloads · ${size}`, { label: "Show in folder", run: () => Native.showResult(id) }, () => Native.finishJob(id));
        } else {
            Native.finishJob(id);
            card.finish("done", `${sent ? "Sent" : "Added to the chat"} · ${size}`);
        }
    } catch (e) {
        const msg = cancelled ? "Cancelled" : cleanIpcError(e);
        if (!cancelled) logger.error("Download failed", req.url, e);
        if (jobId) Native.finishJob(jobId);
        card.finish("error", msg);
    }
}
