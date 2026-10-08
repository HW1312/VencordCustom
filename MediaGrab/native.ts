/*
 * MediaGrab – runs in the Electron main process
 * Downloads videos / audio from TikTok, YouTube, Instagram, X, Reddit … with yt-dlp. yt-dlp and ffmpeg are
 * fetched from GitHub on first use into Discord's userData folder (ffmpeg merges YouTube's separate video and
 * audio streams and converts to MP3). The renderer only ever passes job ids around, never paths.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChildProcess, execFile, spawn } from "child_process";
import { randomBytes } from "crypto";
import { app, BrowserWindow, IpcMainInvokeEvent, session, shell } from "electron";
import { createWriteStream, existsSync, promises as fs } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

const WIN = process.platform === "win32";
const EXE = WIN ? ".exe" : "";
const BIN_DIR = join(app.getPath("userData"), "MediaGrab");
const YTDLP = join(BIN_DIR, "yt-dlp" + EXE);
/** Folder with ffmpeg, ffprobe (and on Windows their DLLs – the "shared" build is 84 MB instead of 190) */
const FFMPEG_DIR = join(BIN_DIR, "ffmpeg");
const FFMPEG = join(FFMPEG_DIR, "ffmpeg" + EXE);
const UPDATE_STAMP = join(BIN_DIR, "last-update");

const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/"
    + (WIN ? "yt-dlp.exe" : process.platform === "darwin" ? "yt-dlp_macos" : "yt-dlp_linux");
/** yt-dlp's own ffmpeg builds (patched for yt-dlp). No macOS build – there we use ffmpeg from PATH. */
const FFMPEG_URL = WIN
    ? "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip"
    : process.platform === "linux"
        ? "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
        : null;

const DAY = 24 * 60 * 60 * 1000;
/** Files above this are not handed to the renderer (would have to go through IPC in one piece) */
const MAX_READ = 1024 * 1024 * 1024;

// ---------------------------------------------------------------- Setup (yt-dlp + ffmpeg)

export interface SetupState {
    step: "yt-dlp" | "ffmpeg" | "extract" | "update" | null;
    done: number;
    total: number;
}

let setupState: SetupState = { step: null, done: 0, total: 0 };
let setupPromise: Promise<void> | null = null;

async function download(url: string, dest: string) {
    const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Vencord-MediaGrab" } });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    setupState.total = Number(res.headers.get("content-length")) || 0;
    setupState.done = 0;

    const tmp = dest + ".part";
    const body = Readable.fromWeb(res.body as any);
    body.on("data", (c: Buffer) => { setupState.done += c.length; });
    await pipeline(body, createWriteStream(tmp));
    await fs.rename(tmp, dest);
}

function run(file: string, args: string[], timeout: number) {
    return new Promise<string>((resolve, reject) => {
        execFile(file, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error(String(stderr || err.message).trim().split("\n").pop()));
            else resolve(stdout);
        });
    });
}

async function findFile(dir: string, name: string): Promise<string | null> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = await findFile(full, name);
            if (found) return found;
        } else if (entry.name === name) return full;
    }
    return null;
}

async function installFfmpeg() {
    if (!FFMPEG_URL) return;
    const archive = join(BIN_DIR, basename(FFMPEG_URL));
    const out = join(BIN_DIR, "ffmpeg-extract");

    setupState.step = "ffmpeg";
    await download(FFMPEG_URL, archive);

    setupState.step = "extract";
    await fs.rm(out, { recursive: true, force: true });
    await fs.mkdir(out, { recursive: true });
    try {
        // bsdtar ships with Windows 10+ and reads zip; GNU tar on Linux reads .tar.xz
        await run(WIN ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar", ["-xf", archive, "-C", out], 5 * 60_000);
        // The archive has <name>/bin/ffmpeg(.exe), ffprobe and the DLLs – keep that bin folder
        const found = await findFile(out, "ffmpeg" + EXE);
        if (!found) throw new Error("ffmpeg missing in the archive");
        await fs.rm(FFMPEG_DIR, { recursive: true, force: true });
        await fs.rename(dirname(found), FFMPEG_DIR);
        if (!WIN) for (const name of ["ffmpeg", "ffprobe"]) await fs.chmod(join(FFMPEG_DIR, name), 0o755).catch(() => { });
    } finally {
        await fs.rm(out, { recursive: true, force: true }).catch(() => { });
        await fs.rm(archive, { force: true }).catch(() => { });
    }
}

/** yt-dlp breaks whenever a site changes, so update it once a day */
async function updateIfOld() {
    const last = Number(await fs.readFile(UPDATE_STAMP, "utf8").catch(() => "0")) || 0;
    if (Date.now() - last < DAY) return;
    setupState = { step: "update", done: 0, total: 0 };
    await run(YTDLP, ["-U"], 90_000).catch(() => { });
    await fs.writeFile(UPDATE_STAMP, String(Date.now())).catch(() => { });
}

async function doSetup() {
    await fs.mkdir(BIN_DIR, { recursive: true });
    if (!existsSync(YTDLP)) {
        setupState.step = "yt-dlp";
        await download(YTDLP_URL, YTDLP);
        if (!WIN) await fs.chmod(YTDLP, 0o755);
        await fs.writeFile(UPDATE_STAMP, String(Date.now()));
    }
    if (FFMPEG_URL && !existsSync(FFMPEG)) await installFfmpeg();
    await updateIfOld();
}

/** Makes sure yt-dlp + ffmpeg are there (downloads them once). Concurrent calls share one run. */
export async function ensureSetup(_: IpcMainInvokeEvent) {
    setupPromise ??= doSetup().finally(() => {
        setupPromise = null;
        setupState = { step: null, done: 0, total: 0 };
    });
    await setupPromise;
}

export function getSetupState(_: IpcMainInvokeEvent) {
    return setupState;
}

export function isInstalled(_: IpcMainInvokeEvent) {
    return existsSync(YTDLP) && (!FFMPEG_URL || existsSync(FFMPEG));
}

// ---------------------------------------------------------------- Downloads

export interface GrabOptions {
    url: string;
    kind: "video" | "audio";
    /** Max video height, 0 = best */
    maxHeight: number;
    /** true → Downloads folder, false → temp folder (only goes to the chat) */
    keep: boolean;
    cookiesFrom: string;
}

export interface JobState {
    status: "running" | "done" | "error";
    /** 0–1, -1 = unknown */
    progress: number;
    /** "downloading", "merging", "converting" … */
    phase: string;
    speed: number;
    eta: number;
    title: string;
    file?: string;
    size?: number;
    error?: string;
}

interface Job {
    state: JobState;
    proc?: ChildProcess;
    path?: string;
    dir: string;
    keep: boolean;
    cancelled: boolean;
    /** Stops a download that doesn't run through yt-dlp (TikTok sounds) */
    abort?(): void;
}

const jobs = new Map<string, Job>();
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{16}$/.test(id);
const COOKIE_BROWSERS = new Set(["firefox", "chrome", "edge", "brave", "opera", "vivaldi"]);

function buildArgs(opts: GrabOptions, dir: string) {
    const args = [
        // YouTube needs a JS runtime for all formats; uses Node if it's installed (otherwise only a warning, max ~1080p)
        "--js-runtimes", "node",
        "--no-playlist", "--newline", "--progress", "--no-colors", "--no-mtime",
        "--windows-filenames", "--trim-filenames", "120",
        "--progress-template", "download:VCPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s",
        // As JSON (\u escapes): yt-dlp's stdout on Windows mangles emoji / curly quotes, then the path wouldn't match
        "--print", "before_dl:VCTITLE %(title)j",
        "--print", "after_move:VCFILE %(filepath)j",
        "--no-simulate",
        "-P", dir,
        "-o", "%(title).90B [%(id)s].%(ext)s"
    ];
    if (FFMPEG_URL) args.push("--ffmpeg-location", FFMPEG_DIR);
    if (COOKIE_BROWSERS.has(opts.cookiesFrom)) args.push("--cookies-from-browser", opts.cookiesFrom);

    if (opts.kind === "audio") {
        args.push("-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0", "--embed-metadata", "--embed-thumbnail");
    } else {
        // H.264 + AAC in MP4 so Discord can play it inline (TikTok also offers HEVC, YouTube VP9/AV1).
        // The codec comes before the resolution, otherwise TikTok's 720p HEVC wins over 540p H.264.
        const res = opts.maxHeight > 0 ? `,res:${Math.floor(opts.maxHeight)}` : "";
        args.push("-f", "bv*+ba/b", "-S", `vcodec:h264${res},acodec:aac,ext:mp4:m4a`, "--merge-output-format", "mp4");
    }
    args.push("--", opts.url);
    return args;
}

const num = (s: string) => (s && s !== "NA" && s !== "None" ? Number(s) : NaN);

function json(s: string) {
    try {
        const v = JSON.parse(s);
        return typeof v === "string" ? v : "";
    } catch {
        return "";
    }
}

function handleLine(job: Job, line: string) {
    const { state } = job;
    if (line.startsWith("VCPROG ")) {
        const [done, total, estimate, speed, eta] = line.slice(7).split(" ").map(num);
        const size = total || estimate;
        state.phase = "downloading";
        state.progress = size > 0 ? Math.min(1, done / size) : -1;
        state.speed = speed || 0;
        state.eta = eta || 0;
    } else if (line.startsWith("VCTITLE ")) {
        state.title = json(line.slice(8));
    } else if (line.startsWith("VCFILE ")) {
        job.path = json(line.slice(7)) || undefined;
    } else if (line.startsWith("[Merger]")) {
        state.phase = "merging";
        state.progress = -1;
    } else if (line.startsWith("[ExtractAudio]")) {
        state.phase = "converting";
        state.progress = -1;
    } else if (/^\[(EmbedThumbnail|Metadata)\]/.test(line)) {
        state.phase = "finishing";
    }
}

// ---------------------------------------------------------------- TikTok sounds (tiktok.com/music/…)
// yt-dlp's extractor for these is broken, and TikTok's API only answers signed requests. So a hidden window opens
// the page, TikTok's own code makes the signed request, and we repeat exactly that request (its URL is in the
// page's performance entries) from inside the page. The answer contains a direct MP3 link that works without login.
// (Reading the answer via the DevTools protocol crashed Electron's network service.)

const TIKTOK_SOUND = /^https?:\/\/(?:www\.|m\.)?tiktok\.com\/music\/[^?#]*?(\d{8,})/i;
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const SOUND_PARTITION = "mediagrab-tiktok";
let soundSessionReady = false;

interface TikTokSound { title: string; author: string; playUrl: string; }

function loadTikTokSound(url: string, job: Job) {
    if (!soundSessionReady) {
        soundSessionReady = true;
        // Don't load the page's videos and pictures – only its scripts and API calls are needed
        session.fromPartition(SOUND_PARTITION).webRequest.onBeforeRequest((d, cb) =>
            cb({ cancel: d.resourceType === "media" || d.resourceType === "image" }));
    }

    const win = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        width: 1280,
        height: 800,
        webPreferences: { partition: SOUND_PARTITION, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false }
    });
    win.webContents.setAudioMuted(true);
    win.webContents.setUserAgent(CHROME_UA);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    let stopped = false;
    job.abort = () => {
        stopped = true;
        win.destroy();
    };

    // Runs inside the page: waits for TikTok's own request, then repeats it and returns the important fields
    const READ_SOUND = `(async () => {
        const entry = performance.getEntriesByType("resource").find(e => e.name.includes("/api/music/detail/"));
        if (!entry) return null;
        const data = await (await fetch(entry.name, { credentials: "include" })).json();
        const m = data && data.musicInfo && data.musicInfo.music;
        return m && m.playUrl ? { title: m.title || "", author: m.authorName || "", playUrl: m.playUrl } : { error: true };
    })()`;

    return (async () => {
        try {
            // loadURL also rejects when the page redirects itself – the request can still happen
            await win.loadURL(url).catch(() => { });
            for (let waited = 0; waited < 30_000 && !stopped; waited += 300) {
                const sound = await win.webContents.executeJavaScript(READ_SOUND).catch(() => null);
                if (sound?.error) throw new Error("This sound isn't available (removed, or blocked in your country)");
                if (sound?.playUrl) return { title: String(sound.title || "TikTok sound"), author: String(sound.author || ""), playUrl: String(sound.playUrl) } as TikTokSound;
                await new Promise(r => setTimeout(r, 300));
            }
            throw new Error(stopped ? "Cancelled" : "TikTok didn't send the sound in time – try again");
        } finally {
            job.abort = undefined;
            if (!win.isDestroyed()) win.destroy();
        }
    })();
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90).trim();

async function grabTikTokSound(url: string, id: string, job: Job) {
    job.state.phase = "fetching";
    const sound = await loadTikTokSound(url, job);
    if (job.cancelled) throw new Error("Cancelled");
    job.state.title = sound.author ? `${sound.title} – ${sound.author}` : sound.title;

    const controller = new AbortController();
    job.abort = () => controller.abort();
    const res = await fetch(sound.playUrl, { signal: controller.signal, headers: { "User-Agent": CHROME_UA, Referer: "https://www.tiktok.com/" } });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);

    const type = res.headers.get("content-type") ?? "";
    const isMp3 = /mpeg|mp3/i.test(type) || /mime_type=audio_mpeg/.test(sound.playUrl);
    const name = `${safeName(job.state.title) || "TikTok sound"} [${id}]`;
    const raw = join(job.dir, name + (isMp3 ? ".mp3" : ".m4a"));

    const total = Number(res.headers.get("content-length")) || 0;
    let loaded = 0;
    job.state.phase = "downloading";
    const body = Readable.fromWeb(res.body as any);
    body.on("data", (c: Buffer) => {
        loaded += c.length;
        job.state.progress = total ? Math.min(1, loaded / total) : -1;
    });
    await pipeline(body, createWriteStream(raw));
    job.abort = undefined;

    if (isMp3) return raw;
    // Rarely an AAC sound – convert it like yt-dlp would
    job.state.phase = "converting";
    job.state.progress = -1;
    const mp3 = join(job.dir, name + ".mp3");
    await run(existsSync(FFMPEG) ? FFMPEG : "ffmpeg", ["-y", "-i", raw, "-vn", "-c:a", "libmp3lame", "-q:a", "0", mp3], 120_000);
    await fs.rm(raw, { force: true });
    return mp3;
}

/** Starts a download and returns its job id. Poll getJob() for progress. */
export function startGrab(_: IpcMainInvokeEvent, opts: GrabOptions) {
    if (!opts || typeof opts.url !== "string" || !/^https?:\/\/\S+$/i.test(opts.url.trim())) throw new Error("Invalid link");
    if (opts.kind !== "video" && opts.kind !== "audio") throw new Error("Invalid format");
    opts.url = opts.url.trim();

    const id = randomBytes(8).toString("hex");
    const dir = opts.keep ? app.getPath("downloads") : join(tmpdir(), `vc-mediagrab-${id}`);
    const job: Job = {
        state: { status: "running", progress: -1, phase: "starting", speed: 0, eta: 0, title: "" },
        dir,
        keep: !!opts.keep,
        cancelled: false
    };
    jobs.set(id, job);

    (async () => {
        await fs.mkdir(dir, { recursive: true });

        const sound = TIKTOK_SOUND.exec(opts.url);
        if (sound) {
            job.path = await grabTikTokSound(opts.url, sound[1], job);
            if (job.cancelled) throw new Error("Cancelled");
            job.state.size = (await fs.stat(job.path)).size;
            job.state.file = basename(job.path);
            job.state.progress = 1;
            job.state.status = "done";
            return;
        }

        const proc = spawn(YTDLP, buildArgs(opts, dir), {
            windowsHide: true,
            env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
        });
        job.proc = proc;

        let errors = "";
        let buf = "";
        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", (chunk: string) => {
            buf += chunk;
            const lines = buf.split(/\r?\n/);
            buf = lines.pop() ?? "";
            for (const l of lines) handleLine(job, l);
        });
        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (chunk: string) => {
            for (const l of chunk.split(/\r?\n/)) if (/^ERROR:/.test(l)) errors = l.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, "");
            if (errors.length > 400) errors = errors.slice(0, 400);
        });

        const code = await new Promise<number | null>((res, rej) => {
            proc.once("error", rej);
            proc.once("close", res);
        });
        if (buf) handleLine(job, buf);
        if (job.cancelled) throw new Error("Cancelled");
        if (code !== 0) throw new Error(errors || `yt-dlp exited with code ${code}`);
        if (!job.path || !existsSync(job.path)) throw new Error("yt-dlp finished but no file was found");

        job.state.size = (await fs.stat(job.path)).size;
        job.state.file = basename(job.path);
        job.state.progress = 1;
        job.state.status = "done";
    })().catch(e => {
        job.state.status = "error";
        job.state.error = String(e?.message ?? e);
        if (!job.keep) fs.rm(dir, { recursive: true, force: true }).catch(() => { });
    }).finally(() => { job.proc = undefined; });

    return id;
}

export function getJob(_: IpcMainInvokeEvent, id: string) {
    const job = validId(id) ? jobs.get(id) : null;
    return job ? job.state : null;
}

export function cancelGrab(_: IpcMainInvokeEvent, id: string) {
    const job = validId(id) ? jobs.get(id) : null;
    if (!job) return;
    job.cancelled = true;
    job.proc?.kill();
    job.abort?.();
}

/** The finished file's bytes (to attach it in the chat) */
export async function readResult(_: IpcMainInvokeEvent, id: string) {
    const job = validId(id) ? jobs.get(id) : null;
    if (!job?.path || job.state.status !== "done") throw new Error("Download not finished");
    if ((job.state.size ?? 0) > MAX_READ) throw new Error("File is too large to attach");
    return new Uint8Array(await fs.readFile(job.path));
}

export function showResult(_: IpcMainInvokeEvent, id: string) {
    const job = validId(id) ? jobs.get(id) : null;
    if (job?.path && job.keep) shell.showItemInFolder(job.path);
}

/** Forgets a job; temp files (chat-only downloads) are deleted */
export async function finishJob(_: IpcMainInvokeEvent, id: string) {
    const job = validId(id) ? jobs.get(id) : null;
    if (!job) return;
    jobs.delete(id);
    if (job.proc || job.abort) {
        job.cancelled = true;
        job.proc?.kill();
        job.abort?.();
    }
    if (!job.keep) await fs.rm(job.dir, { recursive: true, force: true }).catch(() => { });
}
