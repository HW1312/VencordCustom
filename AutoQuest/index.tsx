/*
 * AutoQuest – Vencord Userplugin
 * Accepts Discord quests on its own, completes them in the background and claims the reward.
 * Video quests send their progress like the video player would, game quests pretend the game is running, activity
 * quests send heartbeats, stream quests pretend you stream the game (you still have to stream any window in a voice
 * channel with someone else). One quest per kind at a time, every request waits its turn with a random pause, so
 * Discord doesn't see a burst of requests. If claiming needs a captcha or fails, it only tells you the quest is claimable.
 * Based on https://gist.github.com/aamiaa/204cd9d42013ded9faf646fae7f89fbb
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { definePluginSettings } from "@api/Settings";
import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import { classes } from "@utils/misc";
import { ModalRoot, ModalSize } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { findByCodeLazy, findComponentByCodeLazy, findStoreLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, GuildChannelStore, NavigationRouter, openModal, RestAPI, Tooltip, useEffect, useState, useStateFromStores } from "@webpack/common";
import type { ReactNode } from "react";

import { showQuestToast, ToastKind, unmountToasts } from "./toast";

const cl = classNameFactory("vc-autoquest-");
const logger = new Logger("AutoQuest");

const QuestStore = findStoreLazy("QuestStore");
const RunningGameStore = findStoreLazy("RunningGameStore");
const ApplicationStreamingStore = findStoreLazy("ApplicationStreamingStore");
/** Discord's own actions – they add the metadata Discord expects */
const enrollQuest: (questId: string, opts: { questContent: number; }) => Promise<{ type: string; }> = findByCodeLazy('type:"QUESTS_ENROLL_BEGIN"');
const claimQuest: (questId: string, platform: number, location: number) => Promise<any> = findByCodeLazy('type:"QUESTS_CLAIM_REWARD_BEGIN"');
const fetchQuests: () => Promise<void> = findByCodeLazy('type:"QUESTS_FETCH_CURRENT_QUESTS_BEGIN"');
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

/** QuestContent.QUEST_HOME_DESKTOP – as if you clicked it on the quests page */
const LOCATION = 11;
const TASKS = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"] as const;
type TaskName = typeof TASKS[number];
type Lane = "video" | "game" | "stream" | "activity";
const LANE_OF: Record<TaskName, Lane> = {
    WATCH_VIDEO: "video",
    WATCH_VIDEO_ON_MOBILE: "video",
    PLAY_ON_DESKTOP: "game",
    STREAM_ON_DESKTOP: "stream",
    PLAY_ACTIVITY: "activity"
};

/** Pauses (ms) – random within the range so the requests don't come in a fixed rhythm */
const GAP = [1500, 3500] as const;
const BETWEEN_ENROLLS = [8000, 20000] as const;
const BETWEEN_QUESTS = [20000, 60000] as const;
const VIDEO_STEP = [7000, 10000] as const;
const ACTIVITY_STEP = [20000, 30000] as const;
const CHECK_EVERY = 10 * 60_000;

const settings = definePluginSettings({
    status: {
        type: OptionType.COMPONENT,
        component: () => <ErrorBoundary noop><SettingsButton /></ErrorBoundary>
    },
    active: {
        type: OptionType.BOOLEAN,
        description: "Master switch – off stops everything until you turn it on again",
        default: true,
        onChange: (v: boolean) => v ? begin() : halt()
    },
    showTitleBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show the AutoQuest icon in the title bar",
        default: true
    },
    autoEnroll: {
        type: OptionType.BOOLEAN,
        description: "Accept new quests automatically",
        default: true
    },
    autoClaim: {
        type: OptionType.BOOLEAN,
        description: "Claim rewards automatically (if it needs a captcha you only get a message)",
        default: true
    },
    orbsOnly: {
        type: OptionType.BOOLEAN,
        description: "Only do quests that give Orbs",
        default: false
    },
    video: {
        type: OptionType.BOOLEAN,
        description: "Complete video quests",
        default: true
    },
    game: {
        type: OptionType.BOOLEAN,
        description: "Complete \"play the game\" quests (desktop app only – your real game is hidden from your status meanwhile)",
        default: true
    },
    stream: {
        type: OptionType.BOOLEAN,
        description: "Help with stream quests (you still have to stream any window in a voice channel with someone else)",
        default: true
    },
    activity: {
        type: OptionType.BOOLEAN,
        description: "Complete activity quests",
        default: true
    },
    notify: {
        type: OptionType.BOOLEAN,
        description: "Show a notification when a quest is done or claimable",
        default: true
    }
});

// ---------------------------------------------------------------- State

type State = "queued" | "running" | "waiting" | "done" | "claimed" | "claimable" | "failed" | "available" | "unsupported";

interface Status {
    id: string;
    name: string;
    task: TaskName;
    done: number;
    target: number;
    state: State;
    note?: string;
}

const status = new Map<string, Status>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(l => l());

function setStatus(id: string, patch: Partial<Status>) {
    const s = status.get(id);
    if (s) Object.assign(s, patch);
    changed();
}

let alive = false;
let timer: ReturnType<typeof setInterval> | undefined;
const busy: Partial<Record<Lane, string>> = {};
/** Quests that failed or were already handled this session – not tried again until restart */
const skip = new Set<string>();
const enrolling = new Set<string>();
const claimTried = new Set<string>();

const rand = ([min, max]: readonly [number, number]) => min + Math.random() * (max - min);

/** Waits, but returns early when the plugin is stopped */
function sleep(ms: number) {
    return new Promise<void>(resolve => {
        const done = () => { clearTimeout(t); stopWaiters.delete(done); resolve(); };
        const t = setTimeout(done, ms);
        stopWaiters.add(done);
    });
}
const stopWaiters = new Set<() => void>();

/** All quest requests go one after another with a random pause in between */
let chain: Promise<unknown> = Promise.resolve();
function request<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
        if (!alive) throw new Error("stopped");
        for (let attempt = 0; ; attempt++) {
            try {
                return await fn();
            } catch (e: any) {
                // Rate limited – wait as long as Discord says, plus a bit
                if (e?.status === 429 && attempt < 3) {
                    const wait = (Number(e.body?.retry_after) || 10) * 1000 + rand([2000, 5000]);
                    logger.warn(`Rate limited, waiting ${Math.round(wait / 1000)} s`);
                    await sleep(wait);
                    if (!alive) throw e;
                    continue;
                }
                throw e;
            }
        }
    });
    chain = run.catch(() => { }).then(() => sleep(rand(GAP)));
    return run;
}

// ---------------------------------------------------------------- Quests

function taskOf(quest: any) {
    const config = quest.config.taskConfig ?? quest.config.taskConfigV2;
    const name = TASKS.find(t => config?.tasks?.[t] != null);
    if (!name) return null;
    const data = config.tasks[name];
    return {
        name,
        data,
        target: data.target as number,
        appId: (quest.config.application?.id ?? data.applications?.[0]?.id) as string | undefined
    };
}

const nameOf = (quest: any) => quest.config?.messages?.questName ?? "Quest";
const expired = (quest: any) => new Date(quest.config.expiresAt).getTime() <= Date.now();
const progressOf = (quest: any, task: TaskName) => quest.userStatus?.progress?.[task]?.value ?? 0;

interface Reward {
    name: string;
    /** Orbs you get – only for Orb rewards */
    orbs?: number;
}

/** RewardType.VIRTUAL_CURRENCY = Orbs */
const ORBS = 4;

function rewardOf(quest: any): Reward | null {
    const r = quest.config?.rewardsConfig?.rewards?.[0];
    if (!r) return null;
    if (r.type === ORBS && r.orbQuantity) return { name: `${r.orbQuantity} Orbs`, orbs: r.orbQuantity };
    return { name: r.messages?.name ?? "Reward" };
}

const CDN = "https://cdn.discordapp.com/";
/** Like Discord: paths with a "/" hang off the CDN root, plain file names off quests/<id>/<theme>/ */
function assetUrl(quest: any, asset?: string, theme?: "dark") {
    if (!asset) return undefined;
    if (/^(https?|blob):/.test(asset)) return asset;
    if (asset.includes("/")) return CDN + asset;
    return `${CDN}quests/${quest.id}${theme ? `/${theme}` : ""}/${asset}`;
}

function tileOf(quest: any) {
    const a = quest.config.assets ?? {};
    return a.gameTileDark ? assetUrl(quest, a.gameTileDark) : assetUrl(quest, a.gameTile, "dark");
}

/** Own toast at the top right – with the quest's picture and reward */
function notify(quest: any, kind: ToastKind, title: string, body: string, onClick?: () => void) {
    if (!settings.store.notify) return;
    showQuestToast({ title, body, kind, image: tileOf(quest), side: <RewardChip reward={rewardOf(quest)} />, onClick });
}

const openQuests = () => NavigationRouter.transitionTo("/quest-home");

function track(quest: any, state: State, note?: string) {
    const task = taskOf(quest);
    if (!task) return;
    const prev = status.get(quest.id);
    status.set(quest.id, {
        id: quest.id,
        name: nameOf(quest),
        task: task.name,
        target: task.target,
        done: Math.max(prev?.done ?? 0, progressOf(quest, task.name)),
        state,
        note
    });
    changed();
}

/** Why the plugin leaves a quest alone – null = it works on it */
function ignoredBecause(quest: any): string | null {
    const task = taskOf(quest);
    if (!task) return "This kind of quest isn't supported";
    const lane = LANE_OF[task.name];
    if ((lane === "game" || lane === "stream") && IS_WEB) return "Only works in the desktop app";
    if (!settings.store[lane]) return `${TASK_TEXT[task.name]} quests are turned off`;
    if (settings.store.orbsOnly && !rewardOf(quest)?.orbs) return "No Orbs as reward";
    return null;
}

const questList = (): any[] => [...(QuestStore.quests?.values?.() ?? [])];

/** Starts every quest whose kind has nothing running right now */
function startLanes() {
    for (const q of questList()) {
        const us = q.userStatus;
        if (!us?.enrolledAt || us.completedAt || expired(q) || skip.has(q.id) || ignoredBecause(q)) continue;
        const task = taskOf(q)!;
        const lane = LANE_OF[task.name];
        if (busy[lane]) {
            if (!status.has(q.id)) track(q, "queued");
            continue;
        }
        busy[lane] = q.id;
        runLane(lane, q);
    }
}

/** Looks at all quests: starts free lanes, accepts new ones, claims finished ones */
let checking = false;
let again = false;
async function check() {
    if (!alive) return;
    // A check is already going (it may sleep between accepting quests) – it runs once more when done
    if (checking) {
        again = true;
        return;
    }
    checking = true;
    try {
        do {
            again = false;
            startLanes();

            // Claim finished quests first – quick, while accepting new ones pauses in between
            for (const q of questList()) {
                if (!alive) return;
                const us = q.userStatus;
                if (!us?.enrolledAt || !taskOf(q)) continue;
                if (us.claimedAt) {
                    if (status.has(q.id)) setStatus(q.id, { state: "claimed", done: status.get(q.id)!.target });
                } else if (us.completedAt) {
                    await claim(q);
                }
            }

            // Accept new quests – one at a time with a long pause
            if (settings.store.autoEnroll) {
                for (const q of questList()) {
                    if (!alive) return;
                    if (q.userStatus?.enrolledAt || expired(q) || skip.has(q.id) || enrolling.has(q.id) || ignoredBecause(q)) continue;
                    enrolling.add(q.id);
                    try {
                        const res = await request(() => enrollQuest(q.id, { questContent: LOCATION }));
                        if (res?.type !== "success") throw new Error(res?.type);
                        logger.info(`Accepted ${nameOf(q)}`);
                    } catch (e) {
                        logger.warn(`Couldn't accept ${nameOf(q)}`, e);
                        skip.add(q.id);
                    }
                    startLanes();
                    await sleep(rand(BETWEEN_ENROLLS));
                }
            }

        } while (again && alive);
    } finally {
        checking = false;
    }
}

async function runLane(lane: Lane, quest: any) {
    track(quest, "running");
    try {
        if (lane === "video") await doVideo(quest);
        else if (lane === "game") await doGame(quest);
        else if (lane === "stream") await doStream(quest);
        else await doActivity(quest);

        if (!alive) return;
        setStatus(quest.id, { state: "done", note: undefined });
        logger.info(`Completed ${nameOf(quest)}`);
        // Discord's store only learns about it after fetching the quests again
        await sleep(rand([3000, 6000]));
        await request(fetchQuests).catch(() => { });
    } catch (e: any) {
        if (!alive) return;
        logger.error(`${nameOf(quest)} failed`, e);
        skip.add(quest.id);
        setStatus(quest.id, { state: "failed", note: e?.body?.message ?? e?.message ?? String(e) });
    }
    if (!alive) return;
    // The lane stays taken during the pause, so no other check starts the next quest early
    await sleep(rand(BETWEEN_QUESTS));
    if (busy[lane] === quest.id) delete busy[lane];
    if (!alive) return;
    check();
}

async function claim(quest: any) {
    const name = nameOf(quest);
    if (status.get(quest.id)?.state === "claimable" || claimTried.has(quest.id)) return;
    if (!status.has(quest.id)) track(quest, "done");

    if (!settings.store.autoClaim) {
        setStatus(quest.id, { state: "claimable" });
        notify(quest, "attention", "Quest completed", `${name} – click to claim the reward`, openQuests);
        return;
    }

    claimTried.add(quest.id);
    try {
        const platform = quest.config.rewardsConfig?.platforms?.[0] ?? 0;
        const res = await request(() => claimQuest(quest.id, platform, LOCATION));
        if (res?.errors?.length) throw new Error("claim refused");
        setStatus(quest.id, { state: "claimed" });
        notify(quest, "success", "Reward claimed", name);
    } catch (e) {
        // Usually a captcha – claiming by hand works
        logger.warn(`Couldn't claim ${name}`, e);
        setStatus(quest.id, { state: "claimable", note: "Needs to be claimed by hand" });
        notify(quest, "attention", "Quest claimable", `${name} – click to claim it yourself`, openQuests);
    }
}

// ---------------------------------------------------------------- Kinds of quests

async function doVideo(quest: any) {
    const task = taskOf(quest)!;
    const enrolledAt = new Date(quest.userStatus.enrolledAt).getTime();
    let done = progressOf(quest, task.name);
    let completed = false;

    while (alive && done < task.target) {
        await sleep(rand(VIDEO_STEP));
        if (!alive) return;
        // Discord refuses progress further than the time since accepting the quest
        const allowed = (Date.now() - enrolledAt) / 1000;
        const next = Math.min(task.target, done + 7, allowed);
        if (next <= done) continue;

        const res = await request(() => RestAPI.post({
            url: `/quests/${quest.id}/video-progress`,
            body: { timestamp: Math.min(task.target, next + Math.random()) }
        }));
        done = next;
        completed = res?.body?.completed_at != null;
        setStatus(quest.id, { done });
        if (completed) return;
    }
    if (alive && !completed) {
        await request(() => RestAPI.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: task.target } }));
    }
}

/** Resolves when Discord's heartbeats say the quest is done */
function waitForHeartbeats(quest: any, task: TaskName, target: number) {
    return new Promise<void>(resolve => {
        const onBeat = (e: any) => {
            if (e.questId !== quest.id) return;
            const done = quest.config.configVersion === 1
                ? e.userStatus?.streamProgressSeconds ?? 0
                : Math.floor(e.userStatus?.progress?.[task]?.value ?? 0);
            setStatus(quest.id, { done });
            if (done >= target) finish();
        };
        const finish = () => {
            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onBeat);
            stopWaiters.delete(finish);
            resolve();
        };
        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onBeat);
        stopWaiters.add(finish);
    });
}

let restoreGames: (() => void) | null = null;

async function doGame(quest: any) {
    const task = taskOf(quest)!;
    if (!task.appId) throw new Error("Quest has no game");
    const res = await request(() => RestAPI.get({ url: `/applications/public?application_ids=${task.appId}` }));
    const app = res.body?.[0];
    if (!app) throw new Error("Game not found");
    if (!alive) return;

    const pid = Math.floor(Math.random() * 30000) + 1000;
    const exeName = app.executables?.find((x: any) => x.os === "win32")?.name?.replace(">", "") ?? app.name.replace(/[/\\:*?"<>|]/g, "");
    const fake = {
        cmdLine: `C:\\Program Files\\${app.name}\\${exeName}`,
        exeName,
        exePath: `c:/program files/${app.name.toLowerCase()}/${exeName}`,
        hidden: false,
        isLauncher: false,
        id: task.appId,
        name: app.name,
        pid,
        pidPath: [pid],
        processName: app.name,
        start: Date.now()
    };

    const real = RunningGameStore.getRunningGames();
    const { getRunningGames, getGameForPID } = RunningGameStore;
    RunningGameStore.getRunningGames = () => [fake];
    RunningGameStore.getGameForPID = (p: number) => p === pid ? fake : undefined;
    FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: real, added: [fake], games: [fake] } as any);
    restoreGames = () => {
        RunningGameStore.getRunningGames = getRunningGames;
        RunningGameStore.getGameForPID = getGameForPID;
        FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fake], added: [], games: [] } as any);
        restoreGames = null;
    };
    setStatus(quest.id, { note: `Pretending to play ${app.name}` });

    try {
        await waitForHeartbeats(quest, task.name, task.target);
    } finally {
        restoreGames?.();
    }
}

let restoreStream: (() => void) | null = null;

async function doStream(quest: any) {
    const task = taskOf(quest)!;
    const real = ApplicationStreamingStore.getStreamerActiveStreamMetadata;
    ApplicationStreamingStore.getStreamerActiveStreamMetadata = () => ({ id: task.appId, pid: Math.floor(Math.random() * 30000) + 1000, sourceName: null });
    restoreStream = () => {
        ApplicationStreamingStore.getStreamerActiveStreamMetadata = real;
        restoreStream = null;
    };
    const minutes = Math.ceil((task.target - progressOf(quest, task.name)) / 60);
    setStatus(quest.id, { state: "waiting", note: "Stream any window in a voice channel with someone else" });
    notify(quest, "attention", "Stream quest ready", `${nameOf(quest)}: stream any window in a voice channel with at least one other person for ${minutes} min`);

    try {
        await waitForHeartbeats(quest, task.name, task.target);
    } finally {
        restoreStream?.();
    }
}

async function doActivity(quest: any) {
    const task = taskOf(quest)!;
    const voice = Object.values(GuildChannelStore.getAllGuilds() as Record<string, any>).find(g => g?.VOCAL?.length)?.VOCAL[0]?.channel?.id;
    const channelId = (ChannelStore as any).getSortedPrivateChannels()[0]?.id ?? voice;
    if (!channelId) throw new Error("No channel for the activity");
    const streamKey = `call:${channelId}:1`;

    while (alive) {
        const res = await request(() => RestAPI.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: streamKey, terminal: false } }));
        const done = res?.body?.progress?.PLAY_ACTIVITY?.value ?? 0;
        setStatus(quest.id, { done });
        if (done >= task.target) {
            await request(() => RestAPI.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: streamKey, terminal: true } }));
            return;
        }
        await sleep(rand(ACTIVITY_STEP));
    }
}

// ---------------------------------------------------------------- Window

const STATE_TEXT: Record<State, string> = {
    queued: "Waiting",
    running: "Running",
    waiting: "Needs you",
    done: "Completed",
    claimed: "Claimed",
    claimable: "Claimable",
    failed: "Failed",
    available: "Not accepted",
    unsupported: "Skipped"
};

const TASK_TEXT: Record<TaskName, string> = {
    WATCH_VIDEO: "Video",
    WATCH_VIDEO_ON_MOBILE: "Video",
    PLAY_ON_DESKTOP: "Game",
    STREAM_ON_DESKTOP: "Stream",
    PLAY_ACTIVITY: "Activity"
};

const KIND_PATH: Record<Lane, string> = {
    video: "M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14Z",
    game: "M6 7h12a5 5 0 0 1 4.8 6.4l-1 3.4a2.5 2.5 0 0 1-4.3.9L15.6 15H8.4l-1.9 2.7a2.5 2.5 0 0 1-4.3-.9l-1-3.4A5 5 0 0 1 6 7Zm1 3v1.5H5.5v1.5H7v1.5h1.5V13H10v-1.5H8.5V10H7Zm9.5 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm-2 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z",
    stream: "M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6v2h3a1 1 0 1 1 0 2H7a1 1 0 1 1 0-2h3v-2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm6 4v6l5-3-5-3Z",
    activity: "M12 2c3 2 5 5.5 5 9.5 0 1-.1 2-.4 3l2.4 2.5v3l-3.5-1.5-.5 1h-6l-.5-1L5 20v-3l2.4-2.5c-.3-1-.4-2-.4-3C7 7.5 9 4 12 2Zm0 6.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"
};
const CHECK_PATH = "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z";
const REFRESH_PATH = "M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35Z";
const GIFT_PATH = "M20 7h-2.2A3 3 0 0 0 12 3.8 3 3 0 0 0 6.2 7H4a2 2 0 0 0-2 2v2a1 1 0 0 0 1 1h8V7h2v5h8a1 1 0 0 0 1-1V9a2 2 0 0 0-2-2ZM9 7a1 1 0 1 1 1-1v1H9Zm6 0h-1V6a1 1 0 1 1 1 1ZM4 14v5a2 2 0 0 0 2 2h5v-7H4Zm9 7h5a2 2 0 0 0 2-2v-5h-7v7Z";

const QUEST_PATH = "M7.5 2h9A1.5 1.5 0 0 1 18 3.5V5h2.5A1.5 1.5 0 0 1 22 6.5V8a5 5 0 0 1-4.6 5 6 6 0 0 1-4.4 3.9V19h3a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1h3v-2.1A6 6 0 0 1 6.6 13 5 5 0 0 1 2 8V6.5A1.5 1.5 0 0 1 3.5 5H6V3.5A1.5 1.5 0 0 1 7.5 2ZM6 7H4v1a3 3 0 0 0 2.1 2.9A6 6 0 0 1 6 10V7Zm12 0v3l-.1.9A3 3 0 0 0 20 8V7h-2Z";

function Icon({ path, size = 16 }: { path: string; size?: number; }) {
    return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden><path fill="currentColor" d={path} /></svg>;
}

/** Discord's own Orbs icon (OrbsIcon in Discord's icon set) */
const ORB_SPARK = "M11.75 7.57a5.12 5.12 0 0 1-3.86 3.87.42.42 0 0 0 0 .82 5.1 5.1 0 0 1 3.86 3.86.42.42 0 0 0 .81 0 5.12 5.12 0 0 1 3.87-3.86.42.42 0 0 0 0-.82 5.15 5.15 0 0 1-3.87-3.86.42.42 0 0 0-.81-.01Z";
const ORB_FRAME = "M11.64.22c.3-.12.62-.12.91 0l7.49 3.1c.29.12.52.35.64.64l3.1 7.49c.12.29.12.62 0 .9l-3.1 7.5c-.12.28-.35.51-.64.63l-7.49 3.1c-.29.13-.62.13-.9 0l-7.5-3.1c-.28-.12-.52-.35-.64-.64l-3.1-7.48c-.12-.3-.12-.62 0-.91l3.1-7.49c.12-.29.36-.52.65-.64l7.48-3.1ZM20.6 11.5 12.5 3.4a.56.56 0 0 0-.8 0l-8.1 8.1a.56.56 0 0 0 0 .8l8.1 8.1c.22.22.57.22.8 0l8.1-8.1a.56.56 0 0 0 0-.8Zm-8.85-3.94a5.12 5.12 0 0 1-3.86 3.87.42.42 0 0 0 0 .82 5.1 5.1 0 0 1 3.86 3.86.42.42 0 0 0 .81 0 5.12 5.12 0 0 1 3.87-3.86.42.42 0 0 0 0-.82 5.15 5.15 0 0 1-3.87-3.86.42.42 0 0 0-.81-.01Z";

function OrbIcon({ size = 14 }: { size?: number; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden fill="none" className={cl("orb")}>
            <path d={ORB_SPARK} fill="currentColor" />
            <path d={ORB_FRAME} fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
        </svg>
    );
}

function useStatus() {
    const [, setTick] = useState(0);
    useEffect(() => {
        const l = () => setTick(t => t + 1);
        listeners.add(l);
        return () => void listeners.delete(l);
    }, []);
}

interface Row {
    id: string;
    name: string;
    lane?: Lane;
    task?: TaskName;
    done: number;
    target: number;
    state: State;
    note?: string;
    reward: Reward | null;
    tile?: string;
}

const ACTIVE: State[] = ["waiting", "claimable", "running", "queued", "available"];
const ORDER: State[] = [...ACTIVE, "done", "claimed", "failed", "unsupported"];

/** Every quest Discord shows you, with what the plugin is doing with it */
function useRows(): Row[] {
    useStatus();
    settings.use(["orbsOnly", "video", "game", "stream", "activity"]);
    // Discord's own map – it's replaced on every change. A new array each call would make React re-render forever.
    const questMap: Map<string, any> | undefined = useStateFromStores([QuestStore], () => QuestStore.quests);

    const rows: Row[] = [];
    for (const q of questMap?.values() ?? []) {
        const us = q.userStatus;
        if (expired(q) && !us?.completedAt) continue;
        const task = taskOf(q);
        const tracked = status.get(q.id);
        const ignored = ignoredBecause(q);

        let state: State;
        if (us?.claimedAt) state = "claimed";
        else if (tracked) state = tracked.state;
        else if (us?.completedAt) state = "claimable";
        else if (ignored) state = "unsupported";
        else state = us?.enrolledAt ? "queued" : "available";

        rows.push({
            id: q.id,
            name: nameOf(q),
            task: task?.name,
            lane: task ? LANE_OF[task.name] : undefined,
            target: task?.target ?? 0,
            done: us?.completedAt ? task?.target ?? 0 : Math.max(tracked?.done ?? 0, task ? progressOf(q, task.name) : 0),
            state,
            note: state === "unsupported" ? ignored ?? undefined : tracked?.note,
            reward: rewardOf(q),
            tile: tileOf(q)
        });
    }
    return rows.sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
}

const time = (s: number) => s >= 60 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : `0:${String(Math.floor(s)).padStart(2, "0")}`;

function Tile({ row }: { row: Row; }) {
    const [broken, setBroken] = useState(false);
    if (row.tile && !broken) return <img className={cl("tile")} src={row.tile} alt="" onError={() => setBroken(true)} />;
    return <div className={classes(cl("tile"), cl("tile-icon"))}><Icon path={KIND_PATH[row.lane ?? "game"]} size={18} /></div>;
}

function RewardChip({ reward }: { reward: Reward | null; }) {
    if (!reward) return null;
    return (
        <span className={classes(cl("reward"), !!reward.orbs && cl("reward-orbs"))} title={reward.name}>
            {reward.orbs ? <OrbIcon /> : <Icon path={GIFT_PATH} size={13} />}
            <span>{reward.orbs ? reward.orbs.toLocaleString() : reward.name}</span>
        </span>
    );
}

/** iOS style switch */
function Toggle({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label: string; }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            className={classes(cl("toggle"), checked && cl("toggle-on"))}
            onClick={e => { e.preventDefault(); e.stopPropagation(); onChange(!checked); }}
        >
            <span className={cl("toggle-knob")} />
        </button>
    );
}

/** iOS activity indicator */
function Spinner() {
    return (
        <span className={cl("spinner")} aria-hidden>
            {Array.from({ length: 8 }, (_, i) => <i key={i} style={{ transform: `rotate(${i * 45}deg)`, animationDelay: `${(i - 8) * 0.1}s` }} />)}
        </span>
    );
}

function QuestRow({ row }: { row: Row; }) {
    const pct = row.target ? Math.min(100, row.done / row.target * 100) : 0;
    const showProgress = !!row.target && !["unsupported", "available", "claimed", "done", "claimable"].includes(row.state);

    let side: ReactNode;
    switch (row.state) {
        case "running":
            side = <span className={cl("state")}><Spinner />{Math.round(pct)}%</span>;
            break;
        case "claimable":
            side = <button className={cl("pill")} onClick={openQuests}>Claim</button>;
            break;
        case "claimed":
        case "done":
            side = <span className={classes(cl("state"), cl("state-ok"))}><span className={cl("check")}><Icon path={CHECK_PATH} size={11} /></span>{STATE_TEXT[row.state]}</span>;
            break;
        case "waiting":
            side = <span className={classes(cl("state"), cl("state-warn"))}>Needs you</span>;
            break;
        case "failed":
            side = <span className={classes(cl("state"), cl("state-bad"))}>Failed</span>;
            break;
        case "queued":
            side = <span className={cl("state")}>Up next</span>;
            break;
        default:
            side = <span className={cl("state")}>{STATE_TEXT[row.state]}</span>;
    }

    return (
        <div className={classes(cl("item"), cl(`item-${row.state}`))}>
            <Tile row={row} />
            <div className={cl("item-main")}>
                <div className={cl("item-title")}>{row.name}</div>
                <div className={cl("item-sub")}>
                    <RewardChip reward={row.reward} />
                    {row.task && <span>{TASK_TEXT[row.task]}</span>}
                    {showProgress && <span>{time(Math.min(row.done, row.target))} of {time(row.target)}</span>}
                </div>
                {showProgress && <div className={cl("progress")}><div style={{ width: `${pct}%` }} /></div>}
                {row.note && <div className={cl("item-note")}>{row.note}</div>}
            </div>
            <div className={cl("item-side")}>{side}</div>
        </div>
    );
}

function Section({ title, children, footer }: { title?: string; children: ReactNode; footer?: string; }) {
    return (
        <section className={cl("section")}>
            {title && <h3 className={cl("section-title")}>{title}</h3>}
            <div className={cl("group")}>{children}</div>
            {footer && <p className={cl("section-footer")}>{footer}</p>}
        </section>
    );
}

function Stats({ rows }: { rows: Row[]; }) {
    const running = rows.filter(r => r.state === "running").length;
    const needsYou = rows.filter(r => r.state === "waiting" || r.state === "claimable").length;
    const orbs = rows.filter(r => ACTIVE.includes(r.state)).reduce((n, r) => n + (r.reward?.orbs ?? 0), 0);
    const claimedOrbs = rows.filter(r => r.state === "claimed").reduce((n, r) => n + (r.reward?.orbs ?? 0), 0);

    return (
        <div className={cl("stats")}>
            <div className={classes(cl("stat"), running > 0 && cl("stat-blue"))}>
                <span className={cl("stat-value")}>{running}</span>
                <span className={cl("stat-label")}>Running</span>
            </div>
            <div className={classes(cl("stat"), needsYou > 0 && cl("stat-orange"))}>
                <span className={cl("stat-value")}>{needsYou}</span>
                <span className={cl("stat-label")}>Need you</span>
            </div>
            <div className={classes(cl("stat"), cl("stat-purple"))} title={`${claimedOrbs.toLocaleString()} Orbs claimed so far`}>
                <span className={cl("stat-value")}><OrbIcon size={18} />{orbs.toLocaleString()}</span>
                <span className={cl("stat-label")}>Orbs to earn</span>
            </div>
        </div>
    );
}

const SETTING_GROUPS: { title: string; footer?: string; items: { key: keyof typeof settings.store; label: string; sub: string; icon: string; color: string; }[]; }[] = [
    {
        title: "Automation",
        items: [
            { key: "autoEnroll", label: "Accept new quests", sub: "As soon as Discord offers them", icon: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2Z", color: "blue" },
            { key: "autoClaim", label: "Claim rewards", sub: "A captcha means you claim it yourself", icon: GIFT_PATH, color: "green" },
            { key: "orbsOnly", label: "Only quests with Orbs", sub: "Leaves other rewards alone", icon: ORB_FRAME, color: "purple" }
        ]
    },
    {
        title: "Quest types",
        footer: "Game and stream quests only work in the desktop app. For stream quests you still stream any window in a call with someone else.",
        items: [
            { key: "video", label: "Video", sub: "Watched in the background", icon: KIND_PATH.video, color: "red" },
            { key: "game", label: "Game", sub: "Pretends the game is running", icon: KIND_PATH.game, color: "indigo" },
            { key: "stream", label: "Stream", sub: "Pretends you stream the game", icon: KIND_PATH.stream, color: "teal" },
            { key: "activity", label: "Activity", sub: "Sends the activity's heartbeats", icon: KIND_PATH.activity, color: "orange" }
        ]
    },
    {
        title: "Appearance",
        items: [
            { key: "notify", label: "Notifications", sub: "Popups at the top right", icon: "M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z", color: "red" },
            { key: "showTitleBarButton", label: "Title bar icon", sub: "The trophy next to the other icons", icon: QUEST_PATH, color: "yellow" }
        ]
    }
];

function SettingsTab() {
    const s = settings.use(SETTING_GROUPS.flatMap(g => g.items.map(i => i.key)) as any);
    return (
        <>
            {SETTING_GROUPS.map(g => (
                <Section key={g.title} title={g.title} footer={g.footer}>
                    {g.items.map(i => (
                        <div key={i.key} className={classes(cl("item"), cl("item-setting"))} onClick={() => (settings.store as any)[i.key] = !(s as any)[i.key]}>
                            <span className={classes(cl("glyph"), cl(`glyph-${i.color}`))}><Icon path={i.icon} size={16} /></span>
                            <div className={cl("item-main")}>
                                <div className={cl("item-title")}>{i.label}</div>
                                <div className={cl("item-sub")}><span>{i.sub}</span></div>
                            </div>
                            <Toggle label={i.label} checked={!!(s as any)[i.key]} onChange={v => (settings.store as any)[i.key] = v} />
                        </div>
                    ))}
                </Section>
            ))}
        </>
    );
}

type Tab = "active" | "done" | "settings";

/** Rows of one tab, split into iOS style sections */
function QuestSections({ rows, tab }: { rows: Row[]; tab: Tab; }) {
    const groups: [string, State[]][] = tab === "active"
        ? [["Needs you", ["waiting", "claimable"]], ["In progress", ["running"]], ["Up next", ["queued"]], ["Not accepted yet", ["available"]]]
        : [["Completed", ["done"]], ["Claimed", ["claimed"]], ["Failed", ["failed"]], ["Skipped", ["unsupported"]]];

    const shown = groups.map(([title, states]) => [title, rows.filter(r => states.includes(r.state))] as const).filter(([, list]) => list.length);
    if (!shown.length) {
        return (
            <div className={cl("empty")}>
                <span className={cl("empty-icon")}><Icon path={QUEST_PATH} size={28} /></span>
                <b>{tab === "active" ? "All caught up" : "Nothing here yet"}</b>
                <span>{tab === "active" ? "New quests are picked up automatically." : "Finished quests show up here."}</span>
            </div>
        );
    }
    return <>{shown.map(([title, list]) => <Section key={title} title={title}>{list.map(r => <QuestRow key={r.id} row={r} />)}</Section>)}</>;
}

function QuestWindow({ onClose }: { onClose(): void; }) {
    const rows = useRows();
    const { active } = settings.use(["active"]);
    const [tab, setTab] = useState<Tab>("active");
    const [spin, setSpin] = useState(false);

    const running = rows.filter(r => r.state === "running");
    const needsYou = rows.filter(r => r.state === "waiting" || r.state === "claimable").length;
    const subtitle = !active ? "Paused"
        : running.length ? `Working on ${running.map(r => r.name).join(", ")}`
            : needsYou ? `${needsYou} quest${needsYou === 1 ? "" : "s"} need${needsYou === 1 ? "s" : ""} you`
                : "Waiting for new quests";

    const tabs: { id: Tab; label: string; count?: number; }[] = [
        { id: "active", label: "Quests", count: rows.filter(r => ACTIVE.includes(r.state)).length },
        { id: "done", label: "Done", count: rows.filter(r => !ACTIVE.includes(r.state)).length },
        { id: "settings", label: "Settings" }
    ];
    const index = tabs.findIndex(t => t.id === tab);

    return (
        <div className={classes(cl("sheet"), !active && cl("sheet-paused"))}>
            <header className={cl("header")}>
                <span className={cl("app-icon")}><Icon path={QUEST_PATH} size={22} /></span>
                <div className={cl("header-text")}>
                    <h2 className={cl("title")}>AutoQuest</h2>
                    <span className={classes(cl("subtitle"), active && running.length > 0 && cl("subtitle-live"))}>{subtitle}</span>
                </div>
                <Tooltip text="Check for new quests">
                    {(tip: any) => (
                        <button
                            {...tip}
                            className={classes(cl("round-btn"), spin && cl("spin"))}
                            disabled={!alive}
                            onClick={() => {
                                setSpin(true);
                                setTimeout(() => setSpin(false), 700);
                                skip.clear();
                                claimTried.clear();
                                request(fetchQuests).then(() => check()).catch(() => { });
                            }}
                        >
                            <Icon path={REFRESH_PATH} size={16} />
                        </button>
                    )}
                </Tooltip>
                <Tooltip text={active ? "Pause AutoQuest" : "Turn AutoQuest on"}>
                    {({ onMouseEnter, onMouseLeave }: any) => (
                        <span onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
                            <Toggle label="AutoQuest on" checked={active} onChange={setActive} />
                        </span>
                    )}
                </Tooltip>
                <button className={classes(cl("round-btn"), cl("close"))} aria-label="Close" onClick={onClose}>
                    <Icon path="M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z" size={14} />
                </button>
            </header>

            <Stats rows={rows} />

            <div className={cl("segmented")} style={{ "--vc-aq-seg": index, "--vc-aq-segs": tabs.length } as any}>
                <span className={cl("segmented-thumb")} />
                {tabs.map(t => (
                    <button key={t.id} className={classes(cl("segment"), tab === t.id && cl("segment-on"))} onClick={() => setTab(t.id)}>
                        {t.label}
                        {!!t.count && <span className={cl("segment-count")}>{t.count}</span>}
                    </button>
                ))}
            </div>

            <div className={cl("scroll")}>
                {tab === "settings" ? <SettingsTab /> : <QuestSections rows={rows} tab={tab} />}
            </div>
        </div>
    );
}

/** Vencord types it as never */
const Root = ModalRoot as any;

export function openQuestWindow() {
    openModal(props => (
        <Root {...props} size={ModalSize.MEDIUM} className={cl("modal")}>
            <ErrorBoundary noop>
                <QuestWindow onClose={props.onClose} />
            </ErrorBoundary>
        </Root>
    ));
}

function SettingsButton() {
    return (
        <button className={cl("pill")} onClick={openQuestWindow}>
            Open AutoQuest
        </button>
    );
}

// ---------------------------------------------------------------- Title bar


function TitleBarButton() {
    const { showTitleBarButton } = settings.use(["showTitleBarButton"]);
    useStatus();
    if (!showTitleBarButton) return null;

    const list = [...status.values()];
    const needsYou = list.filter(s => s.state === "claimable" || s.state === "waiting").length;
    const running = list.filter(s => s.state === "running").length;
    const tooltip = needsYou ? `AutoQuest · ${needsYou} need${needsYou === 1 ? "s" : ""} you`
        : running ? `AutoQuest · ${running} running`
            : "AutoQuest";

    return (
        <div className={classes(cl("tb"), running > 0 && cl("tb-running"), needsYou > 0 && cl("tb-attention"))}>
            <HeaderBarIcon
                className={cl("tb-btn")}
                onClick={openQuestWindow}
                tooltip={tooltip}
                icon={() => (
                    <svg viewBox="0 0 24 24" width={20} height={20} className={cl("tb-icon")}>
                        <path fill="currentColor" d={QUEST_PATH} />
                    </svg>
                )}
            />
        </div>
    );
}

export function renderTitleBarButton() {
    return (
        <ErrorBoundary key="vc-autoquest-titlebar" noop>
            <TitleBarButton />
        </ErrorBoundary>
    );
}

// ---------------------------------------------------------------- Plugin

/** Plugin is on in Vencord – the master switch only works then */
let enabled = false;

/** Master switch – the setting's own onChange only runs from Vencord's settings page */
function setActive(on: boolean) {
    settings.store.active = on;
    if (on) begin();
    else halt();
}

/** Starts working (plugin on + master switch on) */
function begin(delay = 1500) {
    if (alive || !enabled) return;
    alive = true;
    // Discord loads the quests on its own – after a restart the first look waits until it's done with startup
    setTimeout(() => {
        if (!alive) return;
        if (!QuestStore.quests?.size) request(fetchQuests).catch(() => { });
        else check();
    }, delay);
    timer = setInterval(() => request(fetchQuests).catch(() => { }), CHECK_EVERY);
    changed();
}

/** Stops everything that runs and puts back the faked game / stream */
function halt() {
    alive = false;
    clearInterval(timer);
    stopWaiters.forEach(f => f());
    stopWaiters.clear();
    restoreGames?.();
    restoreStream?.();
    for (const k of Object.keys(busy)) delete busy[k as Lane];
    status.clear();
    enrolling.clear();
    changed();
}

export default definePlugin({
    name: "AutoQuest",
    description: "Accepts Discord quests, completes them in the background and claims the reward",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    settings,

    patches: [
        {
            // Left side of the title bar, next to the other plugin icons
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(leading:.{0,2500}?)\]\}\),title:/,
                replace: "$1,$self.renderTitleBarButton()]}),title:"
            }
        }
    ],

    renderTitleBarButton,

    toolboxActions: {
        "Open AutoQuest": () => openQuestWindow()
    },

    flux: {
        QUESTS_FETCH_CURRENT_QUESTS_SUCCESS() {
            // Give Discord a moment – and don't react to our own refresh right away
            setTimeout(check, rand([5000, 15000]));
        }
    },

    start() {
        enabled = true;
        if (settings.store.active) begin(15_000);
    },

    stop() {
        enabled = false;
        halt();
        unmountToasts();
    }
});
