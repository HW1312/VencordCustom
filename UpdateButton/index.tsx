/*
 * UpdateButton – Vencord Userplugin
 * Replaces Vencord's update popup with a button on the left of the title bar
 * (like Discord's green update button on the right). The button is always there and opens a
 * panel with "Check for updates" and the changelog; it turns violet when an update is ready.
 * The changelog are the release notes on GitHub (written by build.mjs from the commit body).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { definePluginSettings, Settings } from "@api/Settings";
import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import { classes } from "@utils/misc";
import { relaunch } from "@utils/native";
import definePlugin, { OptionType } from "@utils/types";
import { checkForUpdates, update } from "@utils/updater";
import { findComponentByCodeLazy } from "@webpack";
import { Popout, React, useEffect, useRef, useState } from "@webpack/common";

import gitHash from "~git-hash";

const cl = classNameFactory("vc-updatebtn-");
const logger = new Logger("UpdateButton");
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

/** Same repo as REPO in build.mjs */
const REPO = "HW1312/VencordCustom";

/** First check after Vencord's own startup check is done, so both don't write the files at the same time */
const FIRST_CHECK = 60_000;
const INTERVAL = 30 * 60_000;
const NOTES_MAX_AGE = 10 * 60_000;

const settings = definePluginSettings({
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

function useUpdateState() {
    const [, setTick] = useState(0);
    useEffect(() => {
        const l = () => setTick(t => t + 1);
        listeners.add(l);
        return () => void listeners.delete(l);
    }, []);
    return state;
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
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=15`, { headers: { Accept: "application/vnd.github+json" } });
        if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
        const data = await res.json() as any[];
        set({
            notesLoaded: Date.now(),
            releases: data.filter(r => !r.draft).map(r => ({
                hash: String(r.name ?? "").split(" ").pop() ?? "",
                date: Date.parse(r.published_at ?? r.created_at),
                items: parseNotes(r.body)
            }))
        });
    } catch (e) {
        logger.error("Couldn't load release notes", e);
    }
}

/** Releases newer than the running version (newest first) – or, if up to date, the current one */
function notesToShow(ready: boolean): Release[] {
    const { releases } = state;
    const current = releases.findIndex(r => r.hash === gitHash);
    if (ready) return (current < 0 ? releases.slice(0, 1) : releases.slice(0, current)).filter(r => r.items.length);
    const own = releases[current] ?? releases[0];
    return own?.items.length ? [own] : [];
}

// ---------------------------------------------------------------- Updating

async function check() {
    if (busy() || state.status === "ready") return;
    set({ status: "checking", error: "" });

    // Own dev build: nothing to download, only refresh the changelog
    if (!canUpdate()) {
        await loadNotes(true);
        set({ status: "latest", lastCheck: Date.now() });
        return;
    }

    try {
        if (!await checkForUpdates()) {
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

function schedule(delay: number) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
        await check();
        if (state.status !== "ready") schedule(INTERVAL);
    }, delay);
}

function restart() {
    if (restarting || state.status !== "ready") return;
    restarting = true;
    relaunch();
}

// ---------------------------------------------------------------- UI

const DOWNLOAD_PATH = "M12 2a1 1 0 0 1 1 1v10.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V3a1 1 0 0 1 1-1ZM3 20a1 1 0 0 1 1-1h16a1 1 0 1 1 0 2H4a1 1 0 0 1-1-1Z";
const REFRESH_PATH = "M4 12a8 8 0 0 1 14.32-4.9V5a1 1 0 1 1 2 0v5a1 1 0 0 1-1 1h-5a1 1 0 1 1 0-2h2.6A6 6 0 1 0 18 12a1 1 0 1 1 2 0A8 8 0 1 1 4 12Z";

/** Like a diff: + added, - removed, ✓ fixed */
const SIGN: Record<Exclude<Kind, null>, string> = { new: "+", removed: "−", fix: "✓", improved: "↑" };
const ORDER: Kind[] = ["new", "improved", "fix", "removed", null];

const PREVIEW_NOTES: Release[] = [{
    hash: "preview",
    date: Date.now(),
    items: [
        { kind: "new", text: "Example plugin in the Plugin Hub" },
        { kind: "fix", text: "Example bug fix" }
    ]
}];

function Svg({ path, size = 20 }: { path: string; size?: number; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
            <path fill="currentColor" d={path} />
        </svg>
    );
}

function ago(ts: number) {
    if (!ts) return "Not checked yet";
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return "Checked just now";
    const m = Math.round(s / 60);
    if (m < 60) return `Checked ${m} min ago`;
    return `Checked ${Math.round(m / 60)} h ago`;
}

const formatDate = (ts: number) => new Date(ts).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });

function Changelog({ releases, ready }: { releases: Release[]; ready: boolean; }) {
    if (!releases.length) return null;
    return (
        <div className={cl("changes")}>
            <div className={cl("changes-head")}>{ready ? "What's new" : "In this version"}</div>
            <div className={cl("changes-list")}>
                {releases.map(r => (
                    <React.Fragment key={r.hash}>
                        {releases.length > 1 && <div className={cl("release-date")}>{formatDate(r.date)}</div>}
                        {[...r.items].sort((x, y) => ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind)).map((it, i) => (
                            <div key={i} className={cl("change")}>
                                <span className={classes(cl("sign"), cl(`sign-${it.kind ?? "other"}`))}>{it.kind ? SIGN[it.kind] : "•"}</span>
                                <span className={cl("change-msg")}>{it.text}</span>
                            </div>
                        ))}
                    </React.Fragment>
                ))}
            </div>
        </div>
    );
}

function Panel({ ready, preview }: { ready: boolean; preview: boolean; }) {
    const s = useUpdateState();

    useEffect(() => { loadNotes(); }, []);

    const status = ready ? "Update ready – restart to apply"
        : s.status === "checking" ? "Checking for updates …"
            : s.status === "downloading" ? "Downloading update …"
                : s.status === "error" ? "Update check failed"
                    : "You're up to date";

    const releases = preview ? PREVIEW_NOTES : notesToShow(ready);

    return (
        <div className={cl("panel")}>
            <div className={cl("head")}>
                <div className={cl("title")}>VencordCustom</div>
                <button className={cl("version")} onClick={() => window.open(`https://github.com/${REPO}/releases`, "_blank")} title="All releases on GitHub">{gitHash}</button>
            </div>

            <div className={cl("status")}>
                <span className={classes(cl("dot"), ready ? cl("dot-ready") : busy() ? cl("dot-busy") : s.status === "error" ? cl("dot-error") : cl("dot-idle"))} />
                <div className={cl("status-text")}>
                    <div className={cl("status-label")}>{status}</div>
                    <div className={cl("status-sub")}>{s.status === "error" ? s.error : ago(s.lastCheck)}</div>
                </div>
            </div>

            <Changelog releases={releases} ready={ready} />

            <div className={cl("actions")}>
                <button className={classes(cl("btn"), cl("btn-secondary"))} disabled={busy() || ready} onClick={() => check()}>
                    <span className={classes(cl("btn-icon"), busy() && cl("spin"))}><Svg path={REFRESH_PATH} size={16} /></span>
                    {busy() ? "Checking …" : "Check for updates"}
                </button>
                {ready && (
                    <button className={classes(cl("btn"), cl("btn-primary"))} onClick={() => !preview && restart()}>
                        <Svg path={DOWNLOAD_PATH} size={16} /> Restart now
                    </button>
                )}
            </div>
        </div>
    );
}

function UpdateButton() {
    const { preview } = settings.use(["preview"]);
    const s = useUpdateState();
    const ref = useRef(null);
    const [show, setShow] = useState(false);
    const ready = s.status === "ready" || preview;

    const tooltip = ready ? "Update ready – click for details" : busy() ? "Checking for updates …" : "Updates";

    return (
        <Popout
            position="bottom"
            align="left"
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
                    icon={() => <Svg path={DOWNLOAD_PATH} />}
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
            // Left side of the title bar (next to Back/Forward & Inbox), same spot as the other plugin icons
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(leading:.{0,800}?)\]\}\),title:/,
                replace: "$1,$self.renderButton()]}),title:"
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
