/*
 * RamSaver – Vencord Userplugin
 * Keeps Discord's RAM, CPU and GPU usage low.
 *
 * Ideas/techniques collected from: vencord-perf (voidfill), performanceModeToggle (bluscream),
 * OpenAsar / OpenAsar-PerfTweak (Chromium switches), RAM-Limiter (EmptyWorkingSet).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { disableStyle, enableStyle } from "@api/Styles";
import { getUserSettingLazy } from "@api/UserSettings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative, PluginSettingBooleanDef, PluginSettingNumberDef } from "@utils/types";
import { findStoreLazy } from "@webpack";
import { FluxDispatcher, MessageCache, SelectedChannelStore, showToast, Toasts } from "@webpack/common";

import animationsStyle from "./animations.css?managed";
import blurStyle from "./blur.css?managed";
import effectsStyle from "./effects.css?managed";
import { BoolKey, Config, CONFIG_KEYS, ConfigKey, PRESETS, Profile, resolveConfig } from "./profiles";
import { emitChange, startPolling, state, stopPolling } from "./store";
import { renderTitleBarButton, SettingsPanel } from "./ui";

const Native = VencordNative.pluginHelpers.RamSaver as PluginNative<typeof import("./native")>;
const logger = new Logger("RamSaver");

const AccessibilityStore = findStoreLazy("AccessibilityStore") as { rawPrefersReducedMotion: string; };

let running = false;
let trimTimer: ReturnType<typeof setInterval> | undefined;
let trimTimerInterval = 0;
let hiddenTimer: ReturnType<typeof setTimeout> | undefined;

// ---------------------------------------------------------------- Settings

// The individual options are not shown by Vencord but grouped in our own SettingsPanel (ui.tsx).
type ConfigDefs = {
    [K in ConfigKey]: Config[K] extends number ? PluginSettingNumberDef : PluginSettingBooleanDef;
};

const configDefs = Object.fromEntries(CONFIG_KEYS.map(key => [key, {
    type: typeof PRESETS.balanced[key] === "number" ? OptionType.NUMBER : OptionType.BOOLEAN,
    description: key,
    default: PRESETS.balanced[key],
    hidden: true,
    onChange: () => scheduleApply()
}])) as unknown as ConfigDefs;

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    profile: {
        type: OptionType.STRING,
        description: "Profile (balanced / max / custom)",
        default: "balanced" as Profile,
        hidden: true,
        onChange: () => scheduleApply()
    },
    showTitleBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show the RamSaver icon in the title bar",
        default: true,
        hidden: true
    },
    showTrimToast: {
        type: OptionType.BOOLEAN,
        description: "Show how much RAM was freed after cleaning up",
        default: true,
        hidden: true
    },
    /** Original values of Discord settings that RamSaver is currently overriding (JSON) */
    savedDiscordSettings: {
        type: OptionType.STRING,
        description: "internal",
        default: "{}",
        hidden: true
    },
    ...configDefs
});

/** Currently effective configuration (profile values or manual values) */
export function getConfig(): Config {
    const s = settings.store as any;
    const stored: Record<string, any> = { profile: s.profile };
    for (const key of CONFIG_KEYS) stored[key] = s[key];
    return resolveConfig(stored);
}

export function setProfile(profile: Profile) {
    if (profile === "custom" && settings.store.profile !== "custom") {
        // When switching to "Manual", start with the values of the previous profile
        copyIntoStore(getConfig());
    }
    settings.store.profile = profile;
}

/** Change a single option. If a profile is active, it automatically switches to "Manual". */
export function setOption<K extends ConfigKey>(key: K, value: Config[K]) {
    if (settings.store.profile !== "custom") {
        copyIntoStore(getConfig());
        settings.store.profile = "custom";
    }
    (settings.store as any)[key] = value;
}

function copyIntoStore(config: Config) {
    for (const key of CONFIG_KEYS) (settings.store as any)[key] = config[key];
}

// ---------------------------------------------------------------- Applying

let applyQueued = false;
function scheduleApply() {
    if (applyQueued) return;
    applyQueued = true;
    queueMicrotask(() => {
        applyQueued = false;
        applyRuntime();
    });
}

function applyRuntime() {
    if (!running) return;
    const c = getConfig();

    c.disableAnimations ? enableStyle(animationsStyle) : disableStyle(animationsStyle);
    c.disableBlur ? enableStyle(blurStyle) : disableStyle(blurStyle);
    c.hideProfileEffects ? enableStyle(effectsStyle) : disableStyle(effectsStyle);

    for (const group of DISCORD_OVERRIDES) {
        setOverride(group, c[group.key]);
    }

    updateThrottling();
    restartTrimTimer(c);
}

// ---------------------------------------------------------------- Overriding Discord settings

interface Override {
    key: BoolKey;
    /** Read current values */
    read(): Record<string, any>;
    /** RamSaver values */
    wanted: Record<string, any>;
    write(values: Record<string, any>): void;
}

function userSettingsOverride(key: BoolKey, wanted: Record<string, any>): Override {
    const handles = Object.fromEntries(
        Object.keys(wanted).map(name => [name, getUserSettingLazy<any>("textAndImages", name)!])
    );
    return {
        key,
        wanted,
        read: () => Object.fromEntries(Object.entries(handles).map(([n, h]) => [n, h.getSetting()])),
        write: values => {
            for (const [name, value] of Object.entries(values)) {
                const h = handles[name];
                if (h.getSetting() !== value) h.updateSetting(value);
            }
        }
    };
}

const DISCORD_OVERRIDES: Override[] = [
    {
        // Discord's own "Reduce motion" setting: turns off the JS animations that CSS can't reach
        key: "reducedMotion",
        wanted: { prefersReducedMotion: "reduce" },
        read: () => ({ prefersReducedMotion: AccessibilityStore.rawPrefersReducedMotion }),
        write: ({ prefersReducedMotion }) => {
            if (AccessibilityStore.rawPrefersReducedMotion === prefersReducedMotion) return;
            FluxDispatcher.dispatch({ type: "ACCESSIBILITY_SET_PREFERS_REDUCED_MOTION", prefersReducedMotion });
        }
    },
    userSettingsOverride("disableAnimatedMedia", {
        animateEmoji: false,
        animateStickers: 2, // 2 = never animate
        gifAutoPlay: false
    }),
    userSettingsOverride("disableEmbeds", {
        renderEmbeds: false,
        inlineEmbedMedia: false
    })
];

function readSaved(): Record<string, Record<string, any>> {
    try {
        return JSON.parse(settings.store.savedDiscordSettings || "{}");
    } catch {
        return {};
    }
}

function setOverride(o: Override, on: boolean) {
    const saved = readSaved();
    try {
        if (on) {
            if (!saved[o.key]) {
                saved[o.key] = o.read();
                settings.store.savedDiscordSettings = JSON.stringify(saved);
            }
            o.write(o.wanted);
        } else if (saved[o.key]) {
            o.write(saved[o.key]);
            delete saved[o.key];
            settings.store.savedDiscordSettings = JSON.stringify(saved);
        }
    } catch (e) {
        logger.error(`Could not set Discord setting "${o.key}"`, e);
    }
}

// ---------------------------------------------------------------- Background throttling (with voice protection)

let throttled: boolean | null = null;

const inVoice = () => !!SelectedChannelStore.getVoiceChannelId();

function updateThrottling() {
    // Never throttle during a voice call - otherwise speaking indicators, stream previews etc. can freeze
    const want = running && getConfig().backgroundThrottling && !inVoice();
    if (want === throttled) return;
    throttled = want;
    Native.setBackgroundThrottling(want);
}

// ---------------------------------------------------------------- Clean up RAM

function trimMessageCache() {
    const keep = new Set([SelectedChannelStore.getChannelId(), SelectedChannelStore.getVoiceChannelId()]);
    let cleared = 0;

    for (const channelId of Object.keys(MessageCache._channelMessages ?? {})) {
        if (keep.has(channelId)) continue;
        MessageCache.clearCache(channelId);
        cleared++;
    }

    return cleared;
}

export async function trim(reason: "manual" | "timer" | "hidden" = "manual") {
    if (state.trimming) return;
    state.trimming = true;
    emitChange();

    const manual = reason === "manual";
    const c = getConfig();

    try {
        let channels = 0;
        if (c.trimMessageCache) {
            try {
                channels = trimMessageCache();
            } catch (e) {
                logger.error("Could not clear message cache", e);
            }
        }

        // Only return physical RAM when Discord is minimized and no call is running
        const workingSet = c.trimWorkingSet && reason === "hidden" && document.hidden && !inVoice();

        const { before, after } = await Native.trimMemory({ clearHttpCache: c.clearHttpCache, workingSet });
        const freed = Math.max(0, before - after);
        state.lastTrim = { time: Date.now(), before, after, channels };
        logger.info(`Cleaned up (${reason}): ${before.toFixed(0)} MB -> ${after.toFixed(0)} MB, ${channels} channels discarded`);

        if (manual || (settings.store.showTrimToast && !document.hidden)) {
            showToast(`RamSaver: ${freed.toFixed(0)} MB freed (now ${after.toFixed(0)} MB)`, Toasts.Type.SUCCESS);
        }
    } catch (e) {
        logger.error("Cleanup failed", e);
        if (manual) showToast("RamSaver: Cleanup failed", Toasts.Type.FAILURE);
    } finally {
        state.trimming = false;
        emitChange();
    }
}

function restartTrimTimer(c = getConfig()) {
    const interval = running && c.autoTrim ? c.trimInterval * 60_000 : 0;
    if (interval === trimTimerInterval) return;

    clearInterval(trimTimer);
    trimTimer = undefined;
    trimTimerInterval = interval;
    if (interval) trimTimer = setInterval(() => trim("timer"), interval);
}

function onVisibilityChange() {
    clearTimeout(hiddenTimer);
    if (document.hidden && getConfig().trimWhenHidden) {
        hiddenTimer = setTimeout(() => document.hidden && trim("hidden"), 60_000);
    }
}

// ---------------------------------------------------------------- Plugin

/** Whether the code patches are active in this session (only evaluated at startup) */
export let codeTweaksActive = false;

const plugin = definePlugin({
    name: "RamSaver",
    description: "Keeps Discord's RAM, CPU and GPU usage low - with profiles (Balanced / Maximum / Manual)",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Utility"],
    dependencies: ["UserSettingsAPI"],
    settings,

    patches: [
        {
            // Title bar on the left (next to back/forward & inbox): append the button at the end.
            // Order of plugin icons = plugin load order (alphabetical by folder).
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(leading:.{0,600}?)\]\}\),title:/,
                replace: "$1,$self.renderTitleBarButton()]}),title:"
            }
        },
        {
            // NowPlayingStore copies two complete objects of all playing users ({...a, ...}) on EVERY
            // presence update (a user's status/game). In large servers that means thousands of copies per minute ->
            // lots of garbage for the garbage collector. Mutate directly instead. (after vencord-perf)
            find: '="NowPlayingStore"',
            predicate: () => codeTweaksActive = getConfig().codeTweaks,
            replacement: [
                {
                    match: /(\i)=\{\.\.\.\1,\[(\i)\]:\{\.\.\.\1\[\2\],\[(\i)\.userId\]:\3\}\},(\i)=\{\.\.\.\4,\[\3\.userId\]:(\{.+?\})\}/,
                    replace: "($1[$2]??={})[$3.userId]=$3,$4[$3.userId]=$5"
                },
                {
                    match: /(?<=[,(])(\i)=\{\.\.\.\1\},(?=delete )/g,
                    replace: ""
                }
            ]
        },
        {
            // Tooltips render synchronously via flushSync on every hover (blocks the main thread).
            // A normal setState is enough. (after vencord-perf)
            find: "this.state.shouldShowTooltip!==",
            predicate: () => getConfig().codeTweaks,
            replacement: {
                match: /this\.state\.shouldShowTooltip!==(\i)&&\((.+?),\i\.flushSync\(\(\)=>\{(this\.setState\(\{shouldShowTooltip:\1\}\))\}\)\)/,
                replace: "(this.__vcRamSaverOpen??this.state.shouldShowTooltip)!==$1&&($2,this.__vcRamSaverOpen=$1,$3)"
            }
        }
    ],

    renderTitleBarButton,

    toolboxActions: {
        "Clean up RAM now": () => trim("manual")
    },

    flux: {
        VOICE_CHANNEL_SELECT: () => { setTimeout(updateThrottling); },
        RTC_CONNECTION_STATE: () => updateThrottling()
    },

    start() {
        running = true;
        throttled = null;
        applyRuntime();

        document.addEventListener("visibilitychange", onVisibilityChange);
        startPolling();
    },

    stop() {
        running = false;

        disableStyle(animationsStyle);
        disableStyle(blurStyle);
        disableStyle(effectsStyle);

        for (const group of DISCORD_OVERRIDES) setOverride(group, false);

        updateThrottling();
        restartTrimTimer();

        document.removeEventListener("visibilitychange", onVisibilityChange);
        clearTimeout(hiddenTimer);
        stopPolling();
    }
});

export default plugin;
