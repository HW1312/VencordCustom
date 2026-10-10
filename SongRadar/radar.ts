/*
 * SongRadar – listening and recognizing: system sound or a chat attachment → 16 kHz mono → fingerprint → Shazam.
 * One shared state (phase, result) for the title bar icon and the popout; history of recognized songs.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";

import { settings } from "./index";
import { makeSignature, MAX_SECONDS, SAMPLE_RATE } from "./signature";

export const logger = new Logger("SongRadar");
/** The main process part only loads when Discord starts – right after installing, a reload (Ctrl+R) isn't enough */
function native() {
    const helpers = VencordNative.pluginHelpers.SongRadar as PluginNative<typeof import("./native")> | undefined;
    if (!helpers) throw new Error("Quit Discord completely once (tray icon → Quit) and start it again – SongRadar needs that after installing.");
    return helpers;
}

// ---------------------------------------------------------------- Songs

export interface Song {
    /** Shazam track key – the same song always has the same key */
    key: string;
    title: string;
    artist: string;
    cover?: string;
    album?: string;
    year?: string;
    shazamUrl?: string;
    appleUrl?: string;
    /** 30 s preview from Apple */
    previewUrl?: string;
    at: number;
}

const query = (s: Song) => encodeURIComponent(`${s.title} ${s.artist}`);
export const spotifyUrl = (s: Song) => `https://open.spotify.com/search/${query(s)}`;
export const youtubeUrl = (s: Song) => `https://www.youtube.com/results?search_query=${query(s)}`;
export const appleUrl = (s: Song) => s.appleUrl ?? `https://music.apple.com/search?term=${query(s)}`;

function parseTrack(json: any): Song | null {
    const t = json?.track;
    if (!t?.title || !json?.matches?.length) return null;

    const actions: any[] = [...(t.hub?.actions ?? []), ...(t.hub?.options ?? []).flatMap((o: any) => o.actions ?? [])];
    const appleId = actions.find(a => a?.type === "applemusicplay" && a.id)?.id;
    const previewUrl = actions.find(a => a?.type === "uri" && /\.(m4a|aac|mp3)(\?|$)/.test(a.uri ?? ""))?.uri;
    const meta: any[] = t.sections?.find((s: any) => s?.type === "SONG")?.metadata ?? [];
    const metaValue = (title: string) => meta.find(m => m?.title === title)?.text as string | undefined;

    return {
        key: String(t.key ?? `${t.title}|${t.subtitle}`),
        title: t.title,
        artist: t.subtitle ?? "",
        cover: t.images?.coverarthq ?? t.images?.coverart,
        album: metaValue("Album"),
        year: metaValue("Released"),
        shazamUrl: typeof t.url === "string" ? t.url : undefined,
        appleUrl: appleId ? `https://music.apple.com/song/${appleId}` : undefined,
        previewUrl,
        at: Date.now()
    };
}

// ---------------------------------------------------------------- State

export type Phase = "idle" | "listening" | "searching" | "found" | "notfound" | "error";

export const state = {
    phase: "idle" as Phase,
    /** 0..1 while listening */
    progress: 0,
    /** Sound is coming in right now (drives the animation – no sound, no dancing bars) */
    hearing: false,
    /** What is being recognized: system sound or a file name */
    source: "system" as "system" | "media",
    sourceName: "",
    result: null as Song | null,
    error: ""
};
export const listeners = new Set<() => void>();

function set(patch: Partial<typeof state>) {
    Object.assign(state, patch);
    listeners.forEach(l => l());
}

export const busy = () => state.phase === "listening" || state.phase === "searching";

let cancelCurrent: (() => void) | null = null;

export function cancel() {
    cancelCurrent?.();
    cancelCurrent = null;
    if (busy()) set({ phase: "idle", progress: 0 });
}

/**
 * The history as plain objects. Entries read from the settings store are proxies; writing those back fails when
 * the settings are saved ("An object could not be cloned").
 */
const plainHistory = (): Song[] => JSON.parse(JSON.stringify(settings.store.history ?? []));

/** Saving the history must never turn a found song into an error */
function remember(song: Song) {
    try {
        const history = plainHistory().filter(s => s.key !== song.key);
        settings.store.history = [JSON.parse(JSON.stringify(song)), ...history].slice(0, 30);
    } catch (e) {
        logger.error("Couldn't save the history", e);
    }
}

/** Shows a song from the history as the result */
export function showSong(song: Song) {
    if (!busy()) set({ phase: "found", result: song, error: "" });
}

export function forget(key: string) {
    settings.store.history = plainHistory().filter(s => s.key !== key);
}

// ---------------------------------------------------------------- Audio helpers

/** Mono samples at any rate → 16 kHz */
async function resample(samples: Float32Array, rate: number): Promise<Float32Array> {
    if (rate === SAMPLE_RATE) return samples;
    const length = Math.max(1, Math.ceil(samples.length * SAMPLE_RATE / rate));
    const offline = new OfflineAudioContext(1, length, SAMPLE_RATE);
    const buffer = offline.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const node = offline.createBufferSource();
    node.buffer = buffer;
    node.connect(offline.destination);
    node.start();
    return (await offline.startRendering()).getChannelData(0);
}

function mono(buffer: AudioBuffer): Float32Array {
    if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
    const out = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < out.length; i++) out[i] += data[i] / buffer.numberOfChannels;
    }
    return out;
}

function loudness(samples: Float32Array) {
    let sum = 0;
    for (let i = 0; i < samples.length; i += 4) sum += samples[i] * samples[i];
    return Math.sqrt(sum / Math.max(1, samples.length / 4));
}

const SILENCE = 0.003;
/** Level above which the listen animation runs */
const HEARING = 0.006;

async function search(samples16k: Float32Array): Promise<Song | null> {
    const sig = makeSignature(samples16k);
    return parseTrack(await native().recognize(sig.uri, sig.sampleMs));
}

/**
 * System sound: Chromium's desktop capture (Windows delivers the sound of the whole PC with it). The video track is
 * required to get the sound but is stopped right away.
 */
async function openSystemSound(): Promise<MediaStream> {
    const sourceId = await native().screenSourceId();
    if (!sourceId) throw new Error("No screen found to capture the sound from.");
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: "desktop" } } as any,
        video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId, maxWidth: 16, maxHeight: 16, maxFrameRate: 1 } } as any
    });
    stream.getVideoTracks().forEach(t => t.stop());
    if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach(t => t.stop());
        throw new Error("Windows didn't share the system sound.");
    }
    return stream;
}

// ---------------------------------------------------------------- Listening

/**
 * Search after this many seconds, stop at the first match. Like the Shazam app it keeps listening for up to 30 s:
 * each search uses the newest 12 s, so an intro, people talking or a quiet part can pass first.
 */
const ATTEMPTS = [3, 6, 9, 12, 15, 18, 22, 26, 30];
export const LISTEN_SECONDS = ATTEMPTS[ATTEMPTS.length - 1];

/** Listens to the system sound and recognizes the song. Returns the song or null. */
export async function listen(): Promise<Song | null> {
    if (busy()) return null;
    set({ phase: "listening", progress: 0, source: "system", sourceName: "", error: "", result: null });

    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let cancelled = false;
    let tick: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
        clearInterval(tick);
        if (state.hearing) set({ hearing: false });
        stream?.getTracks().forEach(t => t.stop());
        ctx?.close().catch(() => { });
    };
    cancelCurrent = () => { cancelled = true; cleanup(); };

    try {
        stream = await openSystemSound();
        ctx = new AudioContext();
        const rate = ctx.sampleRate;
        const chunks: Float32Array[] = [];
        let total = 0;
        let lastLoud = 0;

        const source = ctx.createMediaStreamSource(stream);
        const processor = ctx.createScriptProcessor(4096, 2, 1);
        processor.onaudioprocess = e => {
            const input = e.inputBuffer;
            const out = new Float32Array(input.length);
            for (let c = 0; c < input.numberOfChannels; c++) {
                const data = input.getChannelData(c);
                for (let i = 0; i < out.length; i++) out[i] += data[i] / input.numberOfChannels;
            }
            chunks.push(out);
            total += out.length;
            // Calm on/off: counts as hearing until 1.5 s after the last loud moment, so the animation doesn't flicker
            if (loudness(out) > HEARING) lastLoud = Date.now();
            const hearing = Date.now() - lastLoud < 1500;
            if (hearing !== state.hearing) set({ hearing });
        };
        source.connect(processor);
        // A processor only runs while connected to the output; it writes silence there
        processor.connect(ctx.destination);

        const started = Date.now();
        tick = setInterval(() => set({ progress: Math.min(1, (Date.now() - started) / 1000 / LISTEN_SECONDS) }), 100);

        const collected = () => {
            const all = new Float32Array(total);
            let o = 0;
            for (const c of chunks) { all.set(c, o); o += c.length; }
            return all;
        };

        let heardSomething = false;
        for (const seconds of ATTEMPTS) {
            while (!cancelled && total < seconds * rate) await new Promise(r => setTimeout(r, 100));
            if (cancelled) return null;

            const samples = await resample(collected(), rate);
            if (loudness(samples.subarray(-seconds * SAMPLE_RATE)) < SILENCE) continue;
            heardSomething = true;

            const song = await search(samples);
            if (cancelled) return null;
            if (song) {
                cleanup();
                cancelCurrent = null;
                remember(song);
                set({ phase: "found", progress: 1, result: song });
                return song;
            }
        }

        cleanup();
        cancelCurrent = null;
        set({
            phase: heardSomething ? "notfound" : "error",
            progress: 0,
            error: heardSomething ? "" : "Nothing is playing – no sound came from your PC."
        });
        return null;
    } catch (e: any) {
        cleanup();
        cancelCurrent = null;
        if (cancelled) return null;
        logger.error("Listening failed", e);
        set({ phase: "error", progress: 0, error: errorText(e) });
        return null;
    }
}

function errorText(e: any): string {
    const name = e?.name ?? "";
    if (name === "NotAllowedError" || name === "SecurityError") return "Discord didn't allow capturing the system sound.";
    if (name === "NotReadableError") return "The system sound couldn't be captured (is another app using it exclusively?).";
    return String(e?.message ?? e ?? "Unknown error");
}

// ---------------------------------------------------------------- Chat attachments

/** Recognizes the song in a video / audio attachment: middle of the file first, then the start, then a quarter in */
export async function recognizeMedia(url: string, name: string): Promise<Song | null> {
    if (busy()) return null;
    set({ phase: "searching", progress: 0, source: "media", sourceName: name, result: null, error: "" });
    let cancelled = false;
    cancelCurrent = () => { cancelled = true; };

    try {
        const bytes = await native().downloadMedia(url);
        if (cancelled) return null;
        const ctx = new AudioContext();
        let decoded: AudioBuffer;
        try {
            decoded = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        } catch {
            throw new Error("This file has no sound that can be read.");
        } finally {
            ctx.close().catch(() => { });
        }
        const samples = await resample(mono(decoded), decoded.sampleRate);
        if (cancelled) return null;
        if (loudness(samples) < SILENCE) throw new Error("This file is silent.");

        const window = MAX_SECONDS * SAMPLE_RATE;
        const starts = samples.length <= window
            ? [0]
            : [Math.floor((samples.length - window) / 2), 0, Math.floor(samples.length / 4)];
        for (const start of [...new Set(starts)]) {
            const song = await search(samples.subarray(start, start + window));
            if (cancelled) return null;
            if (song) {
                remember(song);
                set({ phase: "found", result: song });
                return song;
            }
        }
        set({ phase: "notfound" });
        return null;
    } catch (e: any) {
        if (cancelled) return null;
        logger.error("Recognizing the attachment failed", e);
        set({ phase: "error", error: String(e?.message ?? e) });
        return null;
    } finally {
        cancelCurrent = null;
    }
}

// ---------------------------------------------------------------- Extras

const coverCache = new Map<string, Promise<string>>();

/** Cover through the main process (data: URL) – used when the image is blocked in the page */
export function loadCover(url: string) {
    let p = coverCache.get(url);
    if (!p) {
        p = (async () => native().fetchImage(url))();
        p.catch(() => coverCache.delete(url));
        coverCache.set(url, p);
    }
    return p;
}

/** YouTube link of the song, for the MP3 download */
export const findYouTube = (song: Song) => native().findYouTube(song.title, song.artist);
