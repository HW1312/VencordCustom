/*
 * OpSec – Vencord Userplugin
 * Privacy & security on Discord: type invisibly, hide activity, strip metadata from uploads,
 * clean tracking links, detect IP loggers & phishing (incl. online blocklist of known scam domains),
 * image editor for redacting/cropping before upload, streaming protection (blur DMs, hide servers,
 * mute notifications), capture protection, privacy curtain (panic key)
 * and a security check for account and privacy settings.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative, PluginSettingBooleanDef } from "@utils/types";
import { CloudUpload } from "@vencord/discord-types";
import { FluxDispatcher, showToast } from "@webpack/common";

import { setBlocklistEnabled } from "./blocklist";
import { configureCurtain, CurtainAnimation, CurtainIconName, CurtainOptions, CurtainStyle, hideCurtain, showCurtain, toggleCurtain } from "./curtain";
import { askEdit, editImage, isEditableImage } from "./editor";
import { DEFAULT_KEYBIND, formatKeybind, matchesKeybind, parseKeybind, recording } from "./keybind";
import { analyzeUrl, BLOCKLIST_ATTR, buildDangerCss, cleanText, cleanUrl, isBlocklisted, isOfficialHost, LinkAnalysis } from "./links";
import { isMediaFile, randomFilename, stripMetadata } from "./metadata";
import { Config, CONFIG_KEYS, ConfigKey, PRESETS, Profile, resolveConfig } from "./profiles";
import { configureGuard, evaluateStream, onOwnStreamStart, refreshGuard, stopGuard } from "./stream";
import { renderTitleBarButton, SettingsPanel, showLinkWarning } from "./ui";

const Native = VencordNative.pluginHelpers.OpSec as PluginNative<typeof import("./native")>;
const logger = new Logger("OpSec");

let running = false;

// ---------------------------------------------------------------- Settings

const configDefs = Object.fromEntries(CONFIG_KEYS.map(key => [key, {
    type: OptionType.BOOLEAN,
    description: key,
    default: PRESETS.standard[key],
    hidden: true,
    onChange: () => scheduleApply()
}])) as unknown as Record<ConfigKey, PluginSettingBooleanDef>;

export const settings = definePluginSettings({
    panel: {
        type: OptionType.COMPONENT,
        component: () => <SettingsPanel />
    },
    profile: {
        type: OptionType.STRING,
        description: "Profile (standard / paranoid / custom)",
        default: "standard" as Profile,
        hidden: true,
        onChange: () => scheduleApply()
    },
    showTitleBarButton: {
        type: OptionType.BOOLEAN,
        description: "Show OpSec icon in the title bar",
        default: true,
        hidden: true
    },
    showUploadToast: {
        type: OptionType.BOOLEAN,
        description: "Show which metadata was removed from uploads",
        default: true,
        hidden: true
    },
    // Details (independent of the profile)
    warnShorteners: {
        type: OptionType.BOOLEAN,
        description: "Also warn about short links",
        default: true,
        hidden: true
    },
    highlightIpLoggers: {
        type: OptionType.BOOLEAN,
        description: "Mark IP loggers red in chat",
        default: true,
        hidden: true,
        onChange: () => scheduleApply()
    },
    anonymizeAllFiles: {
        type: OptionType.BOOLEAN,
        description: "Also anonymize documents",
        default: false,
        hidden: true
    },
    panicKey: {
        type: OptionType.STRING,
        description: "Panic key",
        default: DEFAULT_KEYBIND,
        hidden: true
    },
    /** Image editor: "ask" = ask first, "always" = always open directly */
    uploadEditorMode: { type: OptionType.STRING, description: "Image editor", default: "ask" as UploadEditorMode, hidden: true },
    // Streaming protection
    guardNotifications: { type: OptionType.BOOLEAN, description: "Mute notifications", default: true, hidden: true, onChange: () => scheduleApply() },
    guardBlurDms: { type: OptionType.BOOLEAN, description: "Blur DMs", default: true, hidden: true, onChange: () => scheduleApply() },
    guardRevealOnHover: { type: OptionType.BOOLEAN, description: "Reveal on hover", default: false, hidden: true, onChange: () => scheduleApply() },
    guardStreamerMode: { type: OptionType.BOOLEAN, description: "Streamer Mode", default: false, hidden: true, onChange: () => scheduleApply() },
    /** Server IDs, comma-separated */
    guardHiddenGuilds: { type: OptionType.STRING, description: "Hidden servers", default: "", hidden: true, onChange: () => scheduleApply() },
    /** Channel IDs, comma-separated */
    guardHiddenChannels: { type: OptionType.STRING, description: "Hidden channels", default: "", hidden: true, onChange: () => scheduleApply() },
    // Curtain appearance
    curtainStyle: { type: OptionType.STRING, description: "Style", default: "mask" as CurtainStyle, hidden: true },
    curtainAnimation: { type: OptionType.STRING, description: "Animation", default: "zoom" as CurtainAnimation, hidden: true },
    curtainOpacity: { type: OptionType.NUMBER, description: "Opacity", default: 94, hidden: true },
    curtainBlur: { type: OptionType.NUMBER, description: "Blur", default: 24, hidden: true },
    curtainAccent: { type: OptionType.STRING, description: "Accent color", default: "#3ddc97", hidden: true },
    curtainShowIcon: { type: OptionType.BOOLEAN, description: "Show icon", default: true, hidden: true },
    curtainIcon: { type: OptionType.STRING, description: "Icon", default: "eyeOff" as CurtainIconName, hidden: true },
    curtainIconCustom: { type: OptionType.STRING, description: "Custom icon (emoji or image link)", default: "", hidden: true },
    curtainShowText: { type: OptionType.BOOLEAN, description: "Show text", default: true, hidden: true },
    curtainText: { type: OptionType.STRING, description: "Text", default: "", hidden: true },
    curtainClickUnlock: { type: OptionType.BOOLEAN, description: "Click to unlock", default: true, hidden: true },
    /** Last opened tab in the popout */
    lastTab: { type: OptionType.STRING, description: "internal", default: "overview", hidden: true },
    /** Original values of Discord settings that OpSec is currently overriding (JSON) */
    savedDiscordSettings: {
        type: OptionType.STRING,
        description: "internal",
        default: "{}",
        hidden: true
    },
    ...configDefs
});

export const getPanicKey = () => parseKeybind(settings.store.panicKey);

export type UploadEditorMode = "ask" | "always";

// ---------------------------------------------------------------- ID lists (streaming protection)

type IdListKey = "guardHiddenGuilds" | "guardHiddenChannels";

export const getIdList = (key: IdListKey) => (settings.store[key] || "").split(",").filter(Boolean);

export function toggleId(key: IdListKey, id: string, on: boolean) {
    setIds(key, [id], on);
}

export function setIds(key: IdListKey, idsToSet: string[], on: boolean) {
    const ids = new Set(getIdList(key));
    for (const id of idsToSet) {
        if (on) ids.add(id);
        else ids.delete(id);
    }
    settings.store[key] = [...ids].join(",");
}

configureGuard(() => {
    const s = settings.store;
    return {
        enabled: running && getConfig().screenshareGuard,
        notifications: s.guardNotifications,
        blurDms: s.guardBlurDms,
        revealOnHover: s.guardRevealOnHover,
        streamerMode: s.guardStreamerMode,
        hiddenGuilds: getIdList("guardHiddenGuilds"),
        hiddenChannels: getIdList("guardHiddenChannels")
    };
});

export function getCurtainOptions(): CurtainOptions {
    const s = settings.store;
    return {
        style: s.curtainStyle as CurtainStyle,
        animation: s.curtainAnimation as CurtainAnimation,
        opacity: s.curtainOpacity,
        blur: s.curtainBlur,
        accent: s.curtainAccent,
        showIcon: s.curtainShowIcon,
        icon: s.curtainIcon as CurtainIconName,
        iconCustom: s.curtainIconCustom,
        showText: s.curtainShowText,
        text: s.curtainText,
        // Without a panic key a click must always unlock – otherwise you lock yourself out
        clickToUnlock: s.curtainClickUnlock || !getConfig().panicHotkey,
        hotkeyLabel: getConfig().panicHotkey ? formatKeybind(getPanicKey()) : "the panic key"
    };
}

configureCurtain(getCurtainOptions);

export function getConfig(): Config {
    const s = settings.store as any;
    const stored: Record<string, any> = { profile: s.profile };
    for (const key of CONFIG_KEYS) stored[key] = s[key];
    return resolveConfig(stored);
}

export function setProfile(profile: Profile) {
    if (profile === "custom" && settings.store.profile !== "custom") copyIntoStore(getConfig());
    settings.store.profile = profile;
}

/** Change a single option. If a profile is active, this automatically switches to "Manual". */
export function setOption(key: ConfigKey, value: boolean) {
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

let contentProtectionActive: boolean | null = null;

function applyRuntime() {
    if (!running) return;
    const c = getConfig();

    for (const o of DISCORD_OVERRIDES) setOverride(o, c[o.key]);

    setDangerCss(c.dangerousLinkWarning && settings.store.highlightIpLoggers, c.scamBlocklist);
    setLinkMarking(c.scamBlocklist);
    setBlocklistEnabled(c.scamBlocklist, () => markLinks(document)).catch(e => logger.error("Failed to toggle blocklist", e));
    setContentProtection(c.contentProtection);
    if (!c.curtainOnBlur) hideCurtain(true);
    refreshGuard();
}

function setContentProtection(on: boolean) {
    if (on === contentProtectionActive) return;
    contentProtectionActive = on;
    Native.setContentProtection(on).catch(e => logger.error("Failed to set capture protection", e));
}

// ---------------------------------------------------------------- Overriding Discord settings

interface Override {
    key: ConfigKey;
    group: string;
    name: string;
    wanted: any;
}

const DISCORD_OVERRIDES: Override[] = [
    { key: "hideActivity", group: "status", name: "showCurrentGame", wanted: false },
    { key: "invisibleStatus", group: "status", name: "status", wanted: "invisible" }
];

const handles = new Map<Override, ReturnType<typeof getUserSettingLazy>>(
    DISCORD_OVERRIDES.map(o => [o, getUserSettingLazy(o.group, o.name)])
);

function readSaved(): Record<string, any> {
    try {
        return JSON.parse(settings.store.savedDiscordSettings || "{}");
    } catch {
        return {};
    }
}

function setOverride(o: Override, on: boolean) {
    const handle = handles.get(o)!;
    const saved = readSaved();
    try {
        const current = handle.getSetting();
        if (on) {
            if (!(o.key in saved)) {
                saved[o.key] = current;
                settings.store.savedDiscordSettings = JSON.stringify(saved);
            }
            if (current !== o.wanted) handle.updateSetting(o.wanted);
        } else if (o.key in saved) {
            // Only restore if the value hasn't been changed manually in the meantime
            if (current === o.wanted && saved[o.key] !== undefined) handle.updateSetting(saved[o.key]);
            delete saved[o.key];
            settings.store.savedDiscordSettings = JSON.stringify(saved);
        }
    } catch (e) {
        logger.error(`Failed to set Discord setting "${o.group}.${o.name}"`, e);
    }
}

// ---------------------------------------------------------------- Uploads

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
    Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), ms))]);

/*
 * Discord uploads attachments as soon as they're added to the message draft (CloudUpload.upload()),
 * not when the message is sent. Editing / metadata stripping therefore has to happen right before
 * that first upload – otherwise the original file is already on Discord's servers and gets sent.
 */
const prepared = new WeakSet<CloudUpload>();
const preparing = new WeakMap<CloudUpload, Promise<void>>();

/** Only one editor window at a time, even if several images are added at once */
let editorQueue: Promise<unknown> = Promise.resolve();

function queueEditor<T>(task: () => Promise<T>): Promise<T> {
    const run = editorQueue.then(task, task);
    editorQueue = run.catch(() => { });
    return run;
}

function setUploadFile(upload: CloudUpload, file: File) {
    upload.item.file = file;
    if (typeof upload.currentSize === "number") upload.currentSize = file.size;
    if (typeof upload.preCompressionSize === "number") upload.preCompressionSize = file.size;
}

/** Let the attachment preview in the chat bar re-render with the edited file */
function refreshDraft(upload: CloudUpload) {
    try {
        FluxDispatcher.dispatch({ type: "UPLOAD_ATTACHMENT_UPDATE_FILE", channelId: upload.channelId, id: upload.id, filename: upload.filename, draftType: (upload as any).draftType ?? 0 });
    } catch { }
}

async function editUpload(upload: CloudUpload) {
    const { file } = upload.item;
    const name = upload.filename ?? file.name;
    try {
        const edited = await queueEditor(async () => {
            if (settings.store.uploadEditorMode !== "always" && !await askEdit(name, 1)) return null;
            return editImage(file, name);
        });
        if (!edited) return false;
        setUploadFile(upload, edited);
        return true;
    } catch (e) {
        logger.error(`Failed to edit "${name}"`, e);
        showToast(`OpSec: Failed to edit "${name}" – sending unchanged`, "failure");
        return false;
    }
}

async function stripUpload(upload: CloudUpload, found: Set<string>) {
    const { file } = upload.item;
    const result = await withTimeout(stripMetadata(file, upload.filename ?? file.name), 15_000).catch(e => {
        logger.error(`Failed to strip metadata from "${file.name}"`, e);
        return null;
    });
    if (!result) return false;
    setUploadFile(upload, result.file);
    result.found.forEach(f => found.add(f));
    return true;
}

function toastFound(found: Set<string>, files: number) {
    if (!files || !settings.store.showUploadToast) return;
    const what = [...found].filter(f => f !== "Video metadata").slice(0, 3).join(", ") || "metadata";
    showToast(`OpSec: Removed ${what} from ${files === 1 ? "1 file" : `${files} files`}`, "success");
}

/** Edit (redact, crop …) first, then strip metadata */
async function prepareFile(upload: CloudUpload) {
    if (!(upload.item?.file instanceof File)) return;
    const c = getConfig();
    const edited = c.uploadEditor && isEditableImage(upload.item.file, upload.filename) ? await editUpload(upload) : false;

    if (c.stripMetadata) {
        const found = new Set<string>();
        if (await stripUpload(upload, found)) toastFound(found, 1);
    }
    if (edited) refreshDraft(upload);
}

/**
 * Hooked into the start of CloudUpload.upload().
 * Returns true if this call should be skipped because the same upload is already being prepared
 * (Discord calls upload() again on send) – the first call then performs the actual upload.
 */
async function prepareUpload(upload: CloudUpload): Promise<boolean> {
    if (!running || !upload || upload.status === "COMPLETED" || prepared.has(upload)) return false;

    const pending = preparing.get(upload);
    if (pending) {
        await pending;
        return true;
    }

    const task = prepareFile(upload).catch(e => logger.error("Failed to prepare upload", e));
    preparing.set(upload, task);
    await task;
    prepared.add(upload);
    preparing.delete(upload);
    return false;
}

// ---------------------------------------------------------------- Link clicks

function openExternal(url: string) {
    VencordNative.native.openExternal(url);
}

function onLinkClick(e: MouseEvent) {
    if (!running || (e.type === "auxclick" && e.button !== 1)) return;

    const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor || anchor.closest(".vc-opsec-no-intercept")) return;

    const { href } = anchor;
    if (!/^https?:\/\//i.test(href)) return;

    let host: string;
    try {
        host = new URL(href).hostname;
    } catch {
        return;
    }

    const c = getConfig();
    let analysis: LinkAnalysis = c.dangerousLinkWarning || c.scamBlocklist ? analyzeUrl(href) : { risk: "none", host };
    // Only the blocklist is active: don't apply the other heuristics
    if (!c.dangerousLinkWarning && analysis.kind !== "blocklist") analysis = { risk: "none", host };
    if (analysis.kind === "shortener" && !settings.store.warnShorteners) analysis = { risk: "none", host };
    const cleaned = c.cleanClickedLinks ? cleanUrl(href) : href;
    const confirm = analysis.risk !== "none" || (c.confirmExternalLinks && !isOfficialHost(host));

    if (!confirm && cleaned === href) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    if (confirm) showLinkWarning(cleaned, analysis, () => openExternal(cleaned));
    else openExternal(cleaned);
}

let dangerStyle: HTMLStyleElement | null = null;

function setDangerCss(ipLoggers: boolean, blocklisted: boolean) {
    const css = ipLoggers || blocklisted ? buildDangerCss({ ipLoggers, blocklisted }) : "";
    if (css && !dangerStyle) {
        dangerStyle = document.createElement("style");
        dangerStyle.id = "vc-opsec-danger-links";
        document.head.appendChild(dangerStyle);
    } else if (!css && dangerStyle) {
        dangerStyle.remove();
        dangerStyle = null;
    }
    if (dangerStyle && dangerStyle.textContent !== css) dangerStyle.textContent = css;
}

// Mark links to blocklisted domains (the list is too large for plain CSS selectors)

let linkObserver: MutationObserver | null = null;

function markLink(a: HTMLAnchorElement) {
    const { href } = a;
    if (!/^https?:\/\//i.test(href) || a.hasAttribute(BLOCKLIST_ATTR)) return;
    try {
        if (isBlocklisted(new URL(href).hostname)) a.setAttribute(BLOCKLIST_ATTR, "");
    } catch { }
}

function markLinks(root: ParentNode) {
    root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach(markLink);
}

function setLinkMarking(on: boolean) {
    if (on && !linkObserver) {
        linkObserver = new MutationObserver(records => {
            for (const r of records) {
                for (const node of r.addedNodes) {
                    if (!(node instanceof Element)) continue;
                    if (node instanceof HTMLAnchorElement) markLink(node);
                    else if (node.firstElementChild) markLinks(node);
                }
            }
        });
        linkObserver.observe(document.body, { childList: true, subtree: true });
        markLinks(document);
    } else if (!on && linkObserver) {
        linkObserver.disconnect();
        linkObserver = null;
        document.querySelectorAll(`[${BLOCKLIST_ATTR}]`).forEach(a => a.removeAttribute(BLOCKLIST_ATTR));
    }
}

// ---------------------------------------------------------------- Privacy curtain

function onKeyDown(e: KeyboardEvent) {
    if (!recording.active && getConfig().panicHotkey && matchesKeybind(e, getPanicKey())) {
        e.preventDefault();
        e.stopPropagation();
        toggleCurtain();
    }
}

let blurTimer: ReturnType<typeof setTimeout> | undefined;

function onWindowBlur() {
    clearTimeout(blurTimer);
    // Wait briefly: focus inside an embedded video (iframe) doesn't count as "gone"
    blurTimer = setTimeout(() => {
        if (getConfig().curtainOnBlur && !document.hasFocus()) showCurtain("auto");
    }, 150);
}

function onWindowFocus() {
    clearTimeout(blurTimer);
    hideCurtain(true);
}

// ---------------------------------------------------------------- Plugin

const plugin = definePlugin({
    name: "OpSec",
    description: "Privacy & security: type invisibly, strip metadata from uploads, redact images before upload, clean tracking links, IP logger/phishing warnings with a scam blocklist, streaming protection, capture protection, privacy curtain and security check",
    authors: [{ name: "5406", id: 1062070744558870548n }],
    tags: ["Privacy", "Utility"],
    dependencies: ["UserSettingsAPI", "MessageEventsAPI"],
    settings,

    patches: [
        {
            // Left side of the title bar (next to Back/Forward & Inbox): append the button at the end.
            // Order of plugin icons = plugin load order (alphabetical by folder).
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(leading:.{0,2500}?)\]\}\),title:/,
                replace: "$1,$self.renderTitleBarButton()]}),title:"
            }
        },
        {
            // Don't send "… is typing" to others
            find: '.dispatch({type:"TYPING_START_LOCAL"',
            replacement: {
                match: /startTyping\(\i\){/,
                replace: "$&if($self.shouldHideTyping())return;"
            }
        },
        {
            // Before the file is uploaded (Discord does this as soon as it's attached): image editor & metadata
            find: "CloudUpload.tryConvertToJpeg",
            replacement: {
                match: /async upload\(\){/,
                replace: "$&if(await $self.prepareUpload(this))return;"
            }
        },
        {
            // When sending: anonymize filenames (the name is part of the message payload)
            find: "async uploadFiles(",
            replacement: {
                match: /async uploadFiles\((\i)\){/,
                replace: "$&await $self.processUploads($1);"
            }
        }
    ],

    renderTitleBarButton,

    shouldHideTyping() {
        return running && getConfig().silentTyping;
    },

    prepareUpload,

    async processUploads(uploads: CloudUpload[]) {
        if (!running || !Array.isArray(uploads) || !uploads.length) return;
        const c = getConfig();

        if (c.anonymizeFilenames) {
            for (const upload of uploads) {
                const file = upload.item?.file;
                const name = upload.filename ?? file?.name;
                if (name && (settings.store.anonymizeAllFiles || isMediaFile(name, file?.type))) upload.filename = randomFilename(name);
            }
        }

        // Fallback in case the upload() hook didn't run: prepare now and upload again
        const missed = uploads.filter(u => !prepared.has(u) && !preparing.has(u) && (u.status === "NOT_STARTED" || u.status === "COMPLETED"));
        for (const upload of missed) {
            const wasUploaded = upload.status === "COMPLETED";
            const before = upload.item?.file;
            await prepareFile(upload).catch(e => logger.error("Failed to prepare upload", e));
            prepared.add(upload);
            if (wasUploaded && upload.item?.file !== before) upload.status = "NOT_STARTED";
        }
    },

    onBeforeMessageSend(_, msg) {
        if (running && getConfig().cleanSentLinks) msg.content = cleanText(msg.content);
    },

    onBeforeMessageEdit(_, __, msg) {
        if (running && getConfig().cleanSentLinks) msg.content = cleanText(msg.content);
    },

    flux: {
        // Like the stock plugin "StreamerModeOnStream"; STREAM_START only fires for your own stream
        STREAM_START() {
            if (running) onOwnStreamStart();
        },
        STREAM_CREATE() {
            if (running) evaluateStream();
        },
        STREAM_DELETE() {
            if (running) evaluateStream();
        },
        STREAM_STOP() {
            if (running) evaluateStream();
        }
    },

    toolboxActions: {
        "Toggle privacy curtain": () => toggleCurtain()
    },

    start() {
        running = true;
        contentProtectionActive = null;
        applyRuntime();

        document.addEventListener("click", onLinkClick, true);
        document.addEventListener("auxclick", onLinkClick, true);
        document.addEventListener("keydown", onKeyDown, true);
        window.addEventListener("blur", onWindowBlur);
        window.addEventListener("focus", onWindowFocus);
    },

    stop() {
        running = false;

        for (const o of DISCORD_OVERRIDES) setOverride(o, false);
        setDangerCss(false, false);
        setLinkMarking(false);
        setBlocklistEnabled(false);
        stopGuard();
        setContentProtection(false);
        hideCurtain();

        document.removeEventListener("click", onLinkClick, true);
        document.removeEventListener("auxclick", onLinkClick, true);
        document.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("blur", onWindowBlur);
        window.removeEventListener("focus", onWindowFocus);
        clearTimeout(blurTimer);
    }
});

export default plugin;
