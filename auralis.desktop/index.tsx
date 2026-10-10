/*
 * Auralis – Vencord Userplugin
 * Shares what the Spotify desktop app is playing as a Discord music activity, read locally from Windows media
 * info. No Spotify login, no linked account, no profile link.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType, type PluginNative } from "@utils/types";
import { ApplicationAssetUtils, FluxDispatcher, React } from "@webpack/common";

import { Avatar, Badge, Field, Note, Row, Section, Sheet, TextField, ToggleRow } from "../_ui";
import { safeCoverUrl, trackKey } from "./artwork";
import { createPresence, type Track } from "./presence";

const Native = VencordNative.pluginHelpers.Auralis as PluginNative<typeof import("./native")>;
const socketId = "Auralis";
// Public default supplied by https://github.com/MrBoxik/Taskbar-Media-Presence
// Discord can display that application's registered name in the activity header.
const PUBLIC_APP_ID = "1528896038163710112";
const NOTE_PATH = "M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6Z";
const isAppId = (value: string) => /^\d{17,20}$/.test(value);

const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    share: {
        type: OptionType.BOOLEAN,
        description: "Share your local Spotify playback as an activity",
        default: true,
        hidden: true,
        onChange: () => refreshPresence()
    },
    applicationId: {
        type: OptionType.STRING,
        description: "Discord application ID shown as the activity header",
        default: PUBLIC_APP_ID,
        hidden: true,
        onChange: () => { resetCover(); refreshPresence(); updateCover(); }
    },
    showProgress: {
        type: OptionType.BOOLEAN,
        description: "Share timestamps when Spotify reports the song length",
        default: true,
        hidden: true,
        onChange: () => refreshPresence()
    },
    searchButton: {
        type: OptionType.BOOLEAN,
        description: "Show a public Spotify search button for title and artist",
        default: false,
        hidden: true,
        onChange: () => refreshPresence()
    },
    showCover: {
        type: OptionType.BOOLEAN,
        description: "Look up the album cover on Deezer",
        default: false,
        hidden: true,
        onChange: () => { resetCover(); refreshPresence(); updateCover(); }
    }
});

let running = false;
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let track: Track | null = null;
let status = "Not started yet";
let signature: string | undefined;
let coverUrl: string | undefined;
let coverAsset: string | undefined;
let coverKey = "";
let coverPending = false;
let coverVersion = 0;
let coverRetryAt = 0;
const listeners = new Set<() => void>();
function notify() { listeners.forEach(listener => listener()); }

function resetCover() {
    coverVersion++;
    coverUrl = undefined;
    coverAsset = undefined;
    coverKey = "";
    coverPending = false;
    coverRetryAt = 0;
}

function updateCover() {
    if (!running || !settings.store.share || !settings.store.showCover || !track?.playing) {
        if (coverKey || coverPending) { resetCover(); refreshPresence(); }
        return;
    }
    const key = trackKey(track) + settings.store.applicationId;
    if (coverKey !== key) {
        resetCover();
        coverKey = key;
        refreshPresence();
    }
    if (coverPending || coverAsset || Date.now() < coverRetryAt) return;
    const current = track;
    const appId = settings.store.applicationId.trim();
    if (!isAppId(appId)) return;
    const version = ++coverVersion;
    coverPending = true;
    void (async () => {
        try {
            const url = safeCoverUrl(await Native.findCover(current.title, current.artist, current.album, current.durationMs));
            if (version !== coverVersion || !running || !settings.store.share || !settings.store.showCover) return;
            if (url) {
                const asset = (await ApplicationAssetUtils.fetchAssetIds(appId, [url]))[0];
                if (version !== coverVersion || !running || !settings.store.share || !settings.store.showCover) return;
                if (asset) { coverUrl = url; coverAsset = asset; }
            }
        } catch { /* Keep the music activity if the catalog or Discord image lookup fails. */ }
        finally {
            if (version === coverVersion) {
                coverPending = false;
                coverRetryAt = Date.now() + 60000;
                refreshPresence();
            }
        }
    })();
}

function refreshPresence() {
    if (!running) return;
    const activity = settings.store.share ? createPresence(track, {
        applicationId: settings.store.applicationId.trim(),
        showProgress: settings.store.showProgress,
        searchButton: settings.store.searchButton,
        coverAsset: settings.store.showCover && track && coverKey === trackKey(track) + settings.store.applicationId ? coverAsset : undefined
    }) : null;
    const next = JSON.stringify(activity);
    if (signature !== next) {
        FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId });
        signature = next;
    }
    notify();
}

async function poll(version: number) {
    try {
        const snapshot = await Native.readTrack();
        if (!running || version !== generation) return;
        track = snapshot.track;
        status = snapshot.status === "unsupported" ? "Only available on Windows"
            : snapshot.status === "error" ? "Windows media info not available"
                : !track ? "Open Spotify and start some music"
                    : track.playing ? "Spotify detected" : "Playback paused";
    } catch {
        if (!running || version !== generation) return;
        track = null;
        status = "Fully restart Discord (quit it from the tray) – a reload is not enough";
    }
    if (!running || version !== generation) return;
    updateCover();
    refreshPresence();
    timer = setTimeout(() => void poll(version), 500);
}

const SettingsPanel = ErrorBoundary.wrap(() => {
    const config = settings.use(["share", "applicationId", "showProgress", "searchButton", "showCover"]);
    const [, rerender] = React.useState(0);
    React.useEffect(() => {
        const update = () => rerender(value => value + 1);
        listeners.add(update);
        return () => { listeners.delete(update); };
    }, []);
    const appId = config.applicationId.trim();
    const validId = isAppId(appId);
    const sharing = running && config.share && validId && track?.playing;
    const coverState = !config.showCover ? "Off – nothing is sent to Deezer"
        : coverAsset ? "Cover ready for Discord"
            : coverPending ? "Looking up the cover…"
                : "Title and artist are sent to Deezer while playing";

    return (
        <Sheet embedded header={{ title: "Auralis", subtitle: "Your music, without linking your Spotify account", icon: NOTE_PATH, iconColor: "green" }}>
            <Section title="Now playing">
                <Row
                    leading={<Avatar src={config.showCover ? coverUrl : undefined} fallback={NOTE_PATH} size={48} square />}
                    title={track?.title || "Nothing playing"}
                    subtitle={track ? [track.artist, track.album].filter(Boolean).join(" · ") : status}
                    trailing={<Badge color={sharing ? "green" : "gray"} solid={!!sharing}>{sharing ? "LIVE" : "LOCAL"}</Badge>}
                />
            </Section>

            <Section title="Sharing">
                <ToggleRow title="Share music" subtitle={status} checked={config.share}
                    onChange={v => { settings.store.share = v; }} />
                <ToggleRow title="Show progress" subtitle="Timestamps when Spotify reports the song length" checked={config.showProgress}
                    onChange={v => { settings.store.showProgress = v; }} />
                <ToggleRow title="Spotify search button" subtitle="Public search for title and artist, no profile link" checked={config.searchButton}
                    onChange={v => { settings.store.searchButton = v; }} />
                <ToggleRow title="Album cover" subtitle={coverState} checked={config.showCover}
                    onChange={v => { settings.store.showCover = v; }} />
            </Section>

            <Section title="Discord application"
                footer={appId === PUBLIC_APP_ID
                    ? "Public ID from Taskbar Media Presence. Discord may show that app's name above the activity. Your Spotify account is not linked."
                    : "Create your own free application in the Discord Developer Portal to choose the name shown above the activity. No token needed."}>
                <Field label="Application ID" hint={validId ? undefined : "Enter a valid application ID (17–20 digits) to share."}>
                    <TextField value={config.applicationId} placeholder={PUBLIC_APP_ID}
                        onChange={v => { settings.store.applicationId = v.replace(/\D/g, "").slice(0, 20); }} />
                </Field>
            </Section>

            <Note>
                No Spotify login, no account name, no profile link. Only title, artist and optionally timestamps and the cover are
                shared. Turn on activity sharing in Discord. The original Spotify card and “Listen along” are not recreated.
            </Note>
        </Sheet>
    );
});

export default definePlugin({
    name: "Auralis",
    description: "Private Spotify music activity from local Windows media info, without linking your account.",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Media", "Activity", "Privacy"],
    settings,
    start() {
        running = true;
        signature = undefined;
        void poll(++generation);
    },
    stop() {
        running = false;
        generation++;
        clearTimeout(timer);
        void Native.stopTrack().catch(() => { });
        track = null;
        resetCover();
        status = "Plugin disabled";
        signature = undefined;
        FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity: null, socketId });
        notify();
    }
});
