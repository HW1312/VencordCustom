/*
 * UpdateButton – Vencord Userplugin
 * Replaces Vencord's update popup with a button on the left of the title bar
 * (like Discord's green update button on the right). The button is always there and opens a
 * panel with "Check for updates" and the changelog; it turns violet when an update is ready.
 * The changelog are the release notes on GitHub (written by build.mjs from the commit body).
 * Checks automatically every few minutes (setting) without using up GitHub's API limit: native.ts reads the newest
 * version from the releases page's redirect, the API is only asked once there really is a new version.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { definePluginSettings, Settings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import { classes } from "@utils/misc";
import { relaunch } from "@utils/native";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { checkForUpdates, update } from "@utils/updater";
import { findComponentByCodeLazy } from "@webpack";
import { Popout, useEffect, useRef, useState } from "@webpack/common";

import { Badge, Button, Icon, ICONS, notify, Popover, Section, Sheet, Spinner, useListener } from "../_ui";
import { LOGO } from "./logo";

import gitHash from "~git-hash";

const cl = (name: string) => `vc-updatebtn-${name}`;
const logger = new Logger("UpdateButton");
const Native = VencordNative.pluginHelpers.UpdateButton as PluginNative<typeof import("./native")>;
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

/** Same repo as REPO in build.mjs */
const REPO = "HW1312/VencordCustom";

/** First check after Vencord's own startup check is done, so both don't write the files at the same time */
const FIRST_CHECK = 60_000;
const NOTES_MAX_AGE = 10 * 60_000;

const settings = definePluginSettings({
    interval: {
        type: OptionType.SELECT,
        description: "Check for updates automatically every …",
        options: [
            { label: "1 minute", value: 1 },
            { label: "5 minutes", value: 5, default: true },
            { label: "15 minutes", value: 15 },
            { label: "30 minutes", value: 30 },
            { label: "1 hour", value: 60 }
        ],
        onChange: () => schedule(FIRST_CHECK)
    },
    preview: {
        type: OptionType.BOOLEAN,
        description: "Show the \"update ready\" state for testing (restart does nothing)",
        default: false
    }
});

// ---------------------------------------------------------------- State

type Status = "idle" | "checking" | "downloading" | "ready" | "latest" | "error";
type Kind = "new" | "fix" | "improved" | "removed" | null;

interface NoteItem { kind: Kind; text: string; }
interface Release { hash: string; date: number; items: NoteItem[]; }

const state = {
    status: "idle" as Status,
    error: "",
    lastCheck: 0,
    releases: [] as Release[],
    notesLoaded: 0
};

let timer: ReturnType<typeof setTimeout> | undefined;
let restarting = false;
const listeners = new Set<() => void>();

function set(patch: Partial<typeof state>) {
    Object.assign(state, patch);
    listeners.forEach(l => l());
}

/** The friends' package (standalone build from GitHub releases) – your own dev build is updated via npm run build */
const canUpdate = () => IS_STANDALONE && !IS_UPDATER_DISABLED && !IS_WEB;

const busy = () => state.status === "checking" || state.status === "downloading";

// ---------------------------------------------------------------- Release notes

const KINDS: [RegExp, Kind][] = [
    [/^(new|added|add)\b/i, "new"],
    [/^(fix|fixed|bugfix)\b/i, "fix"],
    [/^(improved|improve|changed|change|update|updated)\b/i, "improved"],
    [/^(removed|remove)\b/i, "removed"]
];

/** "- New: GofileUpload plugin" → { kind: "new", text: "GofileUpload plugin" } */
function parseNotes(body: string): NoteItem[] {
    return (body ?? "").split(/\r?\n/)
        .map(l => l.trim().replace(/^[-*•]\s*/, ""))
        .filter(l => l && !/^co-authored-by:/i.test(l) && !l.startsWith("#"))
        .map(line => {
            for (const [re, kind] of KINDS) {
                const m = line.match(re);
                if (m) return { kind, text: line.slice(m[0].length).replace(/^\s*[:\-–]\s*/, "") };
            }
            return { kind: null, text: line };
        });
}

async function loadNotes(force = false) {
    if (!force && Date.now() - state.notesLoaded < NOTES_MAX_AGE) return;
    try {
        // no-cache: the API is cached for 60 s, a release published just now would be missing
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=15`, { headers: { Accept: "application/vnd.github+json" }, cache: "no-cache" });
        if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
        const data = await res.json() as any[];
        set({
            notesLoaded: Date.now(),
            // GitHub doesn't return them in date order – sort newest first
            releases: data.filter(r => !r.draft).map(r => ({
                hash: String(r.name ?? "").split(" ").pop() ?? "",
                date: Date.parse(r.published_at ?? r.created_at),
                items: parseNotes(r.body)
            })).sort((a, b) => b.date - a.date)
        });
    } catch (e) {
        logger.error("Couldn't load release notes", e);
    }
}

/** Only ever one version: the one being installed (update ready) or the one running – keeps the list short */
function notesToShow(ready: boolean): Release | null {
    const { releases } = state;
    const release = ready ? releases[0] : releases.find(r => r.hash === gitHash) ?? releases[0];
    return release?.items.length ? release : null;
}

// ---------------------------------------------------------------- Updating

/**
 * Fallback without Vencord's commit comparison (GitHub's /compare between the installed and the newest commit):
 * only compares the newest release with the installed version and downloads it. Keeps updates working
 * when the git history was rewritten and the installed commit has no common ancestor with the new one.
 */
async function updateDirectly(): Promise<boolean> {
    const res = await VencordNative.updater.update();
    if (!res.ok) throw res.error;
    if (!res.value) return false;

    const built = await VencordNative.updater.rebuild();
    if (!built.ok) throw built.error;
    if (!built.value) throw new Error("The update could not be installed");
    return true;
}

/** Version downloaded this session (waits for a restart). A newer release on top of it is downloaded too. */
let downloadedTag: string | null = null;

async function check() {
    if (busy()) return;
    // Downloaded through Vencord's updater: no version to compare against, the restart picks it up
    if (state.status === "ready" && !downloadedTag) return;
    const wasReady = state.status === "ready";
    // Quietly in the background while an update already waits – the panel keeps showing it
    if (!wasReady) set({ status: "checking", error: "" });

    // Own dev build: nothing to download, only refresh the changelog
    if (!canUpdate()) {
        await loadNotes(true);
        set({ status: "latest", lastCheck: Date.now() });
        return;
    }

    // Without GitHub's API (60 requests per hour, shared by everyone on the same internet connection):
    // newest version from the releases page, files from the normal download links
    let latest: string | null = null;
    try {
        latest = await Native.latestTag();
    } catch (e) {
        logger.warn("Couldn't read the newest version from the releases page, using Vencord's updater", e);
    }
    if (latest) {
        try {
            if (latest === downloadedTag) {
                set({ status: "ready", lastCheck: Date.now() });
                return;
            }
            if (latest === gitHash && !downloadedTag) {
                set({ status: "latest", lastCheck: Date.now() });
                loadNotes();
                return;
            }
            set({ status: "downloading" });
            loadNotes(true);
            await Native.installRelease(latest);
            downloadedTag = latest;
            set({ status: "ready", lastCheck: Date.now() });
        } catch (e: any) {
            logger.error("Update failed", e);
            // An update that's already downloaded still counts
            if (wasReady) set({ status: "ready", lastCheck: Date.now() });
            else set({ status: "error", error: String(e?.message ?? e ?? "Unknown error"), lastCheck: Date.now() });
        }
        return;
    }
    if (wasReady) {
        set({ status: "ready" });
        return;
    }

    try {
        let outdated: boolean;
        try {
            outdated = await checkForUpdates();
        } catch (e) {
            logger.warn("Normal update check failed, checking the latest release directly", e);
            set({ status: "downloading" });
            loadNotes(true);
            const updated = await updateDirectly();
            set({ status: updated ? "ready" : "latest", lastCheck: Date.now() });
            return;
        }

        if (!outdated) {
            set({ status: "latest", lastCheck: Date.now() });
            loadNotes();
            return;
        }
        set({ status: "downloading" });
        loadNotes(true);
        // Downloads the new files; they become active on the next start
        await update();
        set({ status: "ready", lastCheck: Date.now() });
    } catch (e: any) {
        logger.error("Update check failed", e);
        set({ status: "error", error: String(e?.message ?? e ?? "Unknown error"), lastCheck: Date.now() });
    }
}

/**
 * Automatic check: same as the button (no API limit), plus a notification when an update is ready. Keeps checking
 * while an update waits for the restart, so a newer release replaces it right away.
 */
async function autoCheck() {
    if (busy()) return;
    const before = downloadedTag;
    const wasReady = state.status === "ready";
    await check();
    // check() changed it – TypeScript still thinks it can't be "ready"
    if ((state.status as Status) === "ready" && (!wasReady || downloadedTag !== before)) {
        notify({
            title: "VoidCord update ready",
            body: "Restart Discord to apply it – or later, it's installed on the next start.",
            kind: "info",
            app: "VoidCord",
            icon: ICONS.download,
            onClick: restart,
            duration: 12_000
        });
    }
}

const intervalMs = () => (Number(settings.store.interval) || 5) * 60_000;

function schedule(delay: number) {
    clearTimeout(timer);
    if (!canUpdate()) return;
    timer = setTimeout(async () => {
        await autoCheck();
        schedule(intervalMs());
    }, delay);
}

function restart() {
    if (restarting || state.status !== "ready") return;
    restarting = true;
    relaunch();
}

// ---------------------------------------------------------------- UI

/** Like a diff: + added, - removed, ✓ fixed */
const SIGN: Record<Exclude<Kind, null>, string> = { new: "+", removed: "−", fix: "✓", improved: "↑" };
const ORDER: Kind[] = ["new", "improved", "fix", "removed", null];

const PREVIEW_NOTES: Release = {
    hash: "preview",
    date: Date.now(),
    items: [
        { kind: "new", text: "Example plugin in the Plugin Hub" },
        { kind: "fix", text: "Example bug fix" }
    ]
};

function ago(ts: number) {
    if (!ts) return "Not checked yet";
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return "Checked just now";
    const m = Math.round(s / 60);
    if (m < 60) return `Checked ${m} min ago`;
    return `Checked ${Math.round(m / 60)} h ago`;
}

function Changelog({ release, ready }: { release: Release | null; ready: boolean; }) {
    if (!release) return null;
    const items = [...release.items].sort((x, y) => ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind));
    return (
        <Section title={ready ? "What's new" : "In this version"}>
            <div className={cl("changes-list")}>
                {items.map((it, i) => (
                    <div key={i} className={cl("change")}>
                        <span className={classes(cl("sign"), cl(`sign-${it.kind ?? "other"}`))}>{it.kind ? SIGN[it.kind] : "•"}</span>
                        <span className={cl("change-msg")}>{it.text}</span>
                    </div>
                ))}
            </div>
        </Section>
    );
}

/** The VoidCord logo with a light running around its ring and a glow – faster and violet when an update is ready */
function VoidLogo({ size = 64, active }: { size?: number; active?: boolean; }) {
    return (
        <span className={classes(cl("logo"), active && cl("logo-active"))} style={{ width: size, height: size }}>
            <span className={cl("logo-glow")} />
            <img src={LOGO} width={size} height={size} alt="" draggable={false} />
            <svg className={cl("logo-orbit")} viewBox="0 0 100 100" aria-hidden>
                <ellipse cx="50" cy="52" rx="46" ry="17" transform="rotate(-12 50 52)" pathLength={100} />
            </svg>
        </span>
    );
}

const every = () => {
    const m = Number(settings.store.interval) || 5;
    return m >= 60 ? "every hour" : m === 1 ? "every minute" : `every ${m} min`;
};

function Panel({ ready, preview }: { ready: boolean; preview: boolean; }) {
    useListener(listeners);
    const s = state;

    // Opening the panel checks right away if nothing has been checked yet (otherwise only refreshes the notes)
    useEffect(() => {
        if (!state.lastCheck) check();
        else loadNotes(!state.releases.some(r => r.hash === gitHash));
    }, []);

    const status = ready ? "Update ready – restart to apply"
        : s.status === "checking" ? "Checking for updates …"
            : s.status === "downloading" ? "Downloading update …"
                : s.status === "error" ? "Update check failed"
                    : "You're up to date";

    const release = preview ? PREVIEW_NOTES : notesToShow(ready);
    const tone = ready ? "purple" : busy() ? "orange" : s.status === "error" ? "red" : "green";

    return (
        <Popover width={330} className={cl("popover")}>
            <Sheet
                footer={
                    <div className={cl("actions")}>
                        <Button variant="gray" wide icon={busy() ? undefined : ICONS.refresh} disabled={busy() || ready} onClick={() => check()}>
                            {busy() && <Spinner />}{busy() ? "Checking …" : "Check for updates"}
                        </Button>
                        {ready && <Button wide color="purple" icon={ICONS.download} onClick={() => !preview && restart()}>Restart now</Button>}
                    </div>
                }
            >
                <div className={classes(cl("hero"), ready && cl("hero-ready"))}>
                    <VoidLogo active={ready || busy()} />
                    <div className={cl("hero-name")}>VoidCord</div>
                    <Badge color="purple" title="All releases on GitHub" onClick={() => window.open(`https://github.com/${REPO}/releases`, "_blank")}>{gitHash}</Badge>
                    <div className={classes(cl("status"), cl(`status-${tone}`))}>
                        <span className={classes(cl("dot"), cl(`dot-${tone}`), ready && cl("dot-ready"), busy() && cl("dot-busy"))} />
                        {status}
                    </div>
                    <div className={cl("hero-sub")}>
                        {s.status === "error" ? s.error : `${ago(s.lastCheck)}${canUpdate() ? ` · checks ${every()}` : ""}`}
                    </div>
                </div>
                <Changelog release={release} ready={ready} />
            </Sheet>
        </Popover>
    );
}

function UpdateButton() {
    const { preview } = settings.use(["preview"]);
    useListener(listeners);
    const s = state;
    const ref = useRef(null);
    const [show, setShow] = useState(false);
    const ready = s.status === "ready" || preview;

    const tooltip = ready ? "Update ready – click for details" : busy() ? "Checking for updates …" : "Updates";

    return (
        <Popout
            position="bottom"
            align="right"
            animation={Popout.Animation.NONE}
            shouldShow={show}
            onRequestClose={() => setShow(false)}
            targetElementRef={ref}
            renderPopout={() => <ErrorBoundary noop><Panel ready={ready} preview={preview} /></ErrorBoundary>}
        >
            {(_: any, { isShown }: { isShown: boolean; }) => (
                <HeaderBarIcon
                    ref={ref}
                    className={classes("vc-updatebtn", ready && "vc-updatebtn-ready")}
                    tooltip={isShown ? null : tooltip}
                    icon={() => <Icon path={ICONS.download} size={20} className="vc-ui-tb-icon" />}
                    selected={isShown}
                    onClick={() => setShow(v => !v)}
                />
            )}
        </Popout>
    );
}

// ---------------------------------------------------------------- Plugin

export default definePlugin({
    name: "UpdateButton",
    description: "Update button in the title bar instead of Vencord's update popup – check for updates, see what's new and restart with one click.",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Utility"],
    required: true,
    settings,

    patches: [
        {
            // Right side of the title bar: first item, so it sits left of Discord's own icons (Inbox, Help, ...).
            // VencordToolbox swaps the Fragment there for its own wrapper, so accept any component
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /trailing:\(0,\i\.jsxs\)\([^,{]{1,120},\{children:\[/,
                replace: "$&$self.renderButton(),"
            }
        }
    ],

    renderButton() {
        return <ErrorBoundary key="vc-updatebtn" noop><UpdateButton /></ErrorBoundary>;
    },

    start() {
        if (!canUpdate()) return;
        // No more popups: Vencord downloads silently, this button tells you about it
        Settings.autoUpdate = true;
        Settings.autoUpdateNotification = false;
        schedule(FIRST_CHECK);
    },

    stop() {
        clearTimeout(timer);
    }
});
